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
import type { PumpPortalToken } from './pumpportal.service.js';
import { getKolSignals } from './kol-intelligence.service.js';
import { getRecentSmartBuys } from './smart-money-monitor.service.js';
import { getRecentWalletBuys } from './wallet-intelligence.service.js';
import { getCachedWhaleActivity } from './helius.service.js';
import { getTrackedWalletAddresses } from './smart-money-monitor.service.js';
import { triggerInstantSnipe } from '@wildtrade/plugin-smart-trader';
import { startPumpSwapSniper, stopPumpSwapSniper, onPumpPortalMigration } from './pumpswap-sniper.service.js';
import type { MigrationSnipeEvent } from './pumpswap-sniper.service.js';

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

  // 1. Connect PumpPortal for real-time new launches
  logCb('info', 'Connecting to PumpPortal for new token launches...');
  connectPumpPortal((token: PumpPortalToken) => {
    enqueueToken(token.mint, token.symbol, token.name, 'pumpportal', token.creator);
  });

  // 1b. Subscribe to PumpFun migration events (tokens moving to Raydium = big pump opportunity)
  // ONLY forward to PumpSwap sniper → triggerInstantSnipe.
  // Do NOT also enqueue in tokenQueue — that caused double-buys (once via instant snipe,
  // once via normal signal pipeline with +20 migration bonus).
  onPumpMigration((migration) => {
    logCb('info', `MIGRATION DETECTED: ${migration.symbol || migration.mint.slice(0, 8)} migrating from PumpFun to Raydium — forwarding to sniper`);
    onPumpPortalMigration(migration);
  });

  // 1c. Start PumpSwap Migration Sniper — monitors on-chain for migrations and triggers instant buys
  logCb('info', 'Starting PumpSwap migration sniper for instant migration catches...');
  startPumpSwapSniper(
    (snipeEvent: MigrationSnipeEvent) => {
      logCb('info', `🎯 PUMPSWAP SNIPE: ${snipeEvent.symbol || snipeEvent.mint.slice(0, 8)} — migration detected via ${snipeEvent.source}!`);
      
      // Fast-track DIRECTLY to autonomous trader as an instant snipe
      // Skip the signals db and inter-agent messages — execute the buy function immediately
      triggerInstantSnipe(snipeEvent.mint, snipeEvent.symbol || snipeEvent.mint.slice(0, 8)).catch(err => {
        logCb('error', `Snipe trigger failed for ${snipeEvent.mint}: ${String(err)}`);
      });
      logCb('info', `🚀 MIGRATION FORWARDED: Sent ${snipeEvent.mint.slice(0, 8)} directly to trader for instant buy!`);
    },
    (msg) => logCb('info', msg),
  );

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

async function processToken(token: {
  mint: string;
  symbol: string;
  name: string;
  source: SignalSource;
  creator?: string;
  isMigration?: boolean;
}): Promise<void> {
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

  // 2. Quick rugcheck — fail-open on API errors, only block on confirmed risks
  let rugcheckPassed = true; // Fail-open: assume safe unless we confirm danger
  let rugcheckScore = 50;
  try {
    const rugRes = await fetch(`${RUGCHECK_API_BASE}/tokens/${mint}/report`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (rugRes.ok) {
      const rugData = await rugRes.json() as {
        score?: number;
        risks?: Array<{ name: string; level: string }>;
      };
      rugcheckScore = rugData.score ?? 50;
      const risks = rugData.risks ?? [];
      const criticalRisks = risks.filter(r => r.level === 'critical');
      const highRisks = risks.filter(r => r.level === 'high');
      const hasCriticalFlag = risks.some(r =>
        r.name?.toLowerCase().includes('honeypot') || r.name?.toLowerCase().includes('mintable')
      );
      // Only fail on critical flags or score < 30; score 30-50 passes with warning
      rugcheckPassed = !hasCriticalFlag && criticalRisks.length === 0 && rugcheckScore >= 30;
      if (!rugcheckPassed) {
        logCb('info', `${token.symbol || mint.slice(0, 8)}: RugCheck BLOCKED (score=${rugcheckScore}, critical=${criticalRisks.length}). Skipping.`);
      } else if (rugcheckScore < 50 || highRisks.length > 0) {
        logCb('info', `${token.symbol || mint.slice(0, 8)}: RugCheck CAUTION (score=${rugcheckScore}, highRisks=${highRisks.length}) — proceeding with reduced confidence`);
      }
    }
    // If API returns non-OK (rate limit, etc), rugcheckPassed stays true (fail-open)
  } catch {
    // Rugcheck API unreachable — proceed (fail-open), don't block tokens
    logCb('info', `${token.symbol || mint.slice(0, 8)}: RugCheck API timeout — proceeding without safety check`);
  }

  if (!rugcheckPassed) {
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
  if (tokenAgeMinutes > 120) {
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
  try {
    const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
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

  // Hard rug filter: single wallet holding > 30% is a red flag (unless it's a known liquidity pool)
  if (topHolderPct > 30) {
    logCb('info', `${token.symbol || mint.slice(0, 8)}: top holder = ${topHolderPct.toFixed(1)}% — likely rug. Skipping.`);
    return;
  }

  // 4. Score with all signals — enrich with social + whale data
  // Look up KOL/social mentions for this mint
  let kolMentions = 0;
  try {
    const kolSignals = getKolSignals();
    const fiveMinAgo = Date.now() - 300_000;
    kolMentions = kolSignals.filter(
      s => s.tokenMint === mint && s.timestamp > fiveMinAgo
    ).length;
    // Also check twitter_kol specifically — these are high signal
    const twitterKolCount = kolSignals.filter(
      s => s.tokenMint === mint && s.source === 'twitter_kol'
    ).length;
    if (twitterKolCount > 0) {
      kolMentions += twitterKolCount * 2; // Twitter KOL mentions count double
    }
  } catch { /* no KOL data available */ }

  // Look up smart money buys for this mint (GMGN + Wallet Intel + Helius)
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
    // Also check Helius whale transactions (if HELIUS_API_KEY is set)
    const heliusTxs = await getCachedWhaleActivity(getTrackedWalletAddresses());
    const heliusBuys = heliusTxs.filter(t => t.mint === mint && t.type === 'buy');
    if (heliusBuys.length > 0) {
      const heliusFlow = heliusBuys.reduce((sum, b) => sum + b.amountSol, 0);
      whaleNetFlow += heliusFlow;
      if (heliusFlow > 0) {
        logCb('info', `${token.symbol || mint.slice(0, 8)}: Helius whale buys! ${heliusBuys.length} txs, ${heliusFlow.toFixed(2)} SOL`);
      }
    }
  } catch { /* no smart money data available */ }

  const score = calculateCompositeScore({
    volume24h: market.volume24h,
    holderCount,
    top10Concentration: topHolderPct,
    kolMentions,
    whaleNetFlow,
    liquidityUsd: market.liquidity,
  });

  // ── Token age bonus (reduced — prevent FOMO inflation) ──
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
  if (kolMentions >= 2) {
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
      `SIGNAL FORWARDED: ${token.symbol || mint.slice(0, 8)} (${mint}) → Trader | ` +
      `Score: ${score.total} | MCap: $${market.marketCap.toLocaleString()} | ` +
      `Liq: $${market.liquidity.toLocaleString()} | ` +
      `https://dexscreener.com/solana/${mint}`,
    );
  }
}
