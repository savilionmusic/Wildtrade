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
const DEFAULT_DISCOVERY_KEYWORDS = [
  'pump.fun solana',
  'solana ca',
  'solana gem',
  'raydium migration',
  'new solana pair',
];
const HANDLE_DISCOVERY_CACHE_MS = 10 * 60_000;

function getKolUserIds(): string[] {
  const raw = process.env.TWITTER_KOL_USER_IDS ?? '';
  if (!raw) return [];
  return dedupeHandles(raw.split(',').map((id) => normalizeHandle(id)).filter(Boolean));
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

function normalizeHandle(raw: string): string {
  const cleaned = raw.trim().replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
  if (!cleaned || cleaned.length > 15) return '';
  return cleaned;
}

function dedupeHandles(handles: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const handle of handles) {
    const key = handle.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(handle);
  }
  return out;
}

function getAutoDiscoveryEnabled(): boolean {
  const raw = (process.env.TWITTER_AUTO_KOL_DISCOVERY ?? 'true').toLowerCase();
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function getDiscoveryKeywords(): string[] {
  const raw = process.env.TWITTER_DISCOVERY_KEYWORDS ?? '';
  if (!raw) return DEFAULT_DISCOVERY_KEYWORDS;
  const parsed = raw.split(',').map((x) => x.trim()).filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_DISCOVERY_KEYWORDS;
}

function getMinFollowersForDiscovery(): number {
  const raw = process.env.TWITTER_MIN_FOLLOWERS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!isNaN(parsed) && parsed > 0) return parsed;
  return 8_000;
}

function getMaxDiscoveredHandles(): number {
  const raw = process.env.TWITTER_MAX_DISCOVERED_HANDLES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!isNaN(parsed) && parsed > 0) return Math.min(parsed, 60);
  return 20;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
  return null;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function extractHandleFromTweetRecord(item: Record<string, unknown>): string {
  const user = asObject(item.user);
  const candidates: unknown[] = [
    item.userScreenName,
    item.screenName,
    item.username,
    item.handle,
    user?.screenName,
    user?.username,
    user?.handle,
    user?.userName,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const normalized = normalizeHandle(candidate);
    if (normalized) return normalized;
  }

  return '';
}

let scraper: Scraper | null = null;
let isLoggingIn = false;
let isLoggedIn = false;
let warnedMissingScraperCreds = false;
let warnedNoHandles = false;
let loggedBackend: 'none' | 'opentwitter' | 'scraper' = 'none';
let cachedDiscoveredHandles: string[] = [];
let discoveredHandlesCachedAt = 0;

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
  const handles = await getHandlesForPolling();
  if (handles.length === 0) {
    if (!warnedNoHandles) {
      console.log('[alpha-scout] No KOL handles found. Set TWITTER_KOL_USER_IDS or configure TWITTER_TOKEN for auto discovery.');
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

async function getHandlesForPolling(): Promise<string[]> {
  const manual = getKolUserIds();
  if (manual.length > 0) return manual;

  const token = getOpenTwitterToken();
  if (!token) return [];

  const watch = await fetchWatchHandles(token);
  if (!getAutoDiscoveryEnabled()) {
    return watch.slice(0, getMaxDiscoveredHandles());
  }

  const discovered = await discoverHandlesViaSearch(token);
  const merged = dedupeHandles([...watch, ...discovered]);

  if (merged.length > 0) {
    console.log(`[alpha-scout] Auto-discovered ${merged.length} KOL handles for polling`);
  }

  return merged.slice(0, getMaxDiscoveredHandles());
}

async function fetchWatchHandles(token: string): Promise<string[]> {
  const baseUrl = getOpenTwitterApiBase().replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/open/twitter_watch`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) return [];

    const payload = await res.json() as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const handles = rows
      .map((row) => asObject(row))
      .filter((row): row is Record<string, unknown> => row !== null)
      .map((row) => extractHandleFromTweetRecord(row))
      .filter(Boolean);

    return dedupeHandles(handles);
  } catch {
    return [];
  }
}

async function discoverHandlesViaSearch(token: string): Promise<string[]> {
  const now = Date.now();
  if (now - discoveredHandlesCachedAt < HANDLE_DISCOVERY_CACHE_MS && cachedDiscoveredHandles.length > 0) {
    return cachedDiscoveredHandles;
  }

  const minFollowers = getMinFollowersForDiscovery();
  const maxHandles = getMaxDiscoveredHandles();
  const keywords = getDiscoveryKeywords();
  const baseUrl = getOpenTwitterApiBase().replace(/\/$/, '');
  const handleScores = new Map<string, number>();

  for (const keyword of keywords) {
    try {
      const res = await fetch(`${baseUrl}/open/twitter_search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          keywords: keyword,
          product: 'Latest',
          maxResults: 40,
          minLikes: 10,
          excludeReplies: true,
          excludeRetweets: true,
          lang: 'en',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.log('[alpha-scout] OpenTwitter token rejected (401/403) during discovery.');
        }
        continue;
      }

      const payload = await res.json() as { data?: unknown };
      const rows = Array.isArray(payload.data) ? payload.data : [];

      for (const row of rows) {
        const item = asObject(row);
        if (!item) continue;

        const handle = extractHandleFromTweetRecord(item);
        if (!handle) continue;

        const user = asObject(item.user);
        const followers =
          toNumber(item.userFollowers) ||
          toNumber(user?.followersCount) ||
          toNumber(user?.followers) ||
          toNumber(user?.userFollowers);
        if (followers < minFollowers) continue;

        const likes = toNumber(item.favoriteCount) || toNumber(item.likes) || toNumber(item.likeCount);
        const retweets = toNumber(item.retweetCount) || toNumber(item.retweets);
        const replies = toNumber(item.replyCount) || toNumber(item.replies);
        const views = toNumber(item.viewCount) || toNumber(item.views);

        const signalScore =
          Math.log10(Math.max(10, followers)) * 4 +
          likes * 0.02 +
          retweets * 0.08 +
          replies * 0.03 +
          Math.min(5, views / 20_000);

        handleScores.set(handle, (handleScores.get(handle) ?? 0) + signalScore);
      }
    } catch {
      // Skip failed keyword query; discovery is best-effort.
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const discovered = Array.from(handleScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxHandles)
    .map(([handle]) => handle);

  cachedDiscoveredHandles = dedupeHandles(discovered);
  discoveredHandlesCachedAt = now;
  return cachedDiscoveredHandles;
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
    console.log(`[social-scout] X poll: found ${results.length} tweets with mint addresses from ${handles.length} handles`);
  } else {
    // console.log(`[social-scout] Polled ${handles.length} KOL handles directly. Found 0 new tokens.`);
  }
  return results;
}

async function pollViaOpenTwitter(handles: string[], token: string): Promise<KolTweetResult[]> {
  const results: KolTweetResult[] = [];
  const baseUrl = getOpenTwitterApiBase().replace(/\/$/, '');

  console.log(`[social-scout] Tracking ${handles.length} active KOLs via OpenTwitter API...`);

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
    console.log(`[alpha-scout] OpenTwitter poll: found ${results.length} tweets with mint addresses from ${handles.length} handles`);
  }

  return results;
}

export function getTwitterPollIntervalMs(): number {
  return getPollIntervalMs();
}
