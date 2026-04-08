import { pollKolTimelines, getTwitterPollIntervalMs } from './twitter.service.js';
import { pollRedditNew, getRedditPollIntervalMs } from './reddit.service.js';

export interface KolSignal {
  tokenMint: string;
  tokenSymbol: string;
  source: 'dexscreener_social' | 'dexscreener_cto' | 'dexscreener_ads' | 'twitter_kol' | 'reddit_alpha';
  confidence: 'low' | 'medium' | 'high';
  context: string;
  kolName?: string;
  timestamp: number;
}

type KolLogCb = (msg: string) => void;
type TokenMentionCallback = (signal: KolSignal) => void;

const recentKolSignals: KolSignal[] = [];
const seenTokens = new Set<string>();
const MAX_SIGNALS = 100;

let running = false;
let dexscreenerTimer: ReturnType<typeof setInterval> | null = null;
let twitterTimer: ReturnType<typeof setInterval> | null = null;
let redditTimer: ReturnType<typeof setInterval> | null = null;
let log: KolLogCb = (msg) => console.log(`[social-scout] ${msg}`);
let onTokenMention: TokenMentionCallback | null = null;

export function startKolIntelligence(onLog?: KolLogCb): void {
  if (running) return;
  running = true;
  if (onLog) log = onLog;

  log('Starting KOL intelligence...');

  void pollDexScreenerSocial();
  void pollTwitterKolFeeds();
  void pollRedditFeeds();

  dexscreenerTimer = setInterval(() => {
    void pollDexScreenerSocial();
  }, 180_000);

  twitterTimer = setInterval(() => {
    void pollTwitterKolFeeds();
  }, getTwitterPollIntervalMs());

  redditTimer = setInterval(() => {
    void pollRedditFeeds();
  }, getRedditPollIntervalMs());

  log('KOL intelligence active — monitoring DexScreener social, CTOs, ads, Reddit feeds, and X/Twitter KOLs.');
}

export function stopKolIntelligence(): void {
  running = false;
  if (dexscreenerTimer) clearInterval(dexscreenerTimer);
  if (twitterTimer) clearInterval(twitterTimer);
  if (redditTimer) clearInterval(redditTimer);
  dexscreenerTimer = null;
  twitterTimer = null;
  redditTimer = null;
  log('KOL intelligence stopped');
}

export function getKolSignals(): KolSignal[] {
  return recentKolSignals.slice(-30);
}

export function getKolStats(): {
  running: boolean;
  totalSignals: number;
  recentSignals: number;
} {
  const fiveMinAgo = Date.now() - 300_000;
  return {
    running,
    totalSignals: recentKolSignals.length,
    recentSignals: recentKolSignals.filter((signal) => signal.timestamp > fiveMinAgo).length,
  };
}

export function setTokenMentionCallback(cb: TokenMentionCallback): void {
  onTokenMention = cb;
}

async function pollDexScreenerSocial(): Promise<void> {
  if (!running) return;

  try {
    const ctoRes = await fetch('https://api.dexscreener.com/community-takeovers/latest/v1', {
      headers: { Accept: 'application/json' },
    });

    if (ctoRes.ok) {
      const ctos = await ctoRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
      }>;

      let found = 0;
      for (const cto of ctos) {
        if (cto.chainId !== 'solana' || !cto.tokenAddress) continue;
        const key = `cto:${cto.tokenAddress}`;
        if (seenTokens.has(key)) continue;

        seenTokens.add(key);
        addSignal({
          tokenMint: cto.tokenAddress,
          tokenSymbol: '',
          source: 'dexscreener_cto',
          confidence: 'medium',
          context: 'Community takeover claimed on DexScreener',
          timestamp: Date.now(),
        });
        found++;
      }

      if (found > 0) log(`Found ${found} new community takeovers`);
    }
  } catch (err) {
    log(`CTO poll error: ${String(err)}`);
  }

  await sleep(2_000);

  try {
    const adsRes = await fetch('https://api.dexscreener.com/ads/latest/v1', {
      headers: { Accept: 'application/json' },
    });

    if (adsRes.ok) {
      const ads = await adsRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        type?: string;
      }>;

      let found = 0;
      for (const ad of ads) {
        if (ad.chainId !== 'solana' || !ad.tokenAddress) continue;
        const key = `ad:${ad.tokenAddress}`;
        if (seenTokens.has(key)) continue;

        seenTokens.add(key);
        addSignal({
          tokenMint: ad.tokenAddress,
          tokenSymbol: '',
          source: 'dexscreener_ads',
          confidence: 'low',
          context: `Paid ad on DexScreener (${ad.type || 'banner'})`,
          timestamp: Date.now(),
        });
        found++;
      }

      if (found > 0) log(`Found ${found} new paid ads`);
    }
  } catch (err) {
    log(`Ads poll error: ${String(err)}`);
  }

  await sleep(2_000);

  try {
    const profileRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { Accept: 'application/json' },
    });

    if (profileRes.ok) {
      const profiles = await profileRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
        links?: Array<{ type?: string; url?: string }>;
      }>;

      let found = 0;
      for (const profile of profiles) {
        if (profile.chainId !== 'solana' || !profile.tokenAddress) continue;
        const key = `profile:${profile.tokenAddress}`;
        if (seenTokens.has(key)) continue;

        const hasTwitter = profile.links?.some((link) =>
          link.type === 'twitter' || link.url?.includes('twitter.com') || link.url?.includes('x.com'),
        );
        if (!hasTwitter) continue;

        seenTokens.add(key);
        addSignal({
          tokenMint: profile.tokenAddress,
          tokenSymbol: '',
          source: 'dexscreener_social',
          confidence: 'low',
          context: `New DexScreener profile with X/Twitter linked: ${profile.description?.slice(0, 80) || 'no description'}`,
          timestamp: Date.now(),
        });
        found++;
      }

      if (found > 0) log(`Found ${found} new tokens with social profiles`);
    }
  } catch (err) {
    log(`Profile poll error: ${String(err)}`);
  }

  if (seenTokens.size > 5_000) {
    const keys = Array.from(seenTokens);
    for (let i = 0; i < 2_000; i++) {
      seenTokens.delete(keys[i]);
    }
  }
}

async function pollTwitterKolFeeds(): Promise<void> {
  if (!running) return;

  try {
    const tweets = await pollKolTimelines();

    for (const tweet of tweets) {
      for (const mint of tweet.mints) {
        const key = `twitter:${tweet.userId}:${tweet.tweetId}:${mint}`;
        if (seenTokens.has(key)) continue;

        seenTokens.add(key);
        addSignal({
          tokenMint: mint,
          tokenSymbol: '',
          source: 'twitter_kol',
          confidence: 'high',
          context: `X mention by @${tweet.userId}: ${tweet.tweetUrl}`,
          kolName: tweet.userId,
          timestamp: tweet.timestamp,
        });
      }
    }

    if (tweets.length > 0) {
      log(`X poll: processed ${tweets.length} KOL post(s)`);
    }
  } catch (err) {
    log(`X/Twitter error: ${String(err)}`);
  }
}

async function pollRedditFeeds(): Promise<void> {
  if (!running) return;

  try {
    const posts = await pollRedditNew();

    for (const post of posts) {
      for (const mint of post.mints) {
        const key = `reddit:${post.subreddit}:${post.postId}:${mint}`;
        if (seenTokens.has(key)) continue;

        seenTokens.add(key);
        addSignal({
          tokenMint: mint,
          tokenSymbol: '',
          source: 'reddit_alpha',
          confidence: 'medium',
          context: `Reddit post in r/${post.subreddit}: ${post.postUrl}`,
          timestamp: post.timestamp,
        });
      }
    }

    if (posts.length > 0) {
      log(`Reddit poll: processed ${posts.length} post(s)`);
    }
  } catch (err) {
    log(`Reddit error: ${String(err)}`);
  }
}

function addSignal(signal: KolSignal): void {
  recentKolSignals.push(signal);
  if (recentKolSignals.length > MAX_SIGNALS) {
    recentKolSignals.shift();
  }

  log(`Token mention: ${signal.tokenMint.slice(0, 8)} from ${signal.source} (${signal.confidence})`);

  if (onTokenMention) {
    try {
      onTokenMention(signal);
    } catch {
      // Non-fatal callback errors should not stop ingestion.
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
