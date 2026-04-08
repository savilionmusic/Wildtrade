export interface RedditPostResult {
  subreddit: string;
  postId: string;
  postUrl: string;
  title: string;
  text: string;
  mints: string[];
  timestamp: number;
}

const SOLANA_MINT_REGEX = /[1-9A-HJ-NP-Za-km-z]{43,44}/g;

function getTargetSubreddits(): string[] {
  const raw = process.env.REDDIT_SUBREDDITS ?? 'SolanaCoins,memecoins,CryptoMoonShots';
  return raw.split(',').map((id) => id.trim()).filter(Boolean);
}

function getPollIntervalMs(): number {
  const raw = process.env.REDDIT_POLL_INTERVAL_MS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return 180_000; // default 3 minutes to avoid free-tier rate limits
}

function extractMints(text: string): string[] {
  const matches = text.match(SOLANA_MINT_REGEX);
  if (!matches) return [];
  return [...new Set(matches)]; // Deduplicate
}

const lastSeenPostIds = new Map<string, string>();

export async function pollRedditNew(): Promise<RedditPostResult[]> {
  const subreddits = getTargetSubreddits();
  if (subreddits.length === 0) return [];

  const results: RedditPostResult[] = [];

  for (const sub of subreddits) {
    try {
      // Standard Reddit JSON API for the "new" feed. 
      // We limit to 25 to capture fast-moving discussions.
      const url = `https://www.reddit.com/r/${sub}/new.json?limit=25`;
      const res = await fetch(url, {
        headers: {
          // Identify the bot nicely to avoid quick bans (Reddit's API guidelines)
          'User-Agent': 'nodejs:wildtrade.scraper:v1.0.0 (by /u/wildtrade)',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) {
        if (res.status === 429) {
          console.log(`[alpha-scout] Reddit rate limited on r/${sub}, backing off...`);
        }
        continue;
      }

      const data = await res.json() as any;
      const posts = data?.data?.children || [];
      if (posts.length === 0) continue;

      const lastSeenId = lastSeenPostIds.get(sub);
      
      // The newest post is first in the array. Record it.
      const newestId = posts[0]?.data?.name;
      if (newestId) {
        lastSeenPostIds.set(sub, newestId);
      }

      for (const post of posts) {
        const pd = post.data;
        if (!pd || !pd.name) continue;

        // Stop processing if we reach a post we've already parsed
        if (lastSeenId && pd.name === lastSeenId) break;

        const content = `${pd.title || ''} ${pd.selftext || ''}`;
        const mints = extractMints(content);
        if (mints.length === 0) continue;

        const postUrl = `https://reddit.com${pd.permalink}`;
        const timestamp = pd.created_utc ? pd.created_utc * 1000 : Date.now();

        results.push({
          subreddit: sub,
          postId: pd.name,
          postUrl,
          title: pd.title,
          text: pd.selftext,
          mints,
          timestamp,
        });
      }
    } catch (err) {
      console.log(`[alpha-scout] Reddit poll error for r/${sub}: ${String(err)}`);
    }
    
    // Tiny delay between subreddits to be polite to Reddit free API
    await new Promise(r => setTimeout(r, 1000));
  }

  if (results.length > 0) {
    console.log(`[alpha-scout] Reddit poll: found ${results.length} posts with mint addresses`);
  }
  return results;
}

export function getRedditPollIntervalMs(): number {
  return getPollIntervalMs();
}