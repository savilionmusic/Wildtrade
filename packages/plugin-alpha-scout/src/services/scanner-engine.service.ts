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
import { connect as connectPumpPortal, disconnect as disconnectPumpPortal } from './pumpportal.service.js';
import type { PumpPortalToken } from './pumpportal.service.js';

// ── Config ──
const DEXSCREENER_POLL_MS = 120_000;   // 2 min — DexScreener has generous free limits
const TOKEN_PROCESS_DELAY_MS = 3_000;   // 3 sec between processing tokens (rate limit)
const MAX_QUEUE_SIZE = 50;              // Don't queue too many tokens
const RUGCHECK_API_BASE = process.env.RUGCHECK_API_BASE ?? 'https://api.rugcheck.xyz/v1';

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

  // 1. Connect PumpPortal for real-time new launches
  logCb('info', 'Connecting to PumpPortal for new token launches...');
  connectPumpPortal((token: PumpPortalToken) => {
    enqueueToken(token.mint, token.symbol, token.name, 'pumpportal', token.creator);
  });

  // 2. Start DexScreener trending poller
  logCb('info', 'Starting DexScreener trending scanner...');
  pollDexScreenerTrending();
  dexScreenerTimer = setInterval(pollDexScreenerTrending, DEXSCREENER_POLL_MS);

  // 3. Start token processing loop
  processNextToken();

  logCb('info', 'Scanner fully active — watching PumpPortal + DexScreener');
}

export function stopScanner(): void {
  scannerRunning = false;
  disconnectPumpPortal();
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

function enqueueToken(
  mint: string,
  symbol: string,
  name: string,
  source: SignalSource,
  creator?: string,
): void {
  // Skip if recently processed (within last 30 min)
  if (recentlyProcessed.has(mint)) return;

  // Skip if already in queue
  if (tokenQueue.find(t => t.mint === mint)) return;

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
    const profilesRes = await fetch('https://api.dexscreener.com/token-profiles/latest/v1', {
      headers: { 'Accept': 'application/json' },
    });

    if (profilesRes.ok) {
      const profiles = await profilesRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
        header?: string;
      }>;

      let added = 0;
      for (const p of profiles) {
        if (p.chainId === 'solana' && p.tokenAddress) {
          enqueueToken(p.tokenAddress, '', '', 'pumpportal');
          added++;
        }
      }

      if (added > 0) {
        logCb('info', `DexScreener profiles: found ${added} new Solana tokens`);
      }
    }
  } catch (err) {
    logCb('error', `DexScreener profiles error: ${String(err)}`);
  }

  try {
    // DexScreener boosted tokens (tokens that are hot right now)
    const boostRes = await fetch('https://api.dexscreener.com/token-boosts/latest/v1', {
      headers: { 'Accept': 'application/json' },
    });

    if (boostRes.ok) {
      const boosts = await boostRes.json() as Array<{
        chainId?: string;
        tokenAddress?: string;
        amount?: number;
      }>;

      let added = 0;
      for (const b of boosts) {
        if (b.chainId === 'solana' && b.tokenAddress) {
          enqueueToken(b.tokenAddress, '', '', 'pumpportal');
          added++;
        }
      }

      if (added > 0) {
        logCb('info', `DexScreener boosts: found ${added} boosted Solana tokens`);
      }
    }
  } catch (err) {
    logCb('error', `DexScreener boosts error: ${String(err)}`);
  }
}

// ── Token Processing Pipeline ──

async function processNextToken(): Promise<void> {
  if (!scannerRunning) return;

  const token = tokenQueue.shift();
  if (!token) {
    // Nothing to process, check again in 5 seconds
    processTimer = setTimeout(processNextToken, 5_000);
    return;
  }

  try {
    await processToken(token);
  } catch (err) {
    logCb('error', `Error processing ${token.symbol || token.mint.slice(0, 8)}: ${String(err)}`);
  }

  // Continue with next token after delay
  processTimer = setTimeout(processNextToken, TOKEN_PROCESS_DELAY_MS);
}

async function processToken(token: {
  mint: string;
  symbol: string;
  name: string;
  source: SignalSource;
  creator?: string;
}): Promise<void> {
  const { mint } = token;
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

  // 2. Quick rugcheck
  let rugcheckPassed = true;
  let rugcheckScore = 50;
  try {
    const rugRes = await fetch(`${RUGCHECK_API_BASE}/tokens/${mint}/report`);
    if (rugRes.ok) {
      const rugData = await rugRes.json() as {
        score?: number;
        risks?: Array<{ name: string; level: string }>;
      };
      rugcheckScore = rugData.score ?? 50;
      const highRisks = (rugData.risks ?? []).filter(r => r.level === 'high' || r.level === 'critical');
      rugcheckPassed = highRisks.length === 0;
    }
  } catch {
    // Rugcheck failed — proceed with caution
  }

  if (!rugcheckPassed) {
    logCb('info', `${token.symbol || mint.slice(0, 8)}: RugCheck FAILED (score=${rugcheckScore}). Skipping.`);
    return;
  }

  // 3. Fetch market data from DexScreener
  let market = { price: 0, volume24h: 0, marketCap: 0, liquidity: 0 };
  try {
    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (dexRes.ok) {
      const dexData = await dexRes.json() as { pairs?: Array<Record<string, unknown>> };
      const pair = dexData.pairs?.[0];
      if (pair) {
        market = {
          price: Number(pair.priceUsd ?? 0),
          volume24h: Number((pair.volume as Record<string, unknown>)?.h24 ?? 0),
          marketCap: Number(pair.marketCap ?? pair.fdv ?? 0),
          liquidity: Number((pair.liquidity as Record<string, unknown>)?.usd ?? 0),
        };
        // Also grab symbol/name from DexScreener if we don't have them
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

  // 4. Score
  const score = calculateCompositeScore({
    volume24h: market.volume24h,
    holderCount: 0,
    top10Concentration: 0,
    kolMentions: 0,
    whaleNetFlow: 0,
    liquidityUsd: market.liquidity,
  });

  signalCount++;

  // Only log tokens that have some market data
  if (market.marketCap > 0 || market.volume24h > 0) {
    logCb('info',
      `Scanned: ${token.symbol || mint.slice(0, 8)} | ` +
      `MCap: $${market.marketCap.toLocaleString()} | ` +
      `Vol: $${market.volume24h.toLocaleString()} | ` +
      `Liq: $${market.liquidity.toLocaleString()} | ` +
      `Score: ${score.total}/100 (${score.conviction})`,
    );
  }

  // 5. Build signal
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
      `SIGNAL FORWARDED: ${token.symbol || mint.slice(0, 8)} → Trader | ` +
      `Score: ${score.total} | MCap: $${market.marketCap.toLocaleString()} | ` +
      `Liq: $${market.liquidity.toLocaleString()}`,
    );
  }
}
