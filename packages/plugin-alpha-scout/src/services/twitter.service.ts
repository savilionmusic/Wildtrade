import { TwitterApi } from 'twitter-api-v2';

export interface KolTweetResult {
  userId: string;
  tweetId: string;
  tweetUrl: string;
  mints: string[];
  timestamp: number;
}

// Solana addresses are base58-encoded, typically 32-44 characters
// We target 43-44 character strings that look like Solana mint addresses
const SOLANA_MINT_REGEX = /[1-9A-HJ-NP-Za-km-z]{43,44}/g;

function getBearerToken(): string {
  const token = process.env.TWITTER_BEARER_TOKEN ?? '';
  if (!token) {
    console.log('[alpha-scout] WARNING: TWITTER_BEARER_TOKEN not set');
  }
  return token;
}

function getKolUserIds(): string[] {
  const raw = process.env.TWITTER_KOL_USER_IDS ?? '';
  if (!raw) return [];
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
  // Deduplicate
  return [...new Set(matches)];
}

let client: TwitterApi | null = null;

function getClient(): TwitterApi | null {
  if (client) return client;
  const token = getBearerToken();
  if (!token) return null;
  client = new TwitterApi(token);
  return client;
}

// Track the last seen tweet ID per user to avoid duplicates
const lastSeenTweetIds = new Map<string, string>();

export async function pollKolTimelines(): Promise<KolTweetResult[]> {
  const api = getClient();
  if (!api) return [];

  const userIds = getKolUserIds();
  if (userIds.length === 0) {
    console.log('[alpha-scout] No KOL user IDs configured');
    return [];
  }

  const results: KolTweetResult[] = [];

  for (const userId of userIds) {
    try {
      const sinceId = lastSeenTweetIds.get(userId);
      const params: Record<string, unknown> = {
        max_results: 10,
        'tweet.fields': 'created_at',
      };
      if (sinceId) {
        (params as Record<string, string>).since_id = sinceId;
      }

      const timeline = await api.v2.userTimeline(userId, params as Parameters<typeof api.v2.userTimeline>[1]);

      const tweets = timeline.data?.data;
      if (!tweets || tweets.length === 0) continue;

      // Update last seen
      lastSeenTweetIds.set(userId, tweets[0].id);

      for (const tweet of tweets) {
        const mints = extractMints(tweet.text);
        if (mints.length === 0) continue;

        const tweetUrl = `https://twitter.com/i/status/${tweet.id}`;
        const timestamp = tweet.created_at
          ? new Date(tweet.created_at).getTime()
          : Date.now();

        results.push({
          userId,
          tweetId: tweet.id,
          tweetUrl,
          mints,
          timestamp,
        });
      }
    } catch (err) {
      console.log(`[alpha-scout] Twitter poll error for user ${userId}: ${String(err)}`);
    }
  }

  console.log(`[alpha-scout] Twitter poll: found ${results.length} tweets with mint addresses`);
  return results;
}

export function getTwitterPollIntervalMs(): number {
  return getPollIntervalMs();
}
