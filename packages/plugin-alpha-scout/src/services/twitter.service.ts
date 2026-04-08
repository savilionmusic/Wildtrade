import { Scraper } from 'agent-twitter-client';

export interface KolTweetResult {
  userId: string;
  tweetId: string;
  tweetUrl: string;
  mints: string[];
  timestamp: number;
}

// Solana addresses are base58-encoded, typically 32-44 characters
const SOLANA_MINT_REGEX = /[1-9A-HJ-NP-Za-km-z]{43,44}/g;

function getKolUserIds(): string[] {
  const raw = process.env.TWITTER_KOL_USER_IDS ?? '';
  if (!raw) return [];
  // We need usernames/handles (without @)
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
}

function getOpenTwitterToken(): string {
  return process.env.TWITTER_TOKEN ?? process.env.OPENTWITTER_TOKEN ?? '';
}

function getOpenTwitterApiBase(): string {
  return process.env.TWITTER_API_BASE ?? 'https://ai.6551.io';
}

function getPollIntervalMs(): number {
  const raw = process.env.TWITTER_POLL_INTERVAL_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 120_000; // default 2 minutes
}

function extractMints(text: string): string[] {
  const matches = text.match(SOLANA_MINT_REGEX);
  if (!matches) return [];
  return [...new Set(matches)]; // Deduplicate
}

let scraper: Scraper | null = null;
let isLoggingIn = false;
let isLoggedIn = false;
let warnedMissingScraperCreds = false;
let warnedNoHandles = false;
let loggedBackend: 'none' | 'opentwitter' | 'scraper' = 'none';

async function getClient(): Promise<Scraper | null> {
  if (isLoggedIn && scraper) return scraper;
  if (isLoggingIn) return null; // Wait for next tick if already trying

  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const email = process.env.TWITTER_EMAIL;

  if (!username || !password) {
    if (!warnedMissingScraperCreds) {
      console.log('[alpha-scout] WARNING: TWITTER_USERNAME or TWITTER_PASSWORD not set. X/Twitter scraping disabled.');
      warnedMissingScraperCreds = true;
    }
    return null;
  }

  isLoggingIn = true;
  console.log(`[alpha-scout] Logging into X (Twitter) as @${username}...`);
  try {
    scraper = new Scraper();
    await scraper.login(username, password, email);
    isLoggedIn = await scraper.isLoggedIn();
    if (isLoggedIn) {
      console.log(`[alpha-scout] Successfully logged into X!`);
    } else {
      console.log(`[alpha-scout] Failed to confirm X login status.`);
    }
  } catch (err) {
    console.log(`[alpha-scout] X Login Error: ${String(err)}`);
  } finally {
    isLoggingIn = false;
  }

  return isLoggedIn ? scraper : null;
}

// Track the last seen tweet ID per user to avoid duplicates
const lastSeenTweetIds = new Map<string, string>();

export async function pollKolTimelines(): Promise<KolTweetResult[]> {
  const handles = getKolUserIds();
  if (handles.length === 0) {
    if (!warnedNoHandles) {
      console.log('[alpha-scout] No KOL handles configured in TWITTER_KOL_USER_IDS');
      warnedNoHandles = true;
    }
    return [];
  }
  warnedNoHandles = false;

  // Primary mode: OpenTwitter-compatible token API (same ecosystem as opentwitter-mcp)
  const openTwitterToken = getOpenTwitterToken();
  if (openTwitterToken) {
    if (loggedBackend !== 'opentwitter') {
      console.log('[alpha-scout] Using OpenTwitter token backend for KOL polling');
      loggedBackend = 'opentwitter';
    }
    return pollViaOpenTwitter(handles, openTwitterToken);
  }

  // Fallback: direct X scraper login
  const api = await getClient();
  if (!api) return [];
  if (loggedBackend !== 'scraper') {
    console.log('[alpha-scout] Using direct X scraper backend for KOL polling');
    loggedBackend = 'scraper';
  }

  return pollViaScraper(handles, api);
}

async function pollViaScraper(handles: string[], api: Scraper): Promise<KolTweetResult[]> {
  const results: KolTweetResult[] = [];

  for (const handle of handles) {
    try {
      // agent-twitter-client getTweets is an async generator
      const tweetGenerator = api.getTweets(handle, 10);
      const tweets: Array<{ id?: string; text?: string; timestamp?: number }> = [];
      for await (const tweet of tweetGenerator) {
        tweets.push(tweet);
        if (tweets.length >= 10) break;
      }

      if (!tweets || tweets.length === 0) continue;

      const lastSeenId = lastSeenTweetIds.get(handle);

      // agent-twitter-client returns tweets newest first
      if (tweets[0].id) {
        lastSeenTweetIds.set(handle, tweets[0].id);
      }

      for (const tweet of tweets) {
        if (!tweet.id || !tweet.text) continue;

        // Stop processing if we hit a tweet we've already seen
        if (lastSeenId && tweet.id === lastSeenId) break;

        const mints = extractMints(tweet.text);
        if (mints.length === 0) continue;

        const tweetUrl = `https://x.com/${handle}/status/${tweet.id}`;
        const timestamp = tweet.timestamp
          ? tweet.timestamp * 1000 // agent-twitter-client uses unix timestamps
          : Date.now();

        results.push({
          userId: handle,
          tweetId: tweet.id,
          tweetUrl,
          mints,
          timestamp,
        });
      }
    } catch (err) {
      console.log(`[alpha-scout] X poll error for @${handle}: ${String(err)}`);
    }
  }

  if (results.length > 0) {
    console.log(`[alpha-scout] X poll: found ${results.length} tweets with mint addresses`);
  }
  return results;
}

async function pollViaOpenTwitter(handles: string[], token: string): Promise<KolTweetResult[]> {
  const results: KolTweetResult[] = [];
  const baseUrl = getOpenTwitterApiBase().replace(/\/$/, '');

  for (const handle of handles) {
    try {
      const res = await fetch(`${baseUrl}/open/twitter_user_tweets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          username: handle,
          maxResults: 20,
          product: 'Latest',
          includeReplies: false,
          includeRetweets: false,
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.log('[alpha-scout] OpenTwitter token rejected (401/403). Check TWITTER_TOKEN.');
        } else if (res.status === 429) {
          console.log(`[alpha-scout] OpenTwitter rate limited for @${handle}.`);
        }
        continue;
      }

      const payload = await res.json() as {
        data?: Array<{
          id?: string | number;
          text?: string;
          fullText?: string;
          content?: string;
          createdAt?: string;
          created_at?: string;
          url?: string;
        }>;
      };

      const tweets = payload.data ?? [];
      if (tweets.length === 0) continue;

      const lastSeenId = lastSeenTweetIds.get(handle);
      const newestId = tweets[0]?.id != null ? String(tweets[0].id) : '';
      if (newestId) lastSeenTweetIds.set(handle, newestId);

      for (const tweet of tweets) {
        const tweetId = tweet.id != null ? String(tweet.id) : '';
        const text = tweet.text ?? tweet.fullText ?? tweet.content ?? '';
        if (!tweetId || !text) continue;

        if (lastSeenId && tweetId === lastSeenId) break;

        const mints = extractMints(text);
        if (mints.length === 0) continue;

        const tweetUrl = tweet.url || `https://x.com/${handle}/status/${tweetId}`;
        const timestampRaw = tweet.createdAt ?? tweet.created_at;
        const timestamp = timestampRaw ? new Date(timestampRaw).getTime() : Date.now();

        results.push({
          userId: handle,
          tweetId,
          tweetUrl,
          mints,
          timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        });
      }
    } catch (err) {
      console.log(`[alpha-scout] OpenTwitter poll error for @${handle}: ${String(err)}`);
    }

    // Small spacing between calls to be friendly with free-tier limits
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  if (results.length > 0) {
    console.log(`[alpha-scout] OpenTwitter poll: found ${results.length} tweets with mint addresses`);
  }

  return results;
}

export function getTwitterPollIntervalMs(): number {
  return getPollIntervalMs();
}
