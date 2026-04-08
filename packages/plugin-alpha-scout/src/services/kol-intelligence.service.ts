import { pollKolTimelines, getTwitterPollIntervalMs } from './twitter.service.js';
import { pollRedditNew, getRedditPollIntervalMs } from './reddit.service.js';

/**
 * KOL Intelligence Service — Monitors crypto Twitter/X and Reddit for alpha signals.
 *
 * Uses free DexScreener social data, agent-twitter-client for X, and free Reddit JSON.
 *
 * Signals extracted:
 *   - Token mentions ($TICKER, contract addresses)
 *   - Community takeovers (CTOs) from DexScreener
 *   - Social engagement spikes on new tokens
 *
 * All free, no paid APIs. Rate-limited to stay within free tier limits.
 */

// ── Types ──

export interface KolSignal {
  tokenMint: string;
  tokenSymbol: string;
  source: 'dexscreener_social' | 'dexscreener_cto' | 'dexscreener_ads' | 'twitter_kol' | 'reddit_alpha';
  confidence: 'low' | 'medium' | 'high';
  context: string;         // human-readable why this was flagged
  kolName?: string;        // which KOL mentioned it (if twitter)
  timestamp: number;
}

// ── State ──
const recentKolSignals: KolSignal[] = [];
const MAX_SIGNALS = 100;
const seenTokens = new Set<string>();
let kolTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

type KolLogCb = (msg: string) => void;
let log: KolLogCb = (msg) => console.log(`[kol-intel] ${msg}`);

// ── Public API ──

export function startKolIntelligence(onLog?: KolLogCb): void {
  if (running) return;
  running = true;
  if (onLog) log = onLog;

  log('Starting KOL intelligence...');

  // Poll DexScreener social data every 3 min
  pollDexScreenerSocial();
  kolTimer = setInterval(pollDexScreenerSocial, 180_000);

  // Poll X/Twitter handles using free agent scraper
  pollTwitterKolFeeds();
  setInterval(pollTwitterKolFeeds, getTwitterPollIntervalMs());

  // Poll Reddit crypto communities using free API
  pollRedditFeeds();
  setInterval(pollRedditFeeds, getRedditPollIntervalMs());

  log('KOL intelligence active — monitoring DexScreener social, CTOs, ads, Reddit feeds, and X/Twitter KOLs.');
}

async function pollTwitterKolFeeds(): Promise<void> {
  if (!running) return;
  try {
    const tweets = await pollKolTimelines();
    for (const tw of tweets) {
      if (tw.mints.length === 0) continue;
      // For each mint found in a tweet
      for (const mint of tw.mints) {
        const sigId = `x:${tw.userId}:${tw.tweetId}:${mint}`;
        if (!seenTokens.has(sigId)) {
          seenTokens.add(sigId);
          const signal: KolSignal = {
            tokenMint: mint,
            tokenSymbol: '',
            source: 'twitter_kol',
            confidence: 'high',
            context: `X mention by @${tw.userId} via agent-scraper`,
            kolName: tw.userId,
            timestamp: tw.timestamp,
          };
          addSignal(signal);
        }
      }
    }
  } catch (err) {
    log(`X/Twitter error: ${String(err)}`);
  }
}

async function pollRedditFeeds(): Promise<void> {
  if (!running) return;
  try {
    const posts = await pollRedditNew();
    for (const pt of posts) {
      if (pt.mints.length === 0) continue;
      // For each mint found in a reddit post
      for (const mint of pt.mints) {
        const sigId = `reddit:${pt.subreddit}:${pt.postId}:${mint}`;
        if (!seenTokens.has(sigId)) {
          seenTokens.add(sigId);
          const signal: KolSignal = {
            tokenMint: mint,
            tokenSymbol: '',
            source: 'reddit_alpha',
            confidence: 'medium',
            context: `Reddit post in r/${pt.subreddit}`,
            timestamp: pt.timestamp,
          };
          addSignal(signal);
        }
      }
    }
  } catch (err) {
    log(`Reddit error: ${String(err)}`);
  }
}

export function stopKolIntelligence(): void {
  running = false;
  if (kolTimer) clearInterval(kolTimer);
  kolTimer = null;
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
    recentSignals: recentKolSignals.filter(s => s.timestamp > fiveMinAgo).length,
  };
}

// ── Token Mention Callback ──
type TokenMentionCallback = (signal: KolSignal) => void;
let onTokenMention: TokenMentionCallback | null = null;

export function setTokenMentionCallback(cb: TokenMentionCallback): void {
  onTokenMention = cb;
}

// ── DexScreener Social Monitoring ──

async function pollDexScreenerSocial(): Promise<void> {
  if (!running) return;

  // 1. Community Takeovers — strong social signal
  try {
    const ctoRes = await fetch('https://api.dexscreener.com/community-takeovers/latest/v1', {
      headers: { 'Accept': 'application/json' },
    });

    if (ctoRes.ok) {
      const ctos = await ctoRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        url?: string;
        claimDate?: number;
      }>;

      let found = 0;
      for (const cto of ctos) {
        if (cto.chainId === 'solana' && cto.tokenAddress && !seenTokens.has(`cto:${cto.tokenAddress}`)) {
          seenTokens.add(`cto:${cto.tokenAddress}`);
          const signal: KolSignal = {
            tokenMint: cto.tokenAddress,
            tokenSymbol: '',
            source: 'dexscreener_cto',
            confidence: 'medium',
            context: `Community takeover claimed on DexScreener`,
            timestamp: Date.now(),
          };
          addSignal(signal);
          found++;
        }
      }
      if (found > 0) log(`Found ${found} new community takeovers`);
    }
  } catch (err) {
    log(`CTO poll error: ${String(err)}`);
  }

  // Brief pause between calls
  await sleep(2000);

  // 2. Paid ads — people spending money to promote tokens
  try {
    const adsRes = await fetch('https://api.dexscreener.com/ads/latest/v1', {
      headers: { 'Accept': 'application/json' },
    });

    if (adsRes.ok) {
      const ads = await adsRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        type?: string;
      }>;

      let found = 0;
      for (const ad of ads) {
        if (ad.chainId === 'solana' && ad.tokenAddress && !seenTokens.has(`ad:${ad.tokenAddress}`)) {
          seenTokens.add(`ad:${ad.tokenAddress}`);
          const signal: KolSignal = {
            tokenMint: ad.tokenAddress,
            tokenSymbol: '',
            source: 'dexscreener_ads',
            confidence: 'low',
            context: `Paid ad on DexScreener (${ad.type || 'banner'})`,
            timestamp: Date.now(),
          };
          addSignal(signal);
          found++;
        }
      }
      if (found > 0) log(`Found ${found} new paid ads`);
    }
  } catch (err) {
    log(`Ads poll error: ${String(err)}`);
  }

  await sleep(2000);

  // 3. Token profiles with social links — tokens investing in their presence
  try {
    const profileRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { 'Accept': 'application/json' },
    });

    if (profileRes.ok) {
      const profiles = await profileRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
        links?: Array<{ type?: string; label?: string; url?: string }>;
      }>;

      let found = 0;
      for (const p of profiles) {
        if (p.chainId !== 'solana' || !p.tokenAddress) continue;
        if (seenTokens.has(`profile:${p.tokenAddress}`)) continue;

        // Only flag tokens with Twitter links (social presence = more legit)
        const hasTwitter = p.links?.some(l =>
          l.type === 'twitter' || l.url?.includes('twitter.com') || l.url?.includes('x.com'),
        );
        if (!hasTwitter) continue;

        seenTokens.add(`profile:${p.tokenAddress}`);
        const signal: KolSignal = {
          tokenMint: p.tokenAddress,
          tokenSymbol: '',
          source: 'dexscreener_social',
          confidence: 'low',
          context: 'New DexScreener profile with X/Twitter linked',
          timestamp: Date.now(),
        };
        addSignal(signal);
        found++;
      }
      if (found > 0) log(`Found ${found} new tokens with social profiles`);
    }
  } catch (err) {
    log(`Profile poll error: ${String(err)}`);
  }
}

function addSignal(signal: KolSignal): void {
  recentKolSignals.push(signal);
  if (recentKolSignals.length > MAX_SIGNALS) {
    recentKolSignals.shift();
  }
  log(`Token mention: ${signal.tokenMint.slice(0, 8)} from ${signal.source} (${signal.confidence})`);
  if (onTokenMention) {
    onTokenMention(signal);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
          context: `New token profile with Twitter: ${p.description?.slice(0, 80) || 'no description'}`,
          timestamp: Date.now(),
        };
        addSignal(signal);
        found++;
      }
      if (found > 0) log(`Found ${found} new tokens with social profiles`);
    }
  } catch (err) {
    log(`Profiles poll error: ${String(err)}`);
  }

  // Clean up old seen tokens (keep set manageable)
  if (seenTokens.size > 5000) {
    const arr = Array.from(seenTokens);
    for (let i = 0; i < 2000; i++) seenTokens.delete(arr[i]);
  }
}

function addSignal(signal: KolSignal): void {
  recentKolSignals.push(signal);
  if (recentKolSignals.length > MAX_SIGNALS) recentKolSignals.shift();

  // Notify callback
  if (onTokenMention) {
    try { onTokenMention(signal); } catch { /* ignore */ }
  }
}

// ── Twitter KOL Feed Integration ──
// Polls Twitter timelines of configured KOLs via the twitter service
// and generates high-confidence signals for any tokens they mention

async function pollTwitterKolFeeds(): Promise<void> {
  if (!running) return;

  try {
    // Dynamic import to avoid hard dependency
    const { pollKolTimelines } = await import('./twitter.service.js');
    const tweetResults = await pollKolTimelines();

    if (tweetResults.length === 0) return;

    for (const result of tweetResults) {
      for (const mint of result.mints) {
        const key = `twitter:${mint}:${result.tweetId}`;
        if (seenTokens.has(key)) continue;
        seenTokens.add(key);

        const signal: KolSignal = {
          tokenMint: mint,
          tokenSymbol: '',
          source: 'twitter_kol',
          confidence: 'high', // Twitter KOLs directly mentioning a token = high confidence
          context: `KOL tweet: ${result.tweetUrl}`,
          kolName: result.userId,
          timestamp: result.timestamp,
        };
        addSignal(signal);
        log(`TWITTER KOL SIGNAL: ${mint.slice(0, 8)}... from KOL ${result.userId} — ${result.tweetUrl}`);
      }
    }

    if (tweetResults.length > 0) {
      log(`Twitter KOL poll: ${tweetResults.length} tweets processed, ${tweetResults.reduce((s, r) => s + r.mints.length, 0)} mint addresses found`);
    }
  } catch (err) {
    // Twitter not configured or errored — that's fine, not required
    const msg = String(err);
    if (!msg.includes('TWITTER_BEARER_TOKEN') && !msg.includes('No KOL')) {
      log(`Twitter KOL poll error: ${msg}`);
    }
  }
}

// ── Free Social Sentiment API (no keys required) ──
// Poll Birdeye/DexScreener for trending social tokens

export async function pollSocialTrending(): Promise<KolSignal[]> {
  const results: KolSignal[] = [];

  try {
    // DexScreener orders/latest — tokens people are actively watching
    const ordersRes = await fetch('https://api.dexscreener.com/orders/v1/solana', {
      headers: { 'Accept': 'application/json' },
    });

    if (ordersRes.ok) {
      const orders = await ordersRes.json() as Array<{
        tokenAddress?: string;
        type?: string;
        status?: string;
      }>;

      let found = 0;
      for (const order of (orders || []).slice(0, 20)) {
        if (!order.tokenAddress) continue;
        const key = `orders:${order.tokenAddress}`;
        if (seenTokens.has(key)) continue;
        seenTokens.add(key);

        const signal: KolSignal = {
          tokenMint: order.tokenAddress,
          tokenSymbol: '',
          source: 'dexscreener_social',
          confidence: 'low',
          context: `Active DexScreener orders (${order.type || 'unknown'})`,
          timestamp: Date.now(),
        };
        addSignal(signal);
        results.push(signal);
        found++;
      }
      if (found > 0) log(`Social trending: ${found} active tokens from DexScreener orders`);
    }
  } catch (err) {
    log(`Social trending error: ${String(err)}`);
  }

  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
