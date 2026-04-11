/**
 * Wallet PnL Profiler — Dragon-style trade history analysis.
 *
 * Analyzes a wallet's recent trade history across multiple tokens to compute
 * REAL win rate, ROI, and profitability metrics. Replaces hardcoded assumptions
 * with on-chain verified data.
 *
 * Uses ONLY Solana RPC + Jupiter Price API (free, within Constant-K limits).
 *
 * Algorithm:
 *   1. Fetch wallet's last N transaction signatures
 *   2. Decode DEX buy/sell actions per token (Jupiter, Raydium, Pump.fun)
 *   3. Aggregate SOL spent vs SOL received per token (realized PnL)
 *   4. For tokens still held, estimate unrealized PnL via Jupiter price
 *   5. Score: win rate, avg ROI, total trades, profitable count
 *
 * RPC budget per profile: ~100-500 calls (signatures + tx decodes + balance checks)
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { selectPrimaryHttpRpcEndpoint } from '@wildtrade/shared';
import { schedule } from '@wildtrade/plugin-solana-compat';

// ── Config ──
const MAX_SIGNATURES = 500;           // Last N transactions to analyze
const TX_BATCH_SIZE = 12;             // Concurrent tx fetches
const TX_BATCH_DELAY_MS = 700;        // Delay between batches
const MIN_SOL_TRADE = 0.01;           // Ignore dust trades
const PROFILE_CACHE_TTL_MS = 1_800_000; // Cache profiles for 30 min
const PROFILE_COOLDOWN_MS = 60_000;   // Don't re-profile same wallet within 60s
const JUPITER_PRICE_BATCH = 50;       // Max tokens per Jupiter Price API call
const MIN_TOKEN_TRADES = 2;           // Need at least 2 trades to count a token (buy + optional sell)

// Known DEX program IDs
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_PROGRAM = 'TokenkegQvEj7rE86Z2nXy7HvjjctkaJz5Enm1jgQTVG';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

// System / program addresses to exclude from wallet analysis
const EXCLUDE_ADDRESSES = new Set([
  TOKEN_PROGRAM, JUPITER_V6, RAYDIUM_AMM, PUMPFUN,
  SOL_MINT, SYSTEM_PROGRAM,
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
  'ComputeBudget111111111111111111111111111111',
  'SysvarRent111111111111111111111111111111111',
]);

// ── Types ──

export interface TokenTradeSummary {
  mint: string;
  solSpent: number;         // Total SOL spent buying this token
  solReceived: number;      // Total SOL received selling this token
  buyCount: number;
  sellCount: number;
  realizedPnlSol: number;   // solReceived - solSpent (negative if still holding)
  unrealizedValueUsd: number; // Estimated current value of remaining holdings
  isWin: boolean;           // True if total return > 0
  roiPct: number;           // Return on investment %
}

export interface WalletPnlProfile {
  address: string;
  profiledAt: number;
  totalTokensTraded: number;
  totalTrades: number;
  profitableTrades: number;  // Tokens where ROI > 0
  winRate: number;           // 0-1
  avgRoiPct: number;         // Average ROI across closed positions
  totalSolSpent: number;
  totalSolReceived: number;
  netPnlSol: number;         // Total realized PnL in SOL
  avgBuySizeSol: number;
  bestTrade: TokenTradeSummary | null;
  worstTrade: TokenTradeSummary | null;
  tokenBreakdown: TokenTradeSummary[];  // Per-token details
  bes: number;               // Computed Buy Efficiency Score 0-100
}

// ── State ──
let rpcConnection: Connection | null = null;
const profileCache = new Map<string, { profile: WalletPnlProfile; expiresAt: number }>();
const lastProfileTime = new Map<string, number>();

type LogCb = (msg: string) => void;
let logCb: LogCb = (msg) => console.log(`[wallet-pnl] ${msg}`);

export function setWalletPnlProfilerLog(cb: LogCb): void {
  logCb = cb;
}

function getConnection(): Connection {
  if (rpcConnection) return rpcConnection;
  rpcConnection = new Connection(selectPrimaryHttpRpcEndpoint(), {
    commitment: 'confirmed',
    fetch: global.fetch,
  });
  return rpcConnection;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main Profiler ──

/**
 * Profile a wallet's trading history across multiple tokens.
 * Returns real win rate, ROI, PnL, and a computed BES score.
 */
export async function profileWalletPnl(walletAddress: string): Promise<WalletPnlProfile | null> {
  // Cooldown check
  const lastTime = lastProfileTime.get(walletAddress);
  if (lastTime && Date.now() - lastTime < PROFILE_COOLDOWN_MS) {
    const cached = profileCache.get(walletAddress);
    if (cached && cached.expiresAt > Date.now()) return cached.profile;
    return null;
  }

  // Cache check
  const cached = profileCache.get(walletAddress);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;

  lastProfileTime.set(walletAddress, Date.now());
  logCb(`Profiling wallet ${walletAddress.slice(0, 8)}...`);

  const connection = getConnection();
  const walletPubkey = new PublicKey(walletAddress);

  try {
    // ── Step 1: Fetch recent transaction signatures ──
    const allSignatures: Array<{ signature: string; blockTime: number | null }> = [];
    let beforeCursor: string | undefined;

    for (let page = 0; page < 5; page++) {
      await schedule('read');
      const batch = await connection.getSignaturesForAddress(
        walletPubkey,
        { limit: 100, before: beforeCursor },
        'confirmed',
      );

      if (batch.length === 0) break;

      for (const sig of batch) {
        if (sig.err) continue;
        allSignatures.push({ signature: sig.signature, blockTime: sig.blockTime });
      }

      beforeCursor = batch[batch.length - 1].signature;
      if (allSignatures.length >= MAX_SIGNATURES) break;

      await sleep(200);
    }

    if (allSignatures.length < 3) {
      logCb(`Wallet ${walletAddress.slice(0, 8)} has too few transactions (${allSignatures.length})`);
      return null;
    }

    logCb(`Fetched ${allSignatures.length} signatures for ${walletAddress.slice(0, 8)}, decoding...`);

    // ── Step 2: Decode transactions and track per-token activity ──
    // Map: tokenMint -> { solSpent, solReceived, buyCount, sellCount }
    const tokenActivity = new Map<string, {
      solSpent: number;
      solReceived: number;
      buyCount: number;
      sellCount: number;
    }>();

    let decodedCount = 0;

    for (let i = 0; i < allSignatures.length; i += TX_BATCH_SIZE) {
      const batch = allSignatures.slice(i, i + TX_BATCH_SIZE);

      const txPromises = batch.map(async (sig) => {
        try {
          await schedule('read');
          return await connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
        } catch {
          return null;
        }
      });

      const txResults = await Promise.all(txPromises);

      for (const tx of txResults) {
        if (!tx || !tx.meta) continue;

        const logs = tx.meta.logMessages ?? [];
        const logsJoined = logs.join(' ');

        // Only analyze DEX transactions
        const isDex = logsJoined.includes(JUPITER_V6) ||
                      logsJoined.includes(RAYDIUM_AMM) ||
                      logsJoined.includes(PUMPFUN);
        if (!isDex) continue;

        // Decode SOL flow for this wallet
        const preBalances = tx.meta.preBalances ?? [];
        const postBalances = tx.meta.postBalances ?? [];
        const accountKeys = tx.transaction.message.getAccountKeys?.()
          ?? (tx.transaction.message as any).accountKeys ?? [];

        // Find the wallet's index in the transaction
        let walletIdx = -1;
        for (let k = 0; k < Math.min(preBalances.length, 6); k++) {
          let pubkey: string;
          try {
            const key = typeof accountKeys.get === 'function'
              ? accountKeys.get(k)
              : accountKeys[k];
            pubkey = key?.toBase58?.() ?? String(key);
          } catch { continue; }

          if (pubkey === walletAddress) {
            walletIdx = k;
            break;
          }
        }

        if (walletIdx === -1) continue;

        const solChange = (postBalances[walletIdx] - preBalances[walletIdx]) / 1e9;
        const absChange = Math.abs(solChange);
        if (absChange < MIN_SOL_TRADE) continue;

        // Identify which token was traded by looking at token balance changes
        const preTokenBalances = tx.meta.preTokenBalances ?? [];
        const postTokenBalances = tx.meta.postTokenBalances ?? [];

        let tradedMint = identifyTradedToken(
          preTokenBalances,
          postTokenBalances,
          walletAddress,
          accountKeys,
        );

        // Fallback: use any non-SOL mint from token balance changes
        if (!tradedMint) {
          tradedMint = fallbackMintDetection(preTokenBalances, postTokenBalances);
        }

        if (!tradedMint || tradedMint === SOL_MINT) continue;

        const existing = tokenActivity.get(tradedMint) ?? {
          solSpent: 0, solReceived: 0, buyCount: 0, sellCount: 0,
        };

        if (solChange < -MIN_SOL_TRADE) {
          // SOL decreased → BUY
          existing.solSpent += absChange;
          existing.buyCount++;
        } else if (solChange > MIN_SOL_TRADE) {
          // SOL increased → SELL
          existing.solReceived += absChange;
          existing.sellCount++;
        }

        tokenActivity.set(tradedMint, existing);
        decodedCount++;
      }

      if (i + TX_BATCH_SIZE < allSignatures.length) {
        await sleep(TX_BATCH_DELAY_MS);
      }
    }

    if (tokenActivity.size === 0) {
      logCb(`No DEX trades found for ${walletAddress.slice(0, 8)}`);
      return null;
    }

    logCb(`Decoded ${decodedCount} DEX trades across ${tokenActivity.size} tokens for ${walletAddress.slice(0, 8)}`);

    // ── Step 3: Compute per-token PnL ──
    const tokenBreakdown: TokenTradeSummary[] = [];

    for (const [mint, activity] of tokenActivity) {
      // Skip tokens with only dust activity
      const totalActivity = activity.buyCount + activity.sellCount;
      if (totalActivity < MIN_TOKEN_TRADES) continue;

      const realizedPnlSol = activity.solReceived - activity.solSpent;

      // ROI: how much SOL they got back relative to what they spent
      const roiPct = activity.solSpent > 0
        ? ((activity.solReceived / activity.solSpent) - 1) * 100
        : 0;

      // A "win" = sold for more than they bought, OR still holding with >0 realized
      // For positions not fully closed (buyCount > sellCount and no big sell), 
      // we'll be conservative and only count fully exited or profitable partial exits
      const isWin = realizedPnlSol > 0;

      tokenBreakdown.push({
        mint,
        solSpent: activity.solSpent,
        solReceived: activity.solReceived,
        buyCount: activity.buyCount,
        sellCount: activity.sellCount,
        realizedPnlSol,
        unrealizedValueUsd: 0, // Skipping unrealized to save RPC calls
        isWin,
        roiPct,
      });
    }

    if (tokenBreakdown.length === 0) {
      logCb(`No significant token trades for ${walletAddress.slice(0, 8)}`);
      return null;
    }

    // Sort by PnL descending
    tokenBreakdown.sort((a, b) => b.realizedPnlSol - a.realizedPnlSol);

    // ── Step 4: Aggregate stats ──
    const profitableTrades = tokenBreakdown.filter(t => t.isWin).length;
    const winRate = profitableTrades / tokenBreakdown.length;

    const totalSolSpent = tokenBreakdown.reduce((s, t) => s + t.solSpent, 0);
    const totalSolReceived = tokenBreakdown.reduce((s, t) => s + t.solReceived, 0);
    const netPnlSol = totalSolReceived - totalSolSpent;

    // Average ROI across tokens that have both buys and sells (closed positions)
    const closedPositions = tokenBreakdown.filter(t => t.sellCount > 0 && t.solSpent > 0);
    const avgRoiPct = closedPositions.length > 0
      ? closedPositions.reduce((s, t) => s + t.roiPct, 0) / closedPositions.length
      : 0;

    const totalTrades = tokenBreakdown.reduce((s, t) => s + t.buyCount + t.sellCount, 0);
    const totalBuys = tokenBreakdown.reduce((s, t) => s + t.buyCount, 0);
    const avgBuySizeSol = totalBuys > 0 ? totalSolSpent / totalBuys : 0;

    const bestTrade = tokenBreakdown[0] ?? null;
    const worstTrade = tokenBreakdown[tokenBreakdown.length - 1] ?? null;

    // ── Step 5: Compute BES ──
    const bes = computeBes(winRate, avgRoiPct, totalTrades, avgBuySizeSol, netPnlSol);

    const profile: WalletPnlProfile = {
      address: walletAddress,
      profiledAt: Date.now(),
      totalTokensTraded: tokenBreakdown.length,
      totalTrades,
      profitableTrades,
      winRate,
      avgRoiPct,
      totalSolSpent,
      totalSolReceived,
      netPnlSol,
      avgBuySizeSol,
      bestTrade,
      worstTrade,
      tokenBreakdown,
      bes,
    };

    // Cache
    profileCache.set(walletAddress, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });

    logCb(
      `Profile complete for ${walletAddress.slice(0, 8)}: ` +
      `${tokenBreakdown.length} tokens, ${(winRate * 100).toFixed(0)}% win rate, ` +
      `${avgRoiPct.toFixed(0)}% avg ROI, ${netPnlSol.toFixed(2)} SOL net PnL, BES=${bes}`,
    );

    return profile;
  } catch (err) {
    logCb(`Profile failed for ${walletAddress.slice(0, 8)}: ${String(err)}`);
    return null;
  }
}

// ── Helpers ──

/**
 * Identify the token mint traded by looking at token balance changes for the wallet.
 */
function identifyTradedToken(
  preTokenBalances: Array<any>,
  postTokenBalances: Array<any>,
  walletAddress: string,
  accountKeys: any,
): string | null {
  // Combine pre and post token balances, look for the wallet's token changes
  const allBalances = [...preTokenBalances, ...postTokenBalances];

  for (const bal of allBalances) {
    if (!bal || !bal.mint) continue;
    if (bal.mint === SOL_MINT) continue;

    // Check if this balance belongs to our wallet
    const owner = bal.owner;
    if (owner === walletAddress) return bal.mint;

    // Also check by account index — map the account index to the wallet
    if (bal.accountIndex !== undefined) {
      try {
        const key = typeof accountKeys.get === 'function'
          ? accountKeys.get(bal.accountIndex)
          : accountKeys[bal.accountIndex];
        const pubkey = key?.toBase58?.() ?? String(key);
        if (pubkey === walletAddress) return bal.mint;
      } catch { /* ignore */ }
    }
  }

  return null;
}

/**
 * Fallback: pick the most common non-SOL mint from token balance changes.
 */
function fallbackMintDetection(
  preTokenBalances: Array<any>,
  postTokenBalances: Array<any>,
): string | null {
  const mints = new Map<string, number>();

  for (const bal of [...preTokenBalances, ...postTokenBalances]) {
    if (!bal?.mint || bal.mint === SOL_MINT) continue;
    mints.set(bal.mint, (mints.get(bal.mint) ?? 0) + 1);
  }

  let bestMint: string | null = null;
  let bestCount = 0;
  for (const [mint, count] of mints) {
    if (count > bestCount) {
      bestMint = mint;
      bestCount = count;
    }
  }

  return bestMint;
}

/**
 * Compute Buy Efficiency Score from verified PnL data.
 * BES 0-100: higher = more profitable and consistent trader.
 */
function computeBes(
  winRate: number,
  avgRoiPct: number,
  totalTrades: number,
  avgBuySizeSol: number,
  netPnlSol: number,
): number {
  let score = 0;

  // Win rate component (0-35 points)
  // 50% win rate = 15 pts, 70% = 28 pts, 90% = 35 pts
  score += Math.min(35, Math.round(winRate * 40));

  // ROI component (0-25 points)
  // Clamp ROI to prevent outliers from dominating
  const clampedRoi = Math.max(-100, Math.min(500, avgRoiPct));
  if (clampedRoi > 0) {
    score += Math.min(25, Math.round(clampedRoi / 20));
  } else {
    score += Math.max(-10, Math.round(clampedRoi / 20));
  }

  // Trade activity (0-15 points) — more trades = more reliable signal
  if (totalTrades >= 20) score += 15;
  else if (totalTrades >= 10) score += 10;
  else if (totalTrades >= 5) score += 7;
  else if (totalTrades >= 3) score += 3;

  // Net PnL positive bonus (0-15 points)
  if (netPnlSol > 10) score += 15;
  else if (netPnlSol > 5) score += 12;
  else if (netPnlSol > 1) score += 8;
  else if (netPnlSol > 0) score += 4;

  // Reasonable position sizing (0-10 points)
  // Avoid tracking micro-dustoor giant-whale wallets
  if (avgBuySizeSol >= 0.5 && avgBuySizeSol <= 10) score += 10;
  else if (avgBuySizeSol >= 0.1 && avgBuySizeSol <= 20) score += 5;

  return Math.max(0, Math.min(100, score));
}

/**
 * Get a cached profile if available.
 */
export function getCachedProfile(walletAddress: string): WalletPnlProfile | null {
  const cached = profileCache.get(walletAddress);
  if (cached && cached.expiresAt > Date.now()) return cached.profile;
  return null;
}

/**
 * Clear all cached profiles.
 */
export function clearProfileCache(): void {
  profileCache.clear();
  lastProfileTime.clear();
}
