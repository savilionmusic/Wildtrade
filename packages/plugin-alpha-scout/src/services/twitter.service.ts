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
  // For agent-twitter-client, we need usernames (handles) rather than numerical IDs
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
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

async function getClient(): Promise<Scraper | null> {
  if (isLoggedIn && scraper) return scraper;
  if (isLoggingIn) return null; // Wait for next tick if already trying

  const username = process.env.TWITTER_USERNAME;
  const password = process.env.TWITTER_PASSWORD;
  const email = process.env.TWITTER_EMAIL;

  if (!username || !password) {
    console.log('[alpha-scout] WARNING: TWITTER_USERNAME or TWITTER_PASSWORD not set. X/Twitter scraping disabled.');
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
  const api = await getClient();
  if (!api) return [];

  const handles = getKolUserIds();
  if (handles.length === 0) {
    console.log('[alpha-scout] No KOL handles configured in TWITTER_KOL_USER_IDS');
    return [];
  }

  const results: KolTweetResult[] = [];

  for (const handle of handles) {
    try {
      // Get the latest tweets for the user
      // agent-twitter-client getTweets is an async generator
      const tweetGenerator = api.getTweets(handle, 10);
      const tweets = [];
      for await (const tweet of tweetGenerator) {
        tweets.push(tweet);
        if (tweets.length >= 10) break;
      }

      if (!tweets || tweets.length === 0) continue;
      
      const lastSeenId = lastSeenTweetIds.get(handle);
      
      // agent-twitter-client returns tweets newest first
      // Update last seen immediately to the newest tweet
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

export function getTwitterPollIntervalMs(): number {
  return getPollIntervalMs();
}
