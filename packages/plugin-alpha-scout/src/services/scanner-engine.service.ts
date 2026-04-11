/**
 * Scanning Engine — Actively discovers tokens and feeds them through the pipeline.
 *
 * This is the "brain" that drives the Finder agent. Without this running,
 * the bot just sits idle. It:
 *   1. Connects to PumpPortal WebSocket for real-time new token launches
 *   2. Polls DexScreener for trending/hot tokens on Solana
 *   3. Feeds every discovered token through the scoring pipeline
 *   4. Forwards qualifying tokens to the Trader agent
 *
 * Rate-limit friendly: DexScreener polling every 2 min, token processing throttled.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getDb,
  FINDER_TO_TRADER_ROOM,
  SCORE_THRESHOLDS,
  SIGNAL_DEFAULT_TTL_MS,
} from '@wildtrade/shared';
import type {
  AlphaSignal,
  InterAgentMessage,
  SignalSource,
  CompositeScore,
} from '@wildtrade/shared';
import type { AgentRuntime } from '@elizaos/core';
import { calculateCompositeScore } from '../lib/score-calculator.js';
import { isInDenylist } from '../lib/denylist-guard.js';
import { connect as connectPumpPortal, disconnect as disconnectPumpPortal, onMigration as onPumpMigration } from './pumpportal.service.js';
import { getMentionVelocity } from './twitter.service.js';
import { getCachedNarrative, getTopNarratives } from './narrative-detector.service.js';
import type { PumpPortalToken } from './pumpportal.service.js';
import { getKolSignals } from './kol-intelligence.service.js';
import { isGoldKol } from './kol-scraper.service.js';
import { analyzeKolTweetQuality } from './kol-quality-grader.service.js';
import { screenTokenWithDeepSeek } from './deepseek-alpha-screener.service.js';
import { getRecentSmartBuys } from './smart-money-monitor.service.js';
import { getRecentWalletBuys } from './wallet-intelligence.service.js';
import { getTrackedWalletAddresses } from './smart-money-monitor.service.js';
import { triggerInstantSnipe } from '@wildtrade/plugin-smart-trader';
import { scanForSybilRings } from './sybil-ring-scanner.service.js';
import { startPumpSwapSniper, stopPumpSwapSniper, onPumpPortalMigration } from './pumpswap-sniper.service.js';
import type { MigrationSnipeEvent } from './pumpswap-sniper.service.js';
import {
  startPumpLaunchSniper,
  stopPumpLaunchSniper,
  onPumpLaunchToken,
} from './pump-launch-sniper.service.js';

// ── Config ──
const DEXSCREENER_POLL_MS = 120_000;   // 2 min — DexScreener has generous free limits
const TOKEN_PROCESS_DELAY_MS = 3_000;   // 3 sec between processing tokens (rate limit)
const MAX_QUEUE_SIZE = 50;              // Don't queue too many tokens
const RUGCHECK_API_BASE = process.env.RUGCHECK_API_BASE ?? 'https://api.rugcheck.xyz/v1';

// ── RugCheck Rate Limiter (serialize to max 1 req/2s) ──
const rugcheckCache = new Map<string, { score: number; passed: boolean; ts: number }>();
const RUGCHECK_CACHE_TTL = 300_000; // 5 min
let rugcheckBusy = false;
const rugcheckQueue: Array<{ mint: string; resolve: (v: { score: number; passed: boolean }) => void }> = [];

async function queuedRugcheck(mint: string): Promise<{ score: number; passed: boolean }> {
  const cached = rugcheckCache.get(mint);
  if (cached && Date.now() - cached.ts < RUGCHECK_CACHE_TTL) return cached;

  return new Promise(resolve => {
    rugcheckQueue.push({ mint, resolve });
    drainRugcheckQueue();
  });
}

async function drainRugcheckQueue(): Promise<void> {
  if (rugcheckBusy || rugcheckQueue.length === 0) return;
  rugcheckBusy = true;
  const item = rugcheckQueue.shift()!;
  try {
    const res = await fetch(`${RUGCHECK_API_BASE}/tokens/${item.mint}/report`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = await res.json() as { score?: number; risks?: Array<{ name: string; level: string }> };
      const score = data.score ?? 50;
      const risks = data.risks ?? [];
      const critical = risks.filter(r => r.level === 'critical');
      const honeypot = risks.some(r => r.name?.toLowerCase().includes('honeypot') || r.name?.toLowerCase().includes('mintable'));
      const passed = !honeypot && critical.length === 0 && score >= 30;
      const result = { score, passed, ts: Date.now() };
      rugcheckCache.set(item.mint, result);
      item.resolve(result);
    } else {
      item.resolve({ score: 50, passed: true }); // fail-open
    }
  } catch {
    item.resolve({ score: 50, passed: true }); // fail-open on timeout
  }
  // Wait 2s before next call to avoid 429
  setTimeout(() => {
    rugcheckBusy = false;
    drainRugcheckQueue();
  }, 2000);
}

// ── State ──
let finderRuntime: AgentRuntime | null = null;
let scannerRunning = false;
let dexScreenerTimer: ReturnType<typeof setInterval> | null = null;
let processTimer: ReturnType<typeof setTimeout> | null = null;

// Token processing queue
const tokenQueue: Array<{
  mint: string;
  symbol: string;
  name: string;
  source: SignalSource;
  creator?: string;
  isMigration?: boolean;
}> = [];

// Track recently processed tokens to avoid duplicates
const recentlyProcessed = new Set<string>();
let processedCount = 0;
let signalCount = 0;
let forwardedCount = 0;

// ── Logging callback for the main process ──
type LogCallback = (level: string, message: string) => void;
let logCb: LogCallback = (level, msg) => console.log(`[scanner] ${msg}`);

// ── Public API ──

export function startScanner(
  runtime: AgentRuntime,
  onLog?: LogCallback,
): void {
  if (scannerRunning) return;
  scannerRunning = true;
  finderRuntime = runtime;
  if (onLog) logCb = onLog;

  logCb('info', 'Starting token scanner...');

  // -- PUMP.FUN HOSE DRIED UP --
  // startPumpLaunchSniper(...)
  // connectPumpPortal(...)
  // onPumpMigration(...)
  // startPumpSwapSniper(...)

  // -- DEXSCREENER POLLER DISABLED --
  // logCb('info', 'Starting DexScreener trending scanner...');
  // pollDexScreenerTrending();
  // dexScreenerTimer = setInterval(pollDexScreenerTrending, DEXSCREENER_POLL_MS);

  // 3. Start token processing loop ONLY (for KOLs and manual triggers)
  logCb('info', 'Starting processing queue for KOL signals...');
  processNextToken();

  logCb('info', 'Scanner fully active — processing targeted signals only');
}

export function stopScanner(): void {
  scannerRunning = false;
  disconnectPumpPortal();
  stopPumpLaunchSniper();
  stopPumpSwapSniper();
  if (dexScreenerTimer) clearInterval(dexScreenerTimer);
  if (processTimer) clearTimeout(processTimer);
  dexScreenerTimer = null;
  processTimer = null;
  finderRuntime = null;
  logCb('info', 'Scanner stopped');
}

export function getScannerStats(): {
  running: boolean;
  queueSize: number;
  processed: number;
  signals: number;
  forwarded: number;
} {
  return {
    running: scannerRunning,
    queueSize: tokenQueue.length,
    processed: processedCount,
    signals: signalCount,
    forwarded: forwardedCount,
  };
}

// ── Queue Management ──

export function enqueueToken(
  mint: string,
  symbol: string,
  name: string,
  source: SignalSource,
  creator?: string,
): void {
  const isHighVelocity = getMentionVelocity(mint) >= 3 || source === 'smart_money' || source === 'convergence';

  // Skip if recently processed (within last 30 min) unless high velocity or high tier source
  if (!isHighVelocity && recentlyProcessed.has(mint)) return;

  // Skip if already in queue unless high velocity
  if (!isHighVelocity && tokenQueue.find(t => t.mint === mint)) return;

  // Trim queue if too large
  if (tokenQueue.length >= MAX_QUEUE_SIZE) {
    tokenQueue.shift();
  }

  tokenQueue.push({ mint, symbol, name, source, creator });
}

// ── DexScreener Polling ──

async function pollDexScreenerTrending(): Promise<void> {
  try {
    // DexScreener latest token profiles (new tokens getting traction)
    let profilesRes: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        profilesRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(10_000),
        });
        if (profilesRes.ok) break;
        profilesRes = null;
      } catch {
        if (attempt === 0) await new Promise(r => setTimeout(r, 3_000));
      }
    }

    if (profilesRes && profilesRes.ok) {
      const profiles = await profilesRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        baseToken?: { address?: string; symbol?: string; name?: string };
      }>;
      const solanaTokens = profiles.filter(p => (p.chainId === 'solana' || !p.chainId) && p.tokenAddress && p.tokenAddress.length > 30);
      for (const t of solanaTokens) {
        if (!recentlyProcessed.has(t.tokenAddress!)) {
          enqueueToken(t.tokenAddress!, t.baseToken?.symbol || t.tokenAddress!.slice(0, 8), t.baseToken?.name || '', 'dexscreener');
        }
      }
      logCb('info', `[social-scout] Polled DexScreener Latest (New/Trending): added ${solanaTokens.length} tokens to queue`);
    }

    // DexScreener token boosts (PAID trending list - very high signal)
    const boostsRes = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (boostsRes.ok) {
      const boosts = await boostsRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        baseToken?: { symbol?: string; name?: string };
        amount?: number;
      }>;
      const solanaBoosts = boosts.filter(b => b.chainId === 'solana' && b.tokenAddress);
      for (const b of solanaBoosts) {
        // High priority - enqueue even if we've seen it before, if it's getting boosted right now
        // And bypass the normal size check by pushing to the FRONT of the queue
        if (!tokenQueue.find(t => t.mint === b.tokenAddress!)) {
          tokenQueue.push({
            mint: b.tokenAddress!,
            symbol: b.baseToken?.symbol || b.tokenAddress!.slice(0, 8),
            name: b.baseToken?.name || '',
            source: 'dexscreener',
          });
        }
      }
      if (solanaBoosts.length > 0) {
        logCb('info', `[social-scout] Polled DexScreener HOT Boosts: found ${solanaBoosts.length} highly-boosted Solana tokens. Fast-tracking to queue.`);
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      logCb('error', `DexScreener timeout`);
    } else {
      logCb('error', `DexScreener API error: ${String(err)}`);
    }
  }
}

// ── Token Processing Pipeline ──

async function processNextToken(): Promise<void> {
  if (!scannerRunning) return;

  const batchSize = Math.min(tokenQueue.length, 100);
  if (batchSize === 0) {
    // Nothing to process, check again in 5 seconds
    processTimer = setTimeout(processNextToken, 5_000);
    return;
  }

  const batch = tokenQueue.splice(0, batchSize);
  const prefetchedHolders = new Map<string, { count: number, topPct: number }>();

  try {
    const _rawRpc1 = process.env.SOLANA_RPC_CONSTANTK || process.env.SOLANA_RPC_HELIUS || process.env.SOLANA_RPC_QUICKNODE || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
    let SOLANA_RPC = _rawRpc1.trim();
    if (!SOLANA_RPC.includes('://')) SOLANA_RPC = `https://${SOLANA_RPC}`;
    SOLANA_RPC = SOLANA_RPC.startsWith('wss://') ? SOLANA_RPC.replace('wss://', 'https://') : SOLANA_RPC.startsWith('ws://') ? SOLANA_RPC.replace('ws://', 'http://') : SOLANA_RPC;

    const payload = batch.map((t, i) => ({
      jsonrpc: '2.0', id: i + 1,
      method: 'getTokenLargestAccounts',
      params: [t.mint, { commitment: 'confirmed' }],
    }));

    const holdersRes = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (holdersRes.ok) {
      const results = await holdersRes.json() as any[];
      if (Array.isArray(results)) {
        results.forEach(res => {
          const idx = res.id - 1;
          const token = batch[idx];
          if (token && res.result?.value) {
            const accounts = res.result.value;
            let count = 0;
            let topPct = 0;
            if (accounts.length > 0) {
              count = accounts.length;
              const totalAmount = accounts.reduce((sum: number, a: any) => sum + (a.uiAmount ?? 0), 0);
              const topAmount = accounts[0]?.uiAmount ?? 0;
              topPct = totalAmount > 0 ? (topAmount / totalAmount) * 100 : 0;
            }
            prefetchedHolders.set(token.mint, { count, topPct });
          }
        });
      }
    }

    // Process tokens with limited concurrency (5 at a time) to avoid API floods
    for (let i = 0; i < batch.length; i += 5) {
      const chunk = batch.slice(i, i + 5);
      await Promise.all(chunk.map(t => processToken(t, prefetchedHolders.get(t.mint)).catch(err => {
        logCb('error', `Error processing ${t.symbol || t.mint.slice(0, 8)}: ${String(err)}`);
      })));
    }
  } catch (err) {
    logCb('error', `Error processing token batch: ${String(err)}`);
  }

  // Continue with next batch after delay
  processTimer = setTimeout(processNextToken, TOKEN_PROCESS_DELAY_MS);
}

// Known mints to skip — stablecoins, wrapped assets, mega-caps
const SKIP_MINTS = new Set([
  'So11111111111111111111111111111111111111112',  // SOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
]);

async function processToken(
  token: {
    mint: string;
    symbol: string;
    name: string;
    source: SignalSource;
    creator?: string;
    isMigration?: boolean;
  },
  prefetchedHolders?: { count: number; topPct: number }
): Promise<void> {
  const { mint } = token;

  // Skip known stablecoins and wrapped assets immediately
  if (SKIP_MINTS.has(mint)) return;

  processedCount++;

  // Mark as recently processed
  recentlyProcessed.add(mint);
  // Clean up old entries after 30 min
  setTimeout(() => recentlyProcessed.delete(mint), 1_800_000);

  // 1. Check denylist
  const db = await getDb();
  const denied = await isInDenylist(db, mint);
  if (denied) return;

  if (token.creator) {
    const creatorDenied = await isInDenylist(db, token.creator);
    if (creatorDenied) return;
  }

  // 2. Quick rugcheck — rate-limited queue (max 1 req / 2s), fail-open
  const rugResult = await queuedRugcheck(mint);
  const rugcheckPassed = rugResult.passed;
  const rugcheckScore = rugResult.score;
  if (!rugcheckPassed) {
    logCb('info', `${token.symbol || mint.slice(0, 8)}: RugCheck BLOCKED (score=${rugcheckScore}). Skipping.`);
    return;
  }

  // 3. Fetch market data from DexScreener (includes pairCreatedAt for age detection)
  let market = { price: 0, volume24h: 0, marketCap: 0, liquidity: 0 };
  let tokenAgeMinutes = -1;  // -1 = unknown
  let priceChange5m = 0;
  let priceChange1h = 0;
  let buySellRatio = 1.0;  // 1.0 = balanced, >1 = buy pressure, <1 = sell pressure

  try {
    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (dexRes.ok) {
      const dexData = await dexRes.json() as { pairs?: Array<Record<string, unknown>> };
      // Pick the pair with highest liquidity
      const pairs = dexData.pairs ?? [];
      const solanaPairs = pairs.filter((p: Record<string, unknown>) =>
        String(p.chainId ?? p.chain ?? '') === 'solana' || !p.chainId
      );
      const pair = solanaPairs.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
        Number((b.liquidity as Record<string, unknown>)?.usd ?? 0) - Number((a.liquidity as Record<string, unknown>)?.usd ?? 0)
      )[0] ?? pairs[0];

      if (pair) {
        market = {
          price: Number(pair.priceUsd ?? 0),
          volume24h: Number((pair.volume as Record<string, unknown>)?.h24 ?? 0),
          marketCap: Number(pair.marketCap ?? pair.fdv ?? 0),
          liquidity: Number((pair.liquidity as Record<string, unknown>)?.usd ?? 0),
        };
        // Extract price changes
        const priceChange = pair.priceChange as Record<string, unknown> ?? {};
        priceChange5m = Number(priceChange.m5 ?? 0);
        priceChange1h = Number(priceChange.h1 ?? 0);

        // Buy/sell transaction ratio from DexScreener
        const txns = pair.txns as Record<string, unknown> ?? {};
        const h1Txns = txns.h1 as Record<string, unknown> ?? {};
        const buys = Number(h1Txns.buys ?? 0);
        const sells = Number(h1Txns.sells ?? 0);
        if (sells > 0) buySellRatio = buys / sells;
        else if (buys > 0) buySellRatio = 5.0; // All buys, no sells = very bullish

        // Token age from pairCreatedAt (TrenchClaw technique — DexScreener free field)
        const createdAt = pair.pairCreatedAt;
        if (createdAt && Number(createdAt) > 0) {
          tokenAgeMinutes = (Date.now() - Number(createdAt)) / 60_000;
        }

        // Symbol/name from DexScreener
        if (!token.symbol && pair.baseToken) {
          const bt = pair.baseToken as Record<string, unknown>;
          token.symbol = String(bt.symbol ?? '');
          token.name = String(bt.name ?? '');
        }
      }
    }
  } catch {
    // Market data unavailable
  }

  // Skip stablecoins by symbol (catches any that slipped through mint check)
  const symUpper = (token.symbol || '').toUpperCase();
  if (['USDT', 'USDC', 'USDD', 'DAI', 'BUSD', 'TUSD', 'FRAX', 'PYUSD', 'USDH', 'UXD'].includes(symUpper)) return;

  // Skip mega-cap tokens (> $1B MCap) — not alpha
  if (market.marketCap > 1_000_000_000) return;

  // Skip tokens that are too old (> 2 hours) — stale opportunities
  if (tokenAgeMinutes > 360) {
    return;  // Quietly skip old tokens — there are thousands of them
  }

  // Minimum liquidity gate — $3k minimum to avoid slippage death
  if (market.liquidity < 3000) {
    return; // Silently skip — too thin to trade
  }

  // Buy/sell pressure filter — skip tokens where sells dominate (dump in progress)
  if (buySellRatio < 0.7 && market.volume24h > 0) {
    logCb('info', `${token.symbol || mint.slice(0, 8)}: sell pressure (buy/sell ratio: ${buySellRatio.toFixed(2)}) — skipping dump`);
    return;
  }

  // Holder concentration check via Solana RPC (free — no API key needed)
  // This is the TrenchClaw technique: detect rug risk and whale accumulation
  let topHolderPct = 0;
  let holderCount = 0;
  if (prefetchedHolders) {
    topHolderPct = prefetchedHolders.topPct;
    holderCount = prefetchedHolders.count;
  } else {
    try {
      const _rawRpc2 = process.env.SOLANA_RPC_CONSTANTK || process.env.SOLANA_RPC_HELIUS || process.env.SOLANA_RPC_QUICKNODE || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
      let SOLANA_RPC = _rawRpc2.trim();
      if (!SOLANA_RPC.includes('://')) SOLANA_RPC = `https://${SOLANA_RPC}`;
      SOLANA_RPC = SOLANA_RPC.startsWith('wss://') ? SOLANA_RPC.replace('wss://', 'https://') : SOLANA_RPC.startsWith('ws://') ? SOLANA_RPC.replace('ws://', 'http://') : SOLANA_RPC;
      const holdersRes = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTokenLargestAccounts',
          params: [mint, { commitment: 'confirmed' }],
        }),
      });
      if (holdersRes.ok) {
        const holdersData = await holdersRes.json() as {
          result?: { value?: Array<{ amount: string; uiAmount: number }> };
        };
        const accounts = holdersData.result?.value ?? [];
        if (accounts.length > 0) {
          holderCount = accounts.length; // coarse count — top 20 largest
          const totalAmount = accounts.reduce((sum, a) => sum + (a.uiAmount ?? 0), 0);
          const topAmount = accounts[0]?.uiAmount ?? 0;
          topHolderPct = totalAmount > 0 ? (topAmount / totalAmount) * 100 : 0;
        }
      }
    } catch {
      // Holder check failed — proceed without it
    }
  }

  // Hard rug filter: single wallet holding > 30% is a red flag (unless it's a known liquidity pool)
  if (topHolderPct > 30) {
    logCb('info', `${token.symbol || mint.slice(0, 8)}: top holder = ${topHolderPct.toFixed(1)}% — likely rug. Skipping.`);
    return;
  }

  // 4. Score with all signals — enrich with social + whale data
  // Look up KOL/social mentions for this mint
  let kolMentions = 0;
  let hasGoldKol = false;
  let detectedKolStrategy: 'flip' | 'conviction' | 'unknown' = 'unknown';
  let detectedKolName: string | undefined;
  try {
    const kolSignals = getKolSignals();
    const fiveMinAgo = Date.now() - 300_000;
    kolMentions = kolSignals.filter(
      s => s.tokenMint === mint && s.timestamp > fiveMinAgo
    ).length;
    // Also check twitter_kol specifically — these are high signal
    const twitterKolSignals = kolSignals.filter(
      s => s.tokenMint === mint && s.source === 'twitter_kol'
    );
    if (twitterKolSignals.length > 0) {
      kolMentions += twitterKolSignals.length * 2; // Twitter KOL mentions count double
    }
    
    // Check for Gold Tier KOL mentions (conviction callers — researched, hold-worthy)
    const goldKolSignal = twitterKolSignals.find(
      s => s.kolName && isGoldKol(s.kolName)
    );
    if (goldKolSignal) {
      hasGoldKol = true;
      detectedKolStrategy = 'conviction';
      detectedKolName = goldKolSignal.kolName;
    } else if (twitterKolSignals.length > 0) {
      // Unknown KOL (not Gold Tier) — use AI content grading to determine flip vs conviction
      const mainSignal = twitterKolSignals[0];
      detectedKolName = mainSignal.kolName;
      
      if (mainSignal.tweetText && process.env.OPENROUTER_API_KEY) {
         const aiStrategy = await analyzeKolTweetQuality(mainSignal.tweetText);
         detectedKolStrategy = aiStrategy === 'unknown' ? 'flip' : aiStrategy;
         if (detectedKolStrategy === 'conviction') {
             logCb('info', `[DeepSeek] Graded unknown KOL @${detectedKolName} post as HIGH CONVICTION. Upgrading exit strategy.`);
             hasGoldKol = true; // Give them the conviction score bonus as well
         } else {
             logCb('info', `[DeepSeek] Graded unknown KOL @${detectedKolName} post as PUMP-AND-DUMP (FLIP).`);
         }
      } else {
         detectedKolStrategy = 'flip';
      }
    }
  } catch { /* no KOL data available */ }

  // Look up smart money buys for this mint (WSS + Wallet Intel)
  let whaleNetFlow = 0;
  try {
    const smartBuys = getRecentSmartBuys();
    const mintBuys = smartBuys.filter(b => b.tokenAddress === mint);
    if (mintBuys.length > 0) {
      // Each smart wallet buy = strong signal
      whaleNetFlow = mintBuys.reduce((sum, b) => sum + b.solAmount, 0);
      if (whaleNetFlow > 0) {
        logCb('info', `${token.symbol || mint.slice(0, 8)}: Smart money detected! ${mintBuys.length} wallets, ${whaleNetFlow.toFixed(2)} SOL`);
      }
    }
    // Also check wallet intelligence buys
    const walletBuys = getRecentWalletBuys();
    const walletMintBuys = walletBuys.filter(b => b.tokenMint === mint);
    if (walletMintBuys.length > 0) {
      whaleNetFlow += walletMintBuys.reduce((sum, b) => sum + b.solSpent, 0);
    }
  } catch { /* no smart money data available */ }

  const score = calculateCompositeScore({
    tokenAddress: mint,
    volume24h: market.volume24h,
    holderCount,
    top10Concentration: topHolderPct,
    kolMentions,
    whaleNetFlow,
    liquidityUsd: market.liquidity,
  });

  // Attach KOL profile to score so trader can apply strategy-specific exit logic
  if (detectedKolStrategy !== 'unknown') {
    score.kolStrategy = detectedKolStrategy;
    if (detectedKolName) score.kolName = detectedKolName;
  }

  // ── Token age bonus (reduced — prevent FOMO inflation) ──
  
  // AI Narrative Hype Bonus
  const aiState = getCachedNarrative(mint);
  if (aiState && !aiState.isSpam && aiState.hypeScore >= 7) {
      const isTopMeta = getTopNarratives().includes(aiState.narrative.toLowerCase());
      if (isTopMeta) {
         score.total = Math.min(100, score.total + 15);
         if (score.total >= 65) score.conviction = 'high';
         logCb('info', `${token.symbol || mint.slice(0, 8)}: AI NARRATIVE BONUS +15 (Meta: '${aiState.narrative}', Hype: ${aiState.hypeScore})`);
      }
  }

  if (tokenAgeMinutes >= 0 && tokenAgeMinutes <= 5 && market.liquidity > 3000) {
    // Very early (< 5 min) — moderate bonus only
    score.total = Math.min(100, score.total + 5);
    logCb('info', `${token.symbol || mint.slice(0, 8)}: AGE BONUS +5 (${tokenAgeMinutes.toFixed(1)}min old — very early)`);
  } else if (tokenAgeMinutes > 5 && tokenAgeMinutes <= 20) {
    // Sweet spot — proven some momentum, still early
    score.total = Math.min(100, score.total + 12);
    if (score.total >= 65) score.conviction = 'medium';
    if (score.total >= 75) score.conviction = 'high';
    logCb('info', `${token.symbol || mint.slice(0, 8)}: AGE BONUS +12 (${tokenAgeMinutes.toFixed(1)}min old — SWEET SPOT)`);
  } else if (tokenAgeMinutes > 20 && tokenAgeMinutes <= 60) {
    // Still fresh window
    score.total = Math.min(100, score.total + 4);
  }

  // Momentum bonus: reduced from +10 to +6
  if (priceChange5m > 20 && tokenAgeMinutes > 0 && tokenAgeMinutes <= 30) {
    score.total = Math.min(100, score.total + 6);
    logCb('info', `${token.symbol || mint.slice(0, 8)}: MOMENTUM +6 (+${priceChange5m.toFixed(1)}% in 5m)`);
  }

  // Buy pressure bonus: reward tokens with strong buy/sell ratio
  if (buySellRatio >= 2.0) {
    score.total = Math.min(100, score.total + 5);
    logCb('info', `${token.symbol || mint.slice(0, 8)}: BUY PRESSURE +5 (ratio: ${buySellRatio.toFixed(1)})`);
  }

  // Social/KOL signal bonus — reward tokens with social backing
  if (hasGoldKol) {
    score.total = Math.min(100, score.total + 20);
    if (score.total >= 65) score.conviction = 'high';
    logCb('info', `${token.symbol || mint.slice(0, 8)}: GOLD KOL MENTION — +20 bonus`);
  } else if (kolMentions >= 2) {
    score.total = Math.min(100, score.total + 8);
    logCb('info', `${token.symbol || mint.slice(0, 8)}: SOCIAL BONUS +8 (${kolMentions} KOL mentions)`);
  } else if (kolMentions === 1) {
    score.total = Math.min(100, score.total + 4);
    logCb('info', `${token.symbol || mint.slice(0, 8)}: SOCIAL BONUS +4 (1 KOL mention)`);
  }

  // Smart money convergence bonus
  if (whaleNetFlow >= 5) {
    score.total = Math.min(100, score.total + 10);
    if (score.total >= 65) score.conviction = 'high';
    logCb('info', `${token.symbol || mint.slice(0, 8)}: SMART MONEY BONUS +10 (${whaleNetFlow.toFixed(2)} SOL from smart wallets)`);
  } else if (whaleNetFlow >= 1) {
    score.total = Math.min(100, score.total + 5);
    logCb('info', `${token.symbol || mint.slice(0, 8)}: SMART MONEY BONUS +5 (${whaleNetFlow.toFixed(2)} SOL from smart wallets)`);
  }

  signalCount++;

  // Only log tokens that have some market data
  if (market.marketCap > 0 || market.volume24h > 0) {
    const ageStr = tokenAgeMinutes >= 0 ? `${tokenAgeMinutes.toFixed(0)}min old` : 'age unknown';
    const holderStr = topHolderPct > 0 ? ` | Top holder: ${topHolderPct.toFixed(1)}%` : '';
    const momentumStr = priceChange5m !== 0 ? ` | 5m: ${priceChange5m > 0 ? '+' : ''}${priceChange5m.toFixed(1)}%` : '';
    logCb('info',
      `Scanned: ${token.symbol || mint.slice(0, 8)} | ` +
      `${ageStr} | ` +
      `MCap: $${market.marketCap.toLocaleString()} | ` +
      `Vol: $${market.volume24h.toLocaleString()} | ` +
      `Liq: $${market.liquidity.toLocaleString()}${holderStr}${momentumStr} | ` +
      `Score: ${score.total}/100 (${score.conviction})`,
    );
  }

  // 5. DeepSeek Alpha Screen — AI quality gate for non-KOL tokens
  // KOL tokens already have social proof; skip the screen for them to avoid blocking real alpha
  const hasKolBacking = detectedKolStrategy !== 'unknown' || kolMentions >= 2 || whaleNetFlow >= 2;
  if (!hasKolBacking && score.total >= 55 && process.env.OPENROUTER_API_KEY) {
    try {
      const screenResult = await screenTokenWithDeepSeek({
        symbol: token.symbol || mint.slice(0, 8),
        mint,
        marketCap: market.marketCap,
        liquidity: market.liquidity,
        volume24h: market.volume24h,
        tokenAgeMinutes,
        priceChange5m,
        priceChange1h,
        buySellRatio,
        holderCount,
        topHolderPct,
        whaleNetFlow,
        kolMentions,
        score: score.total,
        narrativeTag: aiState?.narrative,
      });
      
      if (!screenResult.worthy) {
        logCb('info', `[DeepSeek Alpha] REJECTED ${token.symbol || mint.slice(0, 8)}: ${screenResult.reasoning}`);
        return; // AI says not worth it
      }
      logCb('info', `[DeepSeek Alpha] APPROVED ${token.symbol || mint.slice(0, 8)} (${screenResult.confidence}): ${screenResult.reasoning}`);
    } catch {
      // Fail open — don't block on AI errors
    }
  }

  // 6. Build signal
  const now = Date.now();
  const signal: AlphaSignal = {
    id: uuidv4(),
    mintAddress: mint,
    symbol: token.symbol || '',
    name: token.name || '',
    marketCapUsd: market.marketCap,
    liquidityUsd: market.liquidity,
    sources: [token.source],
    score,
    discoveredAt: now,
    expiresAt: now + SIGNAL_DEFAULT_TTL_MS,
    tweetUrls: [],
    whaleWallets: [],
    rugcheckPassed,
    rugcheckScore,
    creatorAddress: token.creator || '',
    inDenylist: false,
  };

  // 6. Persist to DB
  try {
    await db.query(
      `INSERT INTO signals (id, mint, symbol, name, market_cap_usd, liquidity_usd,
         sources, score_json, discovered_at, expires_at, tweet_urls, whale_wallets,
         rugcheck_passed, rugcheck_score, creator_addr, in_denylist, expired)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0)
       ON CONFLICT (id) DO NOTHING`,
      [
        signal.id, signal.mintAddress, signal.symbol, signal.name,
        signal.marketCapUsd, signal.liquidityUsd,
        JSON.stringify(signal.sources), JSON.stringify(signal.score),
        signal.discoveredAt, signal.expiresAt,
        JSON.stringify(signal.tweetUrls), JSON.stringify(signal.whaleWallets),
        signal.rugcheckPassed ? 1 : 0, signal.rugcheckScore ?? null,
        signal.creatorAddress, signal.inDenylist ? 1 : 0,
      ],
    );
  } catch {
    // DB write failed — not fatal
  }

  // 7. Forward to trader if score qualifies
  if (score.total >= SCORE_THRESHOLDS.MIN_TO_TRADE && rugcheckPassed && finderRuntime) {
    forwardedCount++;

    const interAgentMsg: InterAgentMessage = {
      fromAgent: 'finder',
      toAgent: 'trader',
      type: 'signal_ready',
      correlationId: signal.id,
      payload: signal,
      timestamp: now,
    };

    try {
      await finderRuntime.messageManager.createMemory({
        id: uuidv4() as any,
        userId: '00000000-0000-0000-0000-000000000001' as any,
        agentId: finderRuntime.agentId,
        roomId: FINDER_TO_TRADER_ROOM as any,
        content: {
          text: JSON.stringify(interAgentMsg),
        },
        createdAt: now,
      });
    } catch {
      // Memory creation failed — not fatal
    }

    logCb('info',
      `SIGNAL FORWARDED: ${token.symbol || mint.slice(0, 8)} (${mint}) → Trader | ` +
      `Score: ${score.total} | MCap: $${market.marketCap.toLocaleString()} | ` +
      `Liq: $${market.liquidity.toLocaleString()} | ` +
      `https://dexscreener.com/solana/${mint}`,
    );
  }
}
