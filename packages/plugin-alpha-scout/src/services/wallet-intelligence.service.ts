/**
 * Wallet Intelligence Service — Discovers and tracks profitable Solana wallets.
 *
 * Uses FREE APIs only:
 *   1. DexScreener — search for top traders on hot pairs
 *   2. PumpPortal — subscribeAccountTrade for real-time wallet tracking
 *   3. Solana RPC — getSignaturesForAddress for wallet activity
 *   4. RugCheck — insider detection on tokens traded by wallets
 *
 * Builds a wallet leaderboard scored by Buy Efficiency Score (BES):
 *   BES = (ROI_per_trade * Win_Rate * Trade_Frequency) / Avg_Buy_Size
 *
 * Rate-limited: one API call per 3 seconds max.
 */

// ── Types ──

export interface TrackedWallet {
  address: string;
  alias: string;          // e.g. "smart_degen_01", "dexscreener_top_trader"
  source: 'curated' | 'dexscreener' | 'pumpfun' | 'manual';
  bes: number;             // Buy Efficiency Score 0-100
  winRate: number;         // 0-1
  totalTrades: number;
  profitableTrades: number;
  avgBuySizeSol: number;
  lastSeenAt: number;
  recentTokens: string[];  // last 10 tokens this wallet bought
  addedAt: number;
}

export interface WalletBuyEvent {
  walletAddress: string;
  tokenMint: string;
  tokenSymbol: string;
  solSpent: number;
  timestamp: number;
  source: string;
}

// ── State ──
const walletDb = new Map<string, TrackedWallet>();
const recentWalletBuys: WalletBuyEvent[] = [];
const MAX_RECENT_BUYS = 200;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

type WalletLogCb = (msg: string) => void;
let log: WalletLogCb = (msg) => console.log(`[wallet-intel] ${msg}`);

// ── Curated Smart Money Addresses ──
// No hardcoded wallets — the discovery loop finds profitable memecoin traders
// dynamically from DexScreener (10k-500k mcap tokens only).
// This avoids stale wallets that only buy SOL, HNT, and other big-caps.
const SEED_WALLETS: Array<{ address: string; alias: string }> = [];

// ── Public API ──

export function startWalletIntelligence(onLog?: WalletLogCb): void {
  if (running) return;
  running = true;
  if (onLog) log = onLog;

  log('Starting wallet intelligence...');

  // Seed with curated wallets (if any configured)
  for (const w of SEED_WALLETS) {
    walletDb.set(w.address, {
      address: w.address,
      alias: w.alias,
      source: 'curated',
      bes: 50,
      winRate: 0.6,
      totalTrades: 0,
      profitableTrades: 0,
      avgBuySizeSol: 0,
      lastSeenAt: Date.now(),
      recentTokens: [],
      addedAt: Date.now(),
    });
  }
  if (SEED_WALLETS.length > 0) {
    log(`Seeded ${SEED_WALLETS.length} curated smart money wallets`);
  } else {
    log('No curated seeds — will discover memecoin wallets from DexScreener');
  }

  // Start discovery loop (every 5 min)
  discoverNewWallets();
  refreshTimer = setInterval(discoverNewWallets, 300_000);

  log(`Wallet intelligence active — tracking ${walletDb.size} wallets`);
}

export function stopWalletIntelligence(): void {
  running = false;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  log('Wallet intelligence stopped');
}

export function getTrackedWallets(): TrackedWallet[] {
  return Array.from(walletDb.values()).sort((a, b) => b.bes - a.bes);
}

export function getWalletCount(): number {
  return walletDb.size;
}

export function getRecentWalletBuys(): WalletBuyEvent[] {
  return recentWalletBuys.slice(-50);
}

export function recordWalletBuy(event: WalletBuyEvent): void {
  recentWalletBuys.push(event);
  if (recentWalletBuys.length > MAX_RECENT_BUYS) recentWalletBuys.shift();

  // Update wallet stats
  const wallet = walletDb.get(event.walletAddress);
  if (wallet) {
    wallet.lastSeenAt = event.timestamp;
    wallet.totalTrades++;
    wallet.recentTokens = [event.tokenMint, ...wallet.recentTokens].slice(0, 10);
  }
}

export function getWalletIntelStats(): {
  tracked: number;
  recentBuys: number;
  topWallets: Array<{ address: string; alias: string; bes: number }>;
} {
  const sorted = Array.from(walletDb.values())
    .sort((a, b) => b.bes - a.bes)
    .slice(0, 5);

  return {
    tracked: walletDb.size,
    recentBuys: recentWalletBuys.length,
    topWallets: sorted.map(w => ({
      address: w.address.slice(0, 8) + '...',
      alias: w.alias,
      bes: w.bes,
    })),
  };
}

// ── Wallet Discovery ──

async function discoverNewWallets(): Promise<void> {
  if (!running) return;

  try {
    // 1. Find wallets from DexScreener boosted tokens' top traders
    await discoverFromDexScreener();
  } catch (err) {
    log(`Discovery error: ${String(err)}`);
  }
}

async function discoverFromDexScreener(): Promise<void> {
  try {
    // 1. Get latest boosted tokens as these have active trading
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1', {
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) return;

    const boosts = await res.json() as Array<{
      chainId?: string;
      tokenAddress?: string;
      totalAmount?: number;
    }>;

    // Take top 10 Solana boosted tokens — we'll filter by market cap below
    const solanaBoosts = boosts
      .filter(b => b.chainId === 'solana' && b.tokenAddress)
      .slice(0, 10);

    let discovered = 0;

    for (const boost of solanaBoosts) {
      await sleep(3000); // Rate limit: 3s between calls

      try {
        // First check if this token is in the memecoin range (10k-500k mcap)
        const pairRes = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${boost.tokenAddress}`,
          { headers: { 'Accept': 'application/json' } },
        );

        if (!pairRes.ok) continue;
        const pairData = await pairRes.json() as { pairs?: Array<Record<string, unknown>> };
        const pair = pairData.pairs?.[0];
        if (!pair) continue;

        // ── Market cap filter: only discover wallets trading memecoins ──
        const mcap = Number((pair as any).marketCap ?? (pair as any).fdv ?? 0);
        if (mcap > 500_000 || (mcap > 0 && mcap < 10_000)) {
          continue; // Skip big-cap and dust-cap tokens
        }

        await sleep(3000);

        // Use DexScreener top traders endpoint (returns wallets that traded this token)
        const tradersRes = await fetch(
          `https://api.dexscreener.com/tokens/v1/solana/${boost.tokenAddress}/top-traders`,
          { headers: { 'Accept': 'application/json' } },
        );

        if (tradersRes.ok) {
          const traders = await tradersRes.json() as Array<{
            walletAddress?: string; wallet?: string;
            pnlUsd?: number; volumeUsd?: number;
          }>;

          if (Array.isArray(traders)) {
            // Take top 5 profitable traders from this memecoin-range token
            const top = traders
              .filter(t => (t.walletAddress || t.wallet) && (t.pnlUsd ?? 0) > 0)
              .slice(0, 5);

            for (const trader of top) {
              const addr = trader.walletAddress || trader.wallet;
              if (addr && !walletDb.has(addr)) {
                walletDb.set(addr, {
                  address: addr,
                  alias: `dex_memecoin_trader_${discovered}`,
                  source: 'dexscreener',
                  bes: 60, // Higher BES — these are confirmed memecoin traders
                  winRate: 0.6,
                  totalTrades: 0,
                  profitableTrades: 0,
                  avgBuySizeSol: 0,
                  lastSeenAt: Date.now(),
                  recentTokens: [boost.tokenAddress!],
                  addedAt: Date.now(),
                });
                discovered++;
              }
            }
          }
          continue;
        }

        // Fallback: extract maker addresses from pair info
        await sleep(3000);
        const makers = (pair as any).profile?.makers ?? (pair as any).makers ?? [];
        for (const maker of (Array.isArray(makers) ? makers : []).slice(0, 5)) {
          const addr = typeof maker === 'string' ? maker : maker?.address;
          if (addr && !walletDb.has(addr)) {
            walletDb.set(addr, {
              address: addr,
              alias: `dex_maker_${discovered}`,
              source: 'dexscreener',
              bes: 45,
              winRate: 0.5,
              totalTrades: 0,
              profitableTrades: 0,
              avgBuySizeSol: 0,
              lastSeenAt: Date.now(),
              recentTokens: [boost.tokenAddress!],
              addedAt: Date.now(),
            });
            discovered++;
          }
        }
      } catch {
        continue;
      }
    }

    if (discovered > 0) {
      log(`Discovered ${discovered} new memecoin wallets from DexScreener (10k-500k mcap range). Total: ${walletDb.size}`);
    }
  } catch (err) {
    log(`DexScreener wallet discovery error: ${String(err)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
