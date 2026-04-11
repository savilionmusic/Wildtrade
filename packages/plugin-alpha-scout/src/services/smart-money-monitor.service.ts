/**
 * Smart Money Monitor — WebSocket-based real-time tracking.
 *
 * Uses @solana/web3.js onLogs to monitor top wallet activity in real-time,
 * detects when multiple smart wallets buy the same token (cluster detection),
 * and emits signals to the Finder agent pipeline.
 */

import { Connection, PublicKey, type Logs } from '@solana/web3.js';
import {
  getQualityWallets,
  getTokenInfo,
  getWalletBuys,
  type GmgnTokenInfo,
} from './gmgn.service.js';
import { getMentionVelocity } from './twitter.service.js';
import { getTrackedWallets as getWalletIntelTrackedWallets } from './wallet-intelligence.service.js';

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
export type SmartMoneyBuyCallback = (buy: { wallet: string; tokenAddress: string; tokenSymbol: string; solAmount: number }) => void;

const DEFAULT_HTTP_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

function isHttpRpcEndpoint(endpoint: string | undefined): endpoint is string {
  return typeof endpoint === 'string' && /^https?:\/\//i.test(endpoint.trim());
}

function isWsRpcEndpoint(endpoint: string | undefined): endpoint is string {
  return typeof endpoint === 'string' && /^wss?:\/\//i.test(endpoint.trim());
}

function toWsRpcEndpoint(endpoint: string): string {
  if (endpoint.startsWith('https://')) return endpoint.replace('https://', 'wss://');
  if (endpoint.startsWith('http://')) return endpoint.replace('http://', 'ws://');
  return endpoint;
}

function selectHttpRpcEndpoint(): string {
  const candidates = [
    process.env.SOLANA_RPC_CONSTANTK,
    process.env.SOLANA_RPC_HTTP,
    process.env.SOLANA_RPC_URL,
    process.env.SOLANA_RPC_QUICKNODE,
  ];

  for (const candidate of candidates) {
    if (isHttpRpcEndpoint(candidate)) return candidate.trim();
  }

  return DEFAULT_HTTP_RPC_ENDPOINT;
}

function selectWsRpcEndpoint(httpEndpoint: string): string {
  const candidates = [
    process.env.SOLANA_RPC_CONSTANTK,
    process.env.SOLANA_WSS_URL,
    process.env.SOLANA_RPC_QUICKNODE,
    process.env.SOLANA_RPC_URL,
  ];

  for (const candidate of candidates) {
    if (isWsRpcEndpoint(candidate)) return candidate.trim();
  }

  const httpCandidate = candidates.find(isHttpRpcEndpoint);
  return toWsRpcEndpoint((httpCandidate ?? httpEndpoint).trim());
}

function isRpcUpgradeRequiredError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message ?? error ?? '');
  return message.includes('426') || message.toLowerCase().includes('upgrade required');
}

// ── Config ──

const CONFIG = {
  // How often to refresh and rotate subscribed wallets (5 minutes)
  WALLET_REFRESH_INTERVAL_MS: 300_000,
  // Time window for cluster detection (60 minutes)
  CLUSTER_WINDOW_MS: 3_600_000,
  // Minimum smart wallets buying same token to trigger signal
  MIN_CLUSTER_SIZE: 2,
  // Minimum wallet quality score to track
  MIN_WALLET_QUALITY: 30,
  // Maximum wallets to track
  MAX_TRACKED_WALLETS: 30,
  // Maximum WebSocket subscriptions (Constant-K Operator: heavy WS methods limited to 5/sec)
  // Web3.js blasts all active subscriptions simultaneously on reconnect, so we MUST keep the total 
  // active WS subscriptions strictly <= 5 to prevent 429 bans from Constant-K.
  MAX_WS_SUBSCRIPTIONS: 4,
  // Minimum SOL amount to consider a "buy" from log heuristics
  MIN_SOL_AMOUNT_HEURISTIC: 0.01,
  // Secondary ingest path: backfill recent buys from GMGN every 2 minutes
  GMGN_BACKFILL_INTERVAL_MS: 120_000,
  GMGN_BACKFILL_WALLETS: 8,
  // Tertiary ingest path: RPC getSignaturesForAddress polling (works when GMGN is blocked)
  RPC_POLL_INTERVAL_MS: 90_000,
  RPC_POLL_WALLETS: 6,
  HTTP_RPC_ENDPOINT: selectHttpRpcEndpoint(),
  HTTP_FALLBACK_ENDPOINT: DEFAULT_HTTP_RPC_ENDPOINT,
  HTTP_FALLBACK_COOLDOWN_MS: 10 * 60_000,
  get WS_ENDPOINT() {
    return selectWsRpcEndpoint(this.HTTP_RPC_ENDPOINT);
  },
};

// ── State ──

interface TrackedWallet {
  address: string;
  qualityScore: number;
  winrate: number;
  pnl7d: number;
  subscriptionId?: number;
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

let connection: Connection | null = null;
let trackedWallets: TrackedWallet[] = [];
let recentBuys: RecentBuy[] = [];
let onSignalCallback: SmartMoneyCallback | null = null;
let onBuyCallback: SmartMoneyBuyCallback | null = null;
let walletRefreshTimer: ReturnType<typeof setInterval> | null = null;
let gmgnBackfillTimer: ReturnType<typeof setInterval> | null = null;
let rpcPollTimer: ReturnType<typeof setInterval> | null = null;
let isRunning = false;
let wsRotationOffset = 0;
let fallbackHttpConnection: Connection | null = null;
let fallbackHttpUntil = 0;

// ── Rate Limiter ──
let activeRpcCalls = 0;
const rpcQueue: Array<() => Promise<void>> = [];
const queuedSignatures = new Set<string>();
const processedSignatures: string[] = [];
const processedSignatureSet = new Set<string>();
const MAX_PROCESSED_SIGNATURES = 3000;

async function enqueueGetParsedTransaction(signature: string): Promise<any> {
  if (!signature || queuedSignatures.has(signature) || processedSignatureSet.has(signature)) {
    return null;
  }

  return new Promise((resolve, reject) => {
    queuedSignatures.add(signature);
    rpcQueue.push(async () => {
      try {
        if (!connection) return resolve(null);
        const tx = await withHttpRpcFallback((rpcConnection) => rpcConnection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }));
        processedSignatureSet.add(signature);
        processedSignatures.push(signature);
        if (processedSignatures.length > MAX_PROCESSED_SIGNATURES) {
          const old = processedSignatures.shift();
          if (old) processedSignatureSet.delete(old);
        }
        resolve(tx);
      } catch (err: any) {
        reject(err);
      } finally {
        queuedSignatures.delete(signature);
      }
    });
    processRpcQueue();
  });
}

async function processRpcQueue() {
  if (activeRpcCalls >= 1 || rpcQueue.length === 0) return; // Strict max 1 concurrent to respect heavy limits
  activeRpcCalls++;
  
  const task = rpcQueue.shift();
  if (task) {
    try {
      await task();
    } catch(e) {}
  }
  
  // Wait 250ms between parsed tx checks to stay strictly under 5/sec limit
  setTimeout(() => {
    activeRpcCalls--;
    processRpcQueue();
  }, 250);
}

function getFallbackHttpConnection(): Connection {
  if (!fallbackHttpConnection) {
    fallbackHttpConnection = new Connection(CONFIG.HTTP_FALLBACK_ENDPOINT, {
      commitment: 'confirmed',
      fetch: global.fetch,
    });
  }

  return fallbackHttpConnection;
}

function isFallbackHttpActive(): boolean {
  return Date.now() < fallbackHttpUntil;
}

function activateFallbackHttp(reason: string): void {
  const wasActive = isFallbackHttpActive();
  fallbackHttpUntil = Date.now() + CONFIG.HTTP_FALLBACK_COOLDOWN_MS;

  if (!wasActive) {
    console.log(`[smart-money] HTTP RPC fallback active for ${Math.round(CONFIG.HTTP_FALLBACK_COOLDOWN_MS / 60000)}min: ${reason}`);
  }
}

async function withHttpRpcFallback<T>(operation: (rpcConnection: Connection) => Promise<T>): Promise<T> {
  if (!connection) {
    throw new Error('Smart money connection is not initialized');
  }

  const primaryConnection = isFallbackHttpActive() ? getFallbackHttpConnection() : connection;

  try {
    return await operation(primaryConnection);
  } catch (error) {
    if (!isFallbackHttpActive() && isRpcUpgradeRequiredError(error)) {
      activateFallbackHttp('primary RPC returned HTTP 426 Upgrade Required');
      return operation(getFallbackHttpConnection());
    }

    throw error;
  }
}

// Track which signals we've already emitted to avoid duplicates
const emittedSignals = new Set<string>();

// ── Public API ──

/**
 * Start the smart money monitor using WebSockets.
 * @param onSignal - Callback when a cluster is detected
 * @param userWallets - Optional extra wallets from user config
 */
export async function startSmartMoneyMonitor(
  onSignal: SmartMoneyCallback,
  userWallets?: string[],
  onBuy?: SmartMoneyBuyCallback,
): Promise<void> {
  if (isRunning) {
    console.log('[smart-money] Monitor already running');
    return;
  }

  isRunning = true;
  onSignalCallback = onSignal;
  onBuyCallback = onBuy ?? null;
  connection = new Connection(CONFIG.HTTP_RPC_ENDPOINT, {
    wsEndpoint: CONFIG.WS_ENDPOINT,
    commitment: 'confirmed',
    fetch: global.fetch,
  });

  if (CONFIG.HTTP_RPC_ENDPOINT === DEFAULT_HTTP_RPC_ENDPOINT) {
    console.log('[smart-money] No dedicated HTTP RPC configured; polling will use public Solana RPC until a private HTTP endpoint is supplied.');
  }

  console.log('[smart-money] Starting WSS smart money monitor...');
  console.log(`[smart-money] Config: cluster window ${CONFIG.CLUSTER_WINDOW_MS / 60000}min, min cluster size ${CONFIG.MIN_CLUSTER_SIZE}`);

  if (userWallets && userWallets.length > 0) {
    for (const addr of userWallets) {
      trackedWallets.push({
        address: addr,
        qualityScore: 90,
        winrate: 0,
        pnl7d: 0,
      });
    }
  }

  await refreshWalletSubscriptions();

  // Secondary ingest path for reliability when WSS parsing misses buys.
  backfillRecentBuysFromGmgn().catch(err => {
    console.log(`[smart-money] GMGN backfill startup error: ${String(err)}`);
  });
  gmgnBackfillTimer = setInterval(() => {
    backfillRecentBuysFromGmgn().catch(err => {
      console.log(`[smart-money] GMGN backfill error: ${String(err)}`);
    });
  }, CONFIG.GMGN_BACKFILL_INTERVAL_MS);

  // Tertiary ingest path — poll RPC directly (works even when GMGN is blocked by Cloudflare)
  pollRecentTxFromRpc().catch(err => {
    console.log(`[smart-money] RPC poll startup error: ${String(err)}`);
  });
  rpcPollTimer = setInterval(() => {
    pollRecentTxFromRpc().catch(err => {
      console.log(`[smart-money] RPC poll error: ${String(err)}`);
    });
  }, CONFIG.RPC_POLL_INTERVAL_MS);

  walletRefreshTimer = setInterval(() => {
    refreshWalletSubscriptions().catch(err => {
      console.log(`[smart-money] Wallet refresh error: ${String(err)}`);
    });
  }, CONFIG.WALLET_REFRESH_INTERVAL_MS);

  console.log(`[smart-money] Monitor started.`);
}

/**
 * Stop the monitor and unsubscribe from all logs.
 */
export function stopSmartMoneyMonitor(): void {
  if (walletRefreshTimer) clearInterval(walletRefreshTimer);
  walletRefreshTimer = null;
  if (gmgnBackfillTimer) clearInterval(gmgnBackfillTimer);
  gmgnBackfillTimer = null;
  if (rpcPollTimer) clearInterval(rpcPollTimer);
  rpcPollTimer = null;
  isRunning = false;
  onSignalCallback = null;

  if (connection) {
    for (const wallet of trackedWallets) {
      if (wallet.subscriptionId !== undefined) {
        connection.removeOnLogsListener(wallet.subscriptionId).catch(() => {});
        wallet.subscriptionId = undefined;
      }
    }
  }
  connection = null;
  fallbackHttpConnection = null;
  fallbackHttpUntil = 0;
  console.log('[smart-money] Monitor stopped');
}

async function backfillRecentBuysFromGmgn(): Promise<void> {
  if (!isRunning || trackedWallets.length === 0) return;

  const wallets = [...trackedWallets]
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, CONFIG.GMGN_BACKFILL_WALLETS);

  let added = 0;

  for (const wallet of wallets) {
    const buys = await getWalletBuys(wallet.address, 5);
    if (!buys || buys.length === 0) continue;

    const cutoff = Date.now() - CONFIG.CLUSTER_WINDOW_MS;
    recentBuys = recentBuys.filter(b => b.timestamp > cutoff);

    for (const buy of buys) {
      if (!buy?.token_address || buy.event_type !== 'buy') continue;
      if (buy.timestamp < cutoff) continue;

      const existing = recentBuys.find(b =>
        b.wallet === wallet.address &&
        b.tokenAddress === buy.token_address &&
        Math.abs(b.timestamp - buy.timestamp) < 60_000,
      );

      if (existing) continue;

      const sym = buy.token_symbol || buy.token_address.slice(0, 6);
      const solAmt = Number(buy.sol_amount || 0);
      recentBuys.push({
        wallet: wallet.address,
        tokenAddress: buy.token_address,
        tokenSymbol: sym,
        tokenName: buy.token_name || buy.token_address,
        solAmount: solAmt,
        timestamp: buy.timestamp,
        qualityScore: wallet.qualityScore,
        winrate: wallet.winrate,
      });
      if (onBuyCallback) onBuyCallback({ wallet: wallet.address, tokenAddress: buy.token_address, tokenSymbol: sym, solAmount: solAmt });
      added++;
    }
  }

  if (added > 0) {
    console.log(`[smart-money] GMGN backfill added ${added} recent buys`);
    detectClusters();
  }
}

/**
 * Tertiary ingest: poll RPC getSignaturesForAddress → getParsedTransaction
 * for tracked wallets. Works even when GMGN is Cloudflare-blocked.
 * Respects Constant-K heavy method limits (250ms between calls).
 */
const rpcPollLastSig = new Map<string, string>();

async function pollRecentTxFromRpc(): Promise<void> {
  if (!isRunning || !connection || trackedWallets.length === 0) return;

  // Pick top N wallets by quality, rotate offset to cover different wallets over time
  const sorted = [...trackedWallets].sort((a, b) => b.qualityScore - a.qualityScore);
  const wallets = sorted.slice(0, CONFIG.RPC_POLL_WALLETS);

  let added = 0;
  const cutoff = Date.now() - CONFIG.CLUSTER_WINDOW_MS;

  for (const wallet of wallets) {
    try {
      // Rate limit: 250ms between heavy RPC calls
      await new Promise(r => setTimeout(r, 250));

      const opts: any = { limit: 5, commitment: 'confirmed' };
      const lastSig = rpcPollLastSig.get(wallet.address);
      if (lastSig) opts.until = lastSig;

      const sigs = await withHttpRpcFallback((rpcConnection) => rpcConnection.getSignaturesForAddress(
        new PublicKey(wallet.address),
        opts,
      ));

      if (!sigs || sigs.length === 0) continue;

      // Remember newest signature for next poll
      rpcPollLastSig.set(wallet.address, sigs[0].signature);

      for (const sig of sigs) {
        if (sig.err) continue; // skip failed txs
        if (processedSignatureSet.has(sig.signature)) continue;

        // Rate limit between parsed tx calls
        await new Promise(r => setTimeout(r, 300));

        const tx = await enqueueGetParsedTransaction(sig.signature);
        if (!tx || !tx.meta) continue;

        // Find wallet's account index (flexible key format)
        const accountIndex = tx.transaction.message.accountKeys.findIndex((k: any) => {
          const raw = k?.pubkey ?? k;
          if (!raw) return false;
          if (typeof raw === 'string') return raw === wallet.address;
          if (typeof raw?.toBase58 === 'function') return raw.toBase58() === wallet.address;
          return String(raw) === wallet.address;
        });
        if (accountIndex === -1) continue;

        const preSol = tx.meta.preBalances[accountIndex];
        const postSol = tx.meta.postBalances[accountIndex];
        const solSpent = (preSol - postSol) / 1e9;

        // Find token increase
        const postTokenBalances = tx.meta.postTokenBalances || [];
        const preTokenBalances = tx.meta.preTokenBalances || [];
        let boughtMint = '';
        let maxInc = 0;

        for (const post of postTokenBalances) {
          const postOwner = String((post as any).owner ?? '');
          if (postOwner === wallet.address) {
            const pre = preTokenBalances.find(
              (p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint
            );
            const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0;
            const postAmt = Number(post.uiTokenAmount.uiAmount || 0);
            const inc = postAmt - preAmt;
            if (inc > 0 && inc > maxInc) {
              maxInc = inc;
              boughtMint = post.mint;
            }
          }
        }

        if (!boughtMint) continue;
        if (boughtMint === 'So11111111111111111111111111111111111111112') continue;
        if (solSpent < CONFIG.MIN_SOL_AMOUNT_HEURISTIC) continue;

        const ts = sig.blockTime ? sig.blockTime * 1000 : Date.now();
        if (ts < cutoff) continue;

        // Deduplicate against existing buys
        const dup = recentBuys.find(b =>
          b.wallet === wallet.address &&
          b.tokenAddress === boughtMint &&
          Math.abs(b.timestamp - ts) < 60_000,
        );
        if (dup) continue;

        recentBuys = recentBuys.filter(b => b.timestamp > cutoff);

        const sym = boughtMint.slice(0, 6);
        recentBuys.push({
          wallet: wallet.address,
          tokenAddress: boughtMint,
          tokenSymbol: sym,
          tokenName: boughtMint,
          solAmount: solSpent,
          timestamp: ts,
          qualityScore: wallet.qualityScore,
          winrate: wallet.winrate,
        });
        if (onBuyCallback) onBuyCallback({ wallet: wallet.address, tokenAddress: boughtMint, tokenSymbol: sym, solAmount: solSpent });
        added++;

        // Async enrich symbol
        getTokenInfo(boughtMint).then(info => {
          if (info) {
            const buy = recentBuys.find(b => b.tokenAddress === boughtMint && b.wallet === wallet.address && b.timestamp === ts);
            if (buy) {
              buy.tokenSymbol = info.symbol || buy.tokenSymbol;
              buy.tokenName = info.name || buy.tokenName;
            }
          }
        }).catch(() => {});
      }
    } catch (err: any) {
      if (!err?.message?.includes('429')) {
        console.log(`[smart-money] RPC poll error for ${wallet.address.slice(0, 8)}: ${String(err)}`);
      }
    }
  }

  if (added > 0) {
    console.log(`[smart-money] RPC poll found ${added} recent buys`);
    detectClusters();
  }
}

/**
 * Get current monitoring status for the health provider.
 */
export function getMonitorStatus(): {
  running: boolean;
  trackedWallets: number;
  activeWsSubscriptions: number;
  wsSubscriptionCap: number;
  recentBuys: number;
  emittedSignals: number;
} {
  return {
    running: isRunning,
    trackedWallets: trackedWallets.length,
    activeWsSubscriptions: trackedWallets.filter(w => w.subscriptionId !== undefined).length,
    wsSubscriptionCap: CONFIG.MAX_WS_SUBSCRIPTIONS,
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
 * Get the current list of tracked wallet addresses (for passing to Helius, convergence, etc.).
 */
export function getTrackedWalletAddresses(): string[] {
  return trackedWallets.map(w => w.address);
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

  detectClusters();
  
  onSignalCallback = origCallback;
  return signals;
}

// ── Internal: Wallet List & Subscription Management ──

async function refreshWalletSubscriptions(): Promise<void> {
  console.log('[smart-money] Refreshing wallet list from GMGN and updating WSS subscriptions...');

  try {
    const qualityWallets = await getQualityWallets(
      CONFIG.MIN_WALLET_QUALITY,
      CONFIG.MAX_TRACKED_WALLETS,
    );

    const userWallets = trackedWallets.filter(w => w.qualityScore === 90);
    const intelWallets = getWalletIntelTrackedWallets()
      .slice(0, CONFIG.MAX_TRACKED_WALLETS)
      .map(w => ({
        address: w.address,
        qualityScore: Math.max(70, Math.min(95, Math.round(w.bes || 75))),
        winrate: w.winRate ?? 0,
        pnl7d: 0,
      }));

    let effectiveUserWallets = [...userWallets];
    const seeded = new Set(effectiveUserWallets.map(w => w.address));
    for (const w of intelWallets) {
      if (!seeded.has(w.address)) {
        effectiveUserWallets.push(w);
        seeded.add(w.address);
      }
    }

    if (qualityWallets.length === 0 && effectiveUserWallets.length === 0) {
      console.log('[smart-money] No wallets found (GMGN blocked and wallet-intel not seeded yet)');
      return;
    }

    const userAddrs = new Set(effectiveUserWallets.map(w => w.address));

    const newList: TrackedWallet[] = [...effectiveUserWallets];

    for (const w of qualityWallets) {
      if (!userAddrs.has(w.wallet_address)) {
        newList.push({
          address: w.wallet_address,
          qualityScore: w.qualityScore,
          winrate: w.winrate,
          pnl7d: w.pnl_7d,
        });
      }
    }

    const nextTracked = newList.slice(0, CONFIG.MAX_TRACKED_WALLETS);
    
    // Unsubscribe removed wallets
    const nextAddrs = new Set(nextTracked.map(w => w.address));
    for (const w of trackedWallets) {
      if (!nextAddrs.has(w.address) && w.subscriptionId !== undefined && connection) {
        connection.removeOnLogsListener(w.subscriptionId).catch(() => {});
      }
    }

    // Subscribe wallets — cap at MAX_WS_SUBSCRIPTIONS to respect provider limits.
    // Rotate which wallets get WSS slots so inactive wallets do not starve coverage.
    // Stagger subscriptions: Constant-K Operator limits heavy WS methods to 5/sec
    const rotatedTracked = nextTracked.length > 0
      ? nextTracked.map((_, idx) => nextTracked[(idx + wsRotationOffset) % nextTracked.length])
      : nextTracked;
    if (nextTracked.length > 0) {
      wsRotationOffset = (wsRotationOffset + CONFIG.MAX_WS_SUBSCRIPTIONS) % nextTracked.length;
    }

    let wsCount = 0;
    for (const w of rotatedTracked) {
      const existing = trackedWallets.find(t => t.address === w.address);
      if (existing && existing.subscriptionId !== undefined) {
        if (wsCount < CONFIG.MAX_WS_SUBSCRIPTIONS) {
          w.subscriptionId = existing.subscriptionId;
          wsCount++;
        } else if (connection) {
          connection.removeOnLogsListener(existing.subscriptionId).catch(() => {});
        }
      } else if (connection && wsCount < CONFIG.MAX_WS_SUBSCRIPTIONS) {
        // Stagger: wait 500ms between logsSubscribe calls (max 2/sec, well under 5/sec heavy limit)
        if (wsCount > 0) await new Promise(r => setTimeout(r, 500));
        try {
          w.subscriptionId = connection.onLogs(
            new PublicKey(w.address),
            (logs, ctx) => handleWalletLogs(w, logs),
            'confirmed'
          );
          wsCount++;
        } catch (err) {
          console.error(`[smart-money] Failed to subscribe to ${w.address}:`, err);
        }
      }
      // Wallets beyond the WS cap are still tracked but rely on convergence polling
    }

    trackedWallets = nextTracked;
    console.log(`[smart-money] Tracking ${trackedWallets.length} wallets total, ${wsCount} via WSS`);
    const activeWsWallets = trackedWallets
      .filter(w => w.subscriptionId !== undefined)
      .slice(0, CONFIG.MAX_WS_SUBSCRIPTIONS)
      .map(w => `${w.address.slice(0, 8)}...`);
    console.log(`[smart-money] Active WSS wallets: ${activeWsWallets.join(', ') || 'none'}`);
  } catch (err) {
    console.log(`[smart-money] Wallet refresh failed: ${String(err)}`);
  }
}

// ── Internal: WSS Log Handling ──

async function handleWalletLogs(wallet: TrackedWallet, logs: Logs): Promise<void> {
  if (logs.err || !Array.isArray(logs.logs)) return; // Ignore failed transactions

  // Basic heuristic: Is it a Raydium or Pump.fun interact?
  const isSwap = logs.logs.some((log: string) => 
    log.includes('Program log: Instruction: Swap') || 
    log.includes('Program log: Instruction: Route') ||
    log.includes('Program 6EF8rrecthR5Dkzon8YargZYa8m4CjHExuC5M62bV2gL invoke') || // pump.fun target 
    log.includes('Program log: Instruction: Buy')
  );

  // If logs don't explicitly look like swaps, we still allow parsed-tx fallback for compatibility.
  // This catches routers that don't emit the exact instruction strings above.

  try {
    if (!connection) return;
    
    // Delay slightly to ensure RPC has the parsed tx ready
    await new Promise(r => setTimeout(r, 2000));
    
    const maxRetries = 3;
    let tx = null;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            tx = await enqueueGetParsedTransaction(logs.signature);
            if (tx) break;
        } catch (e: any) {
            if (e?.message?.includes('429')) {
                // Backoff and retry silently
                await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
                continue;
            }
            throw e;
        }
        if (!tx) await new Promise(r => setTimeout(r, 2000));
    }

    if (!tx || !tx.meta) return;

    // We only care about SOL going OUT (to buy) and Tokens coming IN.
    // Extremely simplified heuristic for alpha/speed.
    
    // Find pre/post SOL balances for the wallet (support both string and PublicKey/object key formats)
    const accountIndex = tx.transaction.message.accountKeys.findIndex((k: any) => {
      const raw = k?.pubkey ?? k;
      if (!raw) return false;
      if (typeof raw === 'string') return raw === wallet.address;
      if (typeof raw?.toBase58 === 'function') return raw.toBase58() === wallet.address;
      return String(raw) === wallet.address;
    });
    if (accountIndex === -1) return;

    const preSol = tx.meta.preBalances[accountIndex];
    const postSol = tx.meta.postBalances[accountIndex];
    const solSpent = (preSol - postSol) / 1e9; // in SOL

    // Find token that increased in balance
    const preTokenBalances = tx.meta.preTokenBalances || [];
    const postTokenBalances = tx.meta.postTokenBalances || [];
    
    let boughtTokenMint = '';
    let maxIncrease = 0;

    for (const post of postTokenBalances) {
      const postOwner = String((post as any).owner ?? '');
      if (postOwner === wallet.address) {
        const pre = preTokenBalances.find(
          p => p.accountIndex === post.accountIndex && p.mint === post.mint
        );
        const preAmt = pre ? Number(pre.uiTokenAmount.uiAmount || 0) : 0;
        const postAmt = Number(post.uiTokenAmount.uiAmount || 0);
        
        const increase = postAmt - preAmt;
        if (increase > 0 && increase > maxIncrease) {
          maxIncrease = increase;
          boughtTokenMint = post.mint;
        }
      }
    }

    if (!boughtTokenMint) return;

    // Keep tiny-gas noise out unless logs strongly indicate a swap route.
    if (!isSwap && solSpent < CONFIG.MIN_SOL_AMOUNT_HEURISTIC) return;

    // Avoid Wrapped SOL
    if (boughtTokenMint === 'So11111111111111111111111111111111111111112') return;

    // Record the buy
    const cutoff = Date.now() - CONFIG.CLUSTER_WINDOW_MS;
    recentBuys = recentBuys.filter(b => b.timestamp > cutoff);

    // Check duplicate
    const existing = recentBuys.find(b =>
      b.wallet === wallet.address &&
      b.tokenAddress === boughtTokenMint &&
      Math.abs(b.timestamp - Date.now()) < 60_000,
    );

    if (!existing) {
      console.log(`[smart-money] WSS: Wallet ${wallet.address.slice(0, 6)} bought ${boughtTokenMint.slice(0, 6)}... (${solSpent.toFixed(2)} SOL)`);
      
      // Async enrich token name symbol just so UI looks nice, but don't block
      getTokenInfo(boughtTokenMint).then(info => {
        let symbol = info?.symbol || boughtTokenMint.slice(0, 6);
        let name = info?.name || boughtTokenMint;
        
        recentBuys.push({
          wallet: wallet.address,
          tokenAddress: boughtTokenMint,
          tokenSymbol: symbol,
          tokenName: name,
          solAmount: solSpent,
          timestamp: Date.now(),
          qualityScore: wallet.qualityScore,
          winrate: wallet.winrate,
        });
        
        if (onBuyCallback) onBuyCallback({ wallet: wallet.address, tokenAddress: boughtTokenMint, tokenSymbol: symbol, solAmount: solSpent });
        detectClusters();
      }).catch(() => {
        recentBuys.push({
          wallet: wallet.address,
          tokenAddress: boughtTokenMint,
          tokenSymbol: boughtTokenMint.slice(0, 6),
          tokenName: boughtTokenMint,
          solAmount: solSpent,
          timestamp: Date.now(),
          qualityScore: wallet.qualityScore,
          winrate: wallet.winrate,
        });
        
        if (onBuyCallback) onBuyCallback({ wallet: wallet.address, tokenAddress: boughtTokenMint, tokenSymbol: boughtTokenMint.slice(0, 6), solAmount: solSpent });
        detectClusters();
      });
    }

  } catch (err: any) {
    if (err?.message?.includes('429')) {
      // Very silent drop for 429 if all retries exhausted, don't spam terminal
    } else {
      console.error(`[smart-money] Failed to parsed WSS transaction ${logs.signature}:`, err);
    }
  }
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

    // Heatmap Velocity bypass
    const isHighVelocity = getMentionVelocity(tokenAddress) >= 3;

    // Generate signal key (token + hour window to avoid spam)
    const hourKey = Math.floor(Date.now() / 3_600_000);
    const signalKey = `${tokenAddress}:${hourKey}`;
    if (!isHighVelocity && emittedSignals.has(signalKey)) continue;

    const walletBuys: WalletBuy[] = Array.from(uniqueWallets.values()).map(b => ({
      wallet: b.wallet,
      solAmount: b.solAmount,
      timestamp: b.timestamp,
      qualityScore: b.qualityScore,
      winrate: b.winrate,
    }));

    const totalSol = walletBuys.reduce((sum, b) => sum + b.solAmount, 0);

    // Calculate confidence — enhanced with SOL invested weighting
    let confidence: SmartMoneySignal['confidence'];
    if (walletCount >= 5) confidence = 'very_high';
    else if (walletCount >= 4) confidence = 'high';
    else if (walletCount >= 3) confidence = 'high';
    else if (walletCount >= 2 && totalSol >= 3) confidence = 'medium';
    else if (walletCount >= 2) confidence = 'low';
    else confidence = 'low'; // fallback

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
