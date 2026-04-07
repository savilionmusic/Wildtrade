/**
 * Smart Money Monitor — Polling-based, no WebSockets.
 *
 * Periodically polls GMGN for top wallet activity, detects when
 * multiple smart wallets buy the same token (cluster detection),
 * and emits signals to the Finder agent pipeline.
 *
 * Free-tier friendly: polls every 3-5 min, caches aggressively.
 */

import {
  getQualityWallets,
  getWalletBuys,
  getTokenInfo,
  type GmgnWallet,
  type GmgnWalletTrade,
  type GmgnTokenInfo,
} from './gmgn.service.js';

// ── Types ──

export interface SmartMoneySignal {
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  smartWalletCount: number;
  walletBuys: WalletBuy[];
  totalSolInvested: number;
  avgMarketCap: number;
  tokenInfo: GmgnTokenInfo | null;
  detectedAt: number;
  confidence: 'low' | 'medium' | 'high' | 'very_high';
}

export interface WalletBuy {
  wallet: string;
  solAmount: number;
  timestamp: number;
  qualityScore: number;
  winrate: number;
}

export type SmartMoneyCallback = (signal: SmartMoneySignal) => void;

// ── Config ──

const CONFIG = {
  // How often to refresh the wallet list (1 hour)
  WALLET_REFRESH_INTERVAL_MS: 3_600_000,
  // How often to poll wallet activity (3 min — easy on APIs)
  ACTIVITY_POLL_INTERVAL_MS: 180_000,
  // Time window for cluster detection (45 minutes)
  CLUSTER_WINDOW_MS: 2_700_000,
  // Minimum smart wallets buying same token to trigger signal
  MIN_CLUSTER_SIZE: 2,
  // Minimum wallet quality score to track
  MIN_WALLET_QUALITY: 35,
  // Maximum wallets to track (keep API calls low)
  MAX_TRACKED_WALLETS: 20,
  // Buys per wallet to check
  BUYS_PER_WALLET: 5,
  // How many wallets to poll per cycle (spread load)
  WALLETS_PER_CYCLE: 5,
};

// ── State ──

interface TrackedWallet {
  address: string;
  qualityScore: number;
  winrate: number;
  pnl7d: number;
  lastChecked: number;
}

interface RecentBuy {
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  solAmount: number;
  timestamp: number;
  qualityScore: number;
  winrate: number;
}

let trackedWallets: TrackedWallet[] = [];
let recentBuys: RecentBuy[] = [];
let onSignalCallback: SmartMoneyCallback | null = null;
let walletRefreshTimer: ReturnType<typeof setInterval> | null = null;
let activityPollTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let walletPollIndex = 0;

// Track which signals we've already emitted to avoid duplicates
const emittedSignals = new Set<string>();

// ── Public API ──

/**
 * Start the smart money monitor.
 * @param onSignal - Callback when a cluster is detected
 * @param userWallets - Optional extra wallets from user config (SMART_MONEY_WALLETS env)
 */
export async function startSmartMoneyMonitor(
  onSignal: SmartMoneyCallback,
  userWallets?: string[],
): Promise<void> {
  if (isRunning) {
    console.log('[smart-money] Monitor already running');
    return;
  }

  isRunning = true;
  onSignalCallback = onSignal;

  console.log('[smart-money] Starting smart money monitor...');
  console.log(`[smart-money] Config: poll every ${CONFIG.ACTIVITY_POLL_INTERVAL_MS / 1000}s, cluster window ${CONFIG.CLUSTER_WINDOW_MS / 60000}min, min cluster size ${CONFIG.MIN_CLUSTER_SIZE}`);

  // Add user-configured wallets with high priority
  if (userWallets && userWallets.length > 0) {
    for (const addr of userWallets) {
      trackedWallets.push({
        address: addr,
        qualityScore: 90, // User wallets get high priority
        winrate: 0,
        pnl7d: 0,
        lastChecked: 0,
      });
    }
    console.log(`[smart-money] Added ${userWallets.length} user-configured wallets`);
  }

  // Initial wallet list fetch
  await refreshWalletList();

  // Start polling cycles
  walletRefreshTimer = setInterval(() => {
    refreshWalletList().catch(err => {
      console.log(`[smart-money] Wallet refresh error: ${String(err)}`);
    });
  }, CONFIG.WALLET_REFRESH_INTERVAL_MS);

  activityPollTimer = setInterval(() => {
    pollActivityCycle().catch(err => {
      console.log(`[smart-money] Activity poll error: ${String(err)}`);
    });
  }, CONFIG.ACTIVITY_POLL_INTERVAL_MS);

  // Do first activity poll after short delay
  setTimeout(() => {
    pollActivityCycle().catch(err => {
      console.log(`[smart-money] Initial poll error: ${String(err)}`);
    });
  }, 10_000);

  console.log(`[smart-money] Monitor started, tracking ${trackedWallets.length} wallets`);
}

/**
 * Stop the monitor.
 */
export function stopSmartMoneyMonitor(): void {
  if (walletRefreshTimer) clearInterval(walletRefreshTimer);
  if (activityPollTimer) clearInterval(activityPollTimer);
  walletRefreshTimer = null;
  activityPollTimer = null;
  isRunning = false;
  onSignalCallback = null;
  console.log('[smart-money] Monitor stopped');
}

/**
 * Get current monitoring status for the health provider.
 */
export function getMonitorStatus(): {
  running: boolean;
  trackedWallets: number;
  recentBuys: number;
  emittedSignals: number;
} {
  return {
    running: isRunning,
    trackedWallets: trackedWallets.length,
    recentBuys: recentBuys.length,
    emittedSignals: emittedSignals.size,
  };
}

/**
 * Get recent buys for display/providers.
 */
export function getRecentSmartBuys(): RecentBuy[] {
  return [...recentBuys].sort((a, b) => b.timestamp - a.timestamp).slice(0, 50);
}

/**
 * Force a manual check (for CLI/chat commands).
 */
export async function forceCheck(): Promise<SmartMoneySignal[]> {
  const signals: SmartMoneySignal[] = [];
  const origCallback = onSignalCallback;
  onSignalCallback = (sig) => {
    signals.push(sig);
    if (origCallback) origCallback(sig);
  };

  await pollActivityCycle();
  onSignalCallback = origCallback;
  return signals;
}

// ── Internal: Wallet List Management ──

async function refreshWalletList(): Promise<void> {
  console.log('[smart-money] Refreshing wallet list from GMGN...');

  try {
    const qualityWallets = await getQualityWallets(
      CONFIG.MIN_WALLET_QUALITY,
      CONFIG.MAX_TRACKED_WALLETS,
    );

    if (qualityWallets.length === 0) {
      console.log('[smart-money] No wallets returned from GMGN (API may be blocked or down)');
      return;
    }

    // Preserve user-configured wallets (qualityScore=90)
    const userWallets = trackedWallets.filter(w => w.qualityScore === 90);
    const userAddrs = new Set(userWallets.map(w => w.address));

    // Build new list: user wallets first, then GMGN wallets
    const newList: TrackedWallet[] = [...userWallets];

    for (const w of qualityWallets) {
      if (!userAddrs.has(w.wallet_address)) {
        newList.push({
          address: w.wallet_address,
          qualityScore: w.qualityScore,
          winrate: w.winrate,
          pnl7d: w.pnl_7d,
          lastChecked: 0,
        });
      }
    }

    trackedWallets = newList.slice(0, CONFIG.MAX_TRACKED_WALLETS);
    console.log(`[smart-money] Tracking ${trackedWallets.length} wallets (${userWallets.length} user + ${trackedWallets.length - userWallets.length} GMGN)`);
  } catch (err) {
    console.log(`[smart-money] Wallet refresh failed: ${String(err)}`);
  }
}

// ── Internal: Activity Polling ──

async function pollActivityCycle(): Promise<void> {
  if (trackedWallets.length === 0) {
    return; // Silent — no point logging "no wallets" every 3 min
  }

  // Clean up old buys outside the cluster window
  const cutoff = Date.now() - CONFIG.CLUSTER_WINDOW_MS;
  recentBuys = recentBuys.filter(b => b.timestamp > cutoff);

  // Clean up old emitted signal keys (older than 1 hour)
  const signalCutoff = Date.now() - 3_600_000;
  for (const key of emittedSignals) {
    const ts = parseInt(key.split(':')[1] ?? '0');
    if (ts < signalCutoff) emittedSignals.delete(key);
  }

  // Sort by least recently checked, pick next batch
  const sorted = [...trackedWallets].sort((a, b) => a.lastChecked - b.lastChecked);
  const batch = sorted.slice(0, CONFIG.WALLETS_PER_CYCLE);

  // Only log every 5th cycle to avoid spam
  if (walletPollIndex % 5 === 0) {
    console.log(`[smart-money] Polling ${batch.length} wallets (cycle ${walletPollIndex}, ${recentBuys.length} recent buys tracked)...`);
  }
  walletPollIndex++;

  // Poll each wallet sequentially to stay rate-limit friendly
  for (const wallet of batch) {
    try {
      const buys = await getWalletBuys(wallet.address, CONFIG.BUYS_PER_WALLET);
      wallet.lastChecked = Date.now();

      for (const buy of buys) {
        // Only count recent buys within the cluster window
        if (buy.timestamp > cutoff) {
          // Avoid duplicates
          const buyKey = `${wallet.address}:${buy.token_address}:${buy.timestamp}`;
          const existing = recentBuys.find(b =>
            b.wallet === wallet.address &&
            b.tokenAddress === buy.token_address &&
            Math.abs(b.timestamp - buy.timestamp) < 60_000,
          );

          if (!existing) {
            recentBuys.push({
              wallet: wallet.address,
              tokenAddress: buy.token_address,
              tokenSymbol: buy.token_symbol,
              tokenName: buy.token_name,
              solAmount: buy.sol_amount,
              timestamp: buy.timestamp,
              qualityScore: wallet.qualityScore,
              winrate: wallet.winrate,
            });
          }
        }
      }
    } catch (err) {
      // Don't log every individual wallet failure — too spammy
      wallet.lastChecked = Date.now();
    }

    // Small delay between wallets
    await new Promise(r => setTimeout(r, 2_000));
  }

  // Run cluster detection
  detectClusters();
}

// ── Internal: Cluster Detection ──

function detectClusters(): void {
  // Group recent buys by token
  const tokenBuys = new Map<string, RecentBuy[]>();

  for (const buy of recentBuys) {
    const existing = tokenBuys.get(buy.tokenAddress) || [];
    existing.push(buy);
    tokenBuys.set(buy.tokenAddress, existing);
  }

  // Check each token for cluster (multiple unique wallets buying)
  for (const [tokenAddress, buys] of tokenBuys) {
    // Unique wallets
    const uniqueWallets = new Map<string, RecentBuy>();
    for (const buy of buys) {
      if (!uniqueWallets.has(buy.wallet) || buy.timestamp > uniqueWallets.get(buy.wallet)!.timestamp) {
        uniqueWallets.set(buy.wallet, buy);
      }
    }

    const walletCount = uniqueWallets.size;
    if (walletCount < CONFIG.MIN_CLUSTER_SIZE) continue;

    // Generate signal key (token + hour window to avoid spam)
    const hourKey = Math.floor(Date.now() / 3_600_000);
    const signalKey = `${tokenAddress}:${hourKey}`;
    if (emittedSignals.has(signalKey)) continue;

    // Calculate confidence
    let confidence: SmartMoneySignal['confidence'];
    if (walletCount >= 5) confidence = 'very_high';
    else if (walletCount >= 4) confidence = 'high';
    else if (walletCount >= 3) confidence = 'medium';
    else confidence = 'low';

    const walletBuys: WalletBuy[] = Array.from(uniqueWallets.values()).map(b => ({
      wallet: b.wallet,
      solAmount: b.solAmount,
      timestamp: b.timestamp,
      qualityScore: b.qualityScore,
      winrate: b.winrate,
    }));

    const totalSol = walletBuys.reduce((sum, b) => sum + b.solAmount, 0);
    const sampleBuy = buys[0];

    // Emit signal
    const signal: SmartMoneySignal = {
      tokenAddress,
      tokenSymbol: sampleBuy.tokenSymbol,
      tokenName: sampleBuy.tokenName,
      smartWalletCount: walletCount,
      walletBuys,
      totalSolInvested: totalSol,
      avgMarketCap: 0, // Will be enriched
      tokenInfo: null,
      detectedAt: Date.now(),
      confidence,
    };

    emittedSignals.add(signalKey);

    // Async enrich with token info (don't block)
    enrichAndEmit(signal);
  }
}

async function enrichAndEmit(signal: SmartMoneySignal): Promise<void> {
  try {
    const tokenInfo = await getTokenInfo(signal.tokenAddress);
    signal.tokenInfo = tokenInfo;
    if (tokenInfo) {
      signal.avgMarketCap = tokenInfo.market_cap;
      signal.tokenSymbol = tokenInfo.symbol || signal.tokenSymbol;
      signal.tokenName = tokenInfo.name || signal.tokenName;
    }
  } catch {
    // Token info is optional — proceed without it
  }

  // Safety check: skip honeypots
  if (signal.tokenInfo?.is_honeypot) {
    console.log(`[smart-money] Skipping honeypot: ${signal.tokenSymbol} (${signal.tokenAddress.slice(0, 8)}...)`);
    return;
  }

  console.log(`[smart-money] CLUSTER DETECTED: ${signal.tokenSymbol || signal.tokenAddress.slice(0, 8)} | ${signal.smartWalletCount} wallets | ${signal.totalSolInvested.toFixed(2)} SOL | ${signal.confidence} confidence`);

  if (onSignalCallback) {
    onSignalCallback(signal);
  }
}
