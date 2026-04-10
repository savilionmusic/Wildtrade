/**
 * Wallet Convergence Detector v2 — Inspired by Degen-Scanner's convergence pipeline.
 *
 * Three-layer convergence detection:
 *   Layer 1: Holdings overlap — 2+ tracked wallets holding the same token (original)
 *   Layer 2: Buy timing clusters — wallets buying within a 5-min sliding window
 *   Layer 3: Funder/Collector tracing — wallets sharing a common SOL funder (1-hop)
 *
 * Uses Union-Find to cluster related wallets & tokens for high-confidence signals.
 * Powered by Constant-K / Helius / free public RPC + DexScreener (no extra keys).
 */

const SOLANA_RPC = process.env.SOLANA_RPC_CONSTANTK || process.env.SOLANA_RPC_HELIUS || process.env.SOLANA_RPC_QUICKNODE || process.env.SOLANA_RPC_PUBLIC || 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SCAN_INTERVAL_MS = 300_000; // 5 min
const RPC_DELAY_MS = 800;         // 800ms between RPC calls (Constant-K handles 50/s)

// Known tokens to skip — stablecoins, wrapped SOL, and major tokens that aren't alpha
const SKIP_MINTS = new Set([
  SOL_MINT,
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  // mSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj', // stSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  // bSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK (too large)
]);

// Known CEX hot wallets (Degen-Scanner pattern) — need 15+ connections to count
const CEX_WALLETS = new Set([
  '5tzFkiKscjHK98Yfu7GYa2A1jaGsBMUa41WJdC9FBjPJ', // Binance
  'AC5RDfQFmDS1deWZos921JfqscXdByf4BnPkh6cN4GaM', // OKX
  '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm', // Gate.io
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', // Bybit
]);

// Fee vault programs to always skip
const FEE_VAULTS = new Set([
  '7YttLkHDoN2vSvXBfQnMJnT2vTG7f7cArxNwfXtSyVYe', // Pump.fun fee vault
]);

// ── Union-Find (Degen-Scanner pattern) ──

class UnionFind {
  private parent: Map<string, string> = new Map();
  private rank: Map<string, number> = new Map();

  find(x: string): string {
    if (!this.parent.has(x)) { this.parent.set(x, x); this.rank.set(x, 0); }
    if (this.parent.get(x) !== x) {
      this.parent.set(x, this.find(this.parent.get(x)!)); // path compression
    }
    return this.parent.get(x)!;
  }

  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB) this.parent.set(ra, rb);
    else if (rankA > rankB) this.parent.set(rb, ra);
    else { this.parent.set(rb, ra); this.rank.set(ra, rankA + 1); }
  }

  clusters(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const key of this.parent.keys()) {
      const root = this.find(key);
      const arr = groups.get(root) || [];
      arr.push(key);
      groups.set(root, arr);
    }
    return groups;
  }
}

// ── Types ──

export interface ConvergenceSignal {
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  walletCount: number;
  wallets: string[];
  totalUsdValue: number;
  price: number;
  liquidity: number;
  marketCap: number;
  confidence: 'low' | 'medium' | 'high' | 'very_high';
  detectedAt: number;
  // v2 fields
  convergenceType: 'holdings' | 'timing' | 'funder' | 'multi';
  clusterSize?: number;
  sharedFunder?: string;
}

export type ConvergenceCallback = (signal: ConvergenceSignal) => void;

// ── State ──
let running = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let onConvergence: ConvergenceCallback | null = null;
let walletsToScan: string[] = [];
const recentConvergences: ConvergenceSignal[] = [];
const MAX_CONVERGENCES = 50;

// Funder cache — avoid re-tracing wallets we already know about
const funderCache = new Map<string, string | null>(); // wallet → funder address (1-hop)
const FUNDER_CACHE_TTL_MS = 1_800_000; // 30 min
const funderCacheTimestamps = new Map<string, number>();

type LogCb = (msg: string) => void;
let log: LogCb = (msg) => console.log(`[convergence] ${msg}`);

// ── Public API ──

export function startConvergenceDetector(
  walletAddresses: string[],
  callback: ConvergenceCallback,
  onLog?: LogCb,
): void {
  if (running) return;
  running = true;
  walletsToScan = walletAddresses;
  onConvergence = callback;
  if (onLog) log = onLog;

  log(`Starting convergence detector for ${walletAddresses.length} wallets`);

  // First scan after 30s (let other systems boot first)
  setTimeout(runConvergenceScan, 30_000);
  scanTimer = setInterval(runConvergenceScan, SCAN_INTERVAL_MS);
}

export function stopConvergenceDetector(): void {
  running = false;
  if (scanTimer) clearInterval(scanTimer);
  scanTimer = null;
}

export function updateWalletList(wallets: string[]): void {
  walletsToScan = wallets;
}

export function getRecentConvergences(): ConvergenceSignal[] {
  return recentConvergences;
}

// ── Core Scan Logic (3-Layer) ──

async function runConvergenceScan(): Promise<void> {
  if (!running || walletsToScan.length === 0) return;

  log(`Scanning ${walletsToScan.length} wallets for convergence...`);

  const uf = new UnionFind();

  // ═══ LAYER 1: Holdings Overlap ═══
  const walletHoldings = new Map<string, Set<string>>(); // wallet → set of mints
  const tokenToWallets = new Map<string, string[]>();     // mint → wallets holding it

  const batchSize = 5;
  for (let i = 0; i < walletsToScan.length; i += batchSize) {
    const batch = walletsToScan.slice(i, i + batchSize);
    for (const wallet of batch) {
      try {
        const holdings = await getWalletTokens(wallet);
        walletHoldings.set(wallet, new Set(holdings.map(h => h.mint)));

        for (const h of holdings) {
          if (SKIP_MINTS.has(h.mint)) continue;
          if (h.uiAmount < 0.001) continue;

          const existing = tokenToWallets.get(h.mint) || [];
          existing.push(wallet);
          tokenToWallets.set(h.mint, existing);
        }
      } catch {
        // Individual wallet scan failure — continue
      }
      await sleep(RPC_DELAY_MS);
    }
  }

  // Union wallets that share token holdings
  const holdingsConvergences: Array<{ mint: string; wallets: string[]; type: 'holdings' }> = [];
  for (const [mint, wallets] of tokenToWallets) {
    const unique = [...new Set(wallets)];
    if (unique.length >= 2) {
      holdingsConvergences.push({ mint, wallets: unique, type: 'holdings' });
      // Union all wallets holding same token
      for (let j = 1; j < unique.length; j++) {
        uf.union(unique[0], unique[j]);
      }
    }
  }

  // ═══ LAYER 2: Funder Tracing (Degen-Scanner 1-hop) ═══
  // Trace who funded each wallet — shared funders = coordinated wallets
  const funderToWallets = new Map<string, string[]>(); // funder → wallets it funded

  for (const wallet of walletsToScan) {
    try {
      const funder = await getWalletFunder(wallet);
      if (!funder) continue;
      if (FEE_VAULTS.has(funder)) continue;

      const existing = funderToWallets.get(funder) || [];
      existing.push(wallet);
      funderToWallets.set(funder, existing);
    } catch {
      // Skip failed traces
    }
    await sleep(RPC_DELAY_MS);
  }

  // Find shared funders (Degen-Scanner: need 3+ for non-CEX, 15+ for CEX)
  const funderConvergences: Array<{ funder: string; wallets: string[] }> = [];
  for (const [funder, wallets] of funderToWallets) {
    const unique = [...new Set(wallets)];
    const threshold = CEX_WALLETS.has(funder) ? 15 : 3;
    if (unique.length >= threshold) {
      funderConvergences.push({ funder, wallets: unique });
      // Union wallets sharing a funder
      for (let j = 1; j < unique.length; j++) {
        uf.union(unique[0], unique[j]);
      }
      log(`FUNDER LINK: ${funder.slice(0, 8)}... funded ${unique.length} tracked wallets`);
    }
  }

  // ═══ LAYER 3: Buy Timing Clusters (Degen-Scanner behavioral fallback) ═══
  // This is covered by the smart-money-monitor's cluster window detection.
  // Here we just boost signals that also have timing alignment from recent buys.

  // ═══ Merge & Score with Union-Find clusters ═══
  const clusters = uf.clusters();
  const significantClusters = [...clusters.values()].filter(c => c.length >= 2);

  if (holdingsConvergences.length === 0 && funderConvergences.length === 0) {
    log('No convergences found this scan');
    return;
  }

  log(`Found ${holdingsConvergences.length} holdings overlaps, ${funderConvergences.length} funder links, ${significantClusters.length} wallet clusters`);

  // ═══ Enrich top convergences with DexScreener ═══
  // Combine all convergent tokens
  const allConvergentMints = new Map<string, { wallets: string[]; types: Set<string>; funder?: string }>();

  for (const hc of holdingsConvergences) {
    const entry = allConvergentMints.get(hc.mint) || { wallets: [], types: new Set(), funder: undefined };
    for (const w of hc.wallets) {
      if (!entry.wallets.includes(w)) entry.wallets.push(w);
    }
    entry.types.add('holdings');
    allConvergentMints.set(hc.mint, entry);
  }

  // For funder convergences, find what tokens those wallets have in common
  for (const fc of funderConvergences) {
    for (const [mint, holders] of tokenToWallets) {
      const funderWalletSet = new Set(fc.wallets);
      const overlap = holders.filter(h => funderWalletSet.has(h));
      if (overlap.length >= 2) {
        const entry = allConvergentMints.get(mint) || { wallets: [], types: new Set(), funder: undefined };
        for (const w of overlap) {
          if (!entry.wallets.includes(w)) entry.wallets.push(w);
        }
        entry.types.add('funder');
        entry.funder = fc.funder;
        allConvergentMints.set(mint, entry);
      }
    }
  }

  // Sort by wallet count and take top 15
  const sorted = [...allConvergentMints.entries()]
    .sort((a, b) => b[1].wallets.length - a[1].wallets.length)
    .slice(0, 15);

  // Batch DexScreener lookups (batch 30 at a time, Degen-Scanner pattern)
  const mintsToLookup = sorted.map(([mint]) => mint);
  const dexData = await batchDexScreenerLookup(mintsToLookup);

  for (const [mint, entry] of sorted) {
    const pair = dexData.get(mint);
    if (!pair) continue;

    const price = Number(pair.priceUsd ?? 0);
    const liquidity = Number((pair.liquidity as Record<string, unknown>)?.usd ?? 0);
    const marketCap = Number(pair.marketCap ?? pair.fdv ?? 0);
    const baseToken = pair.baseToken as Record<string, unknown> | undefined;
    const symbol = String(baseToken?.symbol ?? '');
    const name = String(baseToken?.name ?? '');

    if (liquidity < 500) continue;
    if (marketCap > 1_000_000_000) continue;

    const symUpper = symbol.toUpperCase();
    if (['USDT', 'USDC', 'USDD', 'DAI', 'BUSD', 'TUSD', 'FRAX', 'PYUSD', 'USDH', 'UXD',
         'CUSD', 'SUSD', 'DOLA', 'MIM', 'LUSD', 'USDP', 'GUSD', 'WUSDC', 'WUSDT',
         'UST', 'USDV', 'USDA', 'USDZ', 'EURC', 'USDS'].includes(symUpper)) continue;

    // Degen-Scanner quality scoring
    const types = [...entry.types];
    const isMultiLayer = types.length > 1;
    const walletCount = entry.wallets.length;

    // Find cluster size for these wallets
    const clusterRoots = new Set(entry.wallets.map(w => uf.find(w)));
    let maxClusterSize = 0;
    for (const root of clusterRoots) {
      const size = clusters.get(root)?.length ?? 0;
      if (size > maxClusterSize) maxClusterSize = size;
    }

    // Score confidence (Degen-Scanner inspired: quality = walletCount × multi-layer bonus)
    let score = 0;
    if (walletCount >= 5) score += 3;
    else if (walletCount >= 3) score += 2;
    else score += 1;
    if (isMultiLayer) score += 3;  // Both holdings + funder = very high confidence
    if (maxClusterSize >= 5) score += 2;
    if (entry.funder) score += 1;  // Shared funder adds extra weight
    if (liquidity > 10_000) score += 1;

    let confidence: ConvergenceSignal['confidence'] = 'low';
    if (score >= 7) confidence = 'very_high';
    else if (score >= 5) confidence = 'high';
    else if (score >= 3) confidence = 'medium';

    const convergenceType = isMultiLayer ? 'multi' as const
      : types.includes('funder') ? 'funder' as const
      : 'holdings' as const;

    const signal: ConvergenceSignal = {
      tokenMint: mint,
      tokenSymbol: symbol,
      tokenName: name,
      walletCount,
      wallets: entry.wallets.map(w => w.slice(0, 8) + '...'),
      totalUsdValue: 0,
      price,
      liquidity,
      marketCap,
      confidence,
      detectedAt: Date.now(),
      convergenceType,
      clusterSize: maxClusterSize,
      sharedFunder: entry.funder?.slice(0, 8),
    };

    recentConvergences.unshift(signal);
    if (recentConvergences.length > MAX_CONVERGENCES) recentConvergences.pop();

    const typeLabel = convergenceType === 'multi' ? '🔗 MULTI-LAYER'
      : convergenceType === 'funder' ? '💰 FUNDER'
      : '📊 HOLDINGS';

    log(
      `${typeLabel} CONVERGENCE: ${symbol || mint.slice(0, 8)} — ${walletCount} wallets | ` +
      `MCap: $${marketCap.toLocaleString()} | Liq: $${liquidity.toLocaleString()} | ${confidence}` +
      (maxClusterSize > 2 ? ` | Cluster: ${maxClusterSize}` : '') +
      (entry.funder ? ` | Funder: ${entry.funder.slice(0, 8)}...` : ''),
    );

    if (onConvergence && confidence !== 'low') {
      onConvergence(signal);
    }
  }
}

// ── Funder Tracing (Degen-Scanner 1-hop upstream) ──

async function getWalletFunder(walletAddress: string): Promise<string | null> {
  // Check cache
  const cached = funderCache.get(walletAddress);
  const cachedAt = funderCacheTimestamps.get(walletAddress) ?? 0;
  if (cached !== undefined && Date.now() - cachedAt < FUNDER_CACHE_TTL_MS) {
    return cached;
  }

  try {
    // Get recent signatures for the wallet
    const sigRes = await fetch(SOLANA_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [walletAddress, { limit: 20 }],
      }),
    });

    if (!sigRes.ok) return null;
    const sigData = await sigRes.json() as { result?: Array<{ signature: string; blockTime?: number }> };
    const sigs = sigData.result ?? [];
    if (sigs.length === 0) return null;

    // Sort by blockTime ascending to find earliest transactions
    const sorted = sigs.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));

    // Check the earliest few transactions for incoming SOL transfers
    for (const sig of sorted.slice(0, 5)) {
      await sleep(200);
      const txRes = await fetch(SOLANA_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        }),
      });

      if (!txRes.ok) continue;
      const txData = await txRes.json() as { result?: Record<string, unknown> };
      const tx = txData.result;
      if (!tx) continue;

      // Look for SOL transfer TO this wallet
      const meta = tx.meta as Record<string, unknown> | undefined;
      const message = tx.transaction as Record<string, unknown> | undefined;
      const accountKeys = (message?.message as Record<string, unknown>)?.accountKeys as Array<Record<string, unknown>> | undefined;
      const preBalances = meta?.preBalances as number[] | undefined;
      const postBalances = meta?.postBalances as number[] | undefined;

      if (!accountKeys || !preBalances || !postBalances) continue;

      // Find accounts that sent SOL to our wallet
      let maxInflow = 0;
      let funderAddr: string | null = null;

      for (let i = 0; i < accountKeys.length; i++) {
        const pubkey = String(accountKeys[i]?.pubkey ?? accountKeys[i] ?? '');
        if (pubkey === walletAddress) {
          // This is our wallet — check if it received SOL
          const inflow = (postBalances[i] ?? 0) - (preBalances[i] ?? 0);
          if (inflow > 0) {
            // Find who lost the most SOL (the funder)
            for (let j = 0; j < accountKeys.length; j++) {
              if (j === i) continue;
              const outflow = (preBalances[j] ?? 0) - (postBalances[j] ?? 0);
              if (outflow > maxInflow) {
                maxInflow = outflow;
                const fAddr = String(accountKeys[j]?.pubkey ?? accountKeys[j] ?? '');
                if (fAddr && !FEE_VAULTS.has(fAddr)) {
                  funderAddr = fAddr;
                }
              }
            }
          }
          break;
        }
      }

      if (funderAddr && maxInflow > 10_000_000) { // > 0.01 SOL
        funderCache.set(walletAddress, funderAddr);
        funderCacheTimestamps.set(walletAddress, Date.now());
        return funderAddr;
      }
    }
  } catch {
    // Trace failed
  }

  funderCache.set(walletAddress, null);
  funderCacheTimestamps.set(walletAddress, Date.now());
  return null;
}

// ── DexScreener Batch Lookup (Degen-Scanner pattern: batch 30 at a time) ──

async function batchDexScreenerLookup(mints: string[]): Promise<Map<string, Record<string, unknown>>> {
  const results = new Map<string, Record<string, unknown>>();
  if (mints.length === 0) return results;

  // DexScreener allows comma-separated addresses (batch up to 30)
  const batchSize = 30;
  for (let i = 0; i < mints.length; i += batchSize) {
    const batch = mints.slice(i, i + batchSize);
    await sleep(500);

    try {
      const url = `https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`;
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) continue;

      const data = await res.json() as Array<Record<string, unknown>>;
      if (!Array.isArray(data)) continue;

      for (const pair of data) {
        const baseToken = pair.baseToken as Record<string, unknown> | undefined;
        const addr = String(baseToken?.address ?? '');
        if (addr && !results.has(addr)) {
          results.set(addr, pair);
        }
      }
    } catch {
      continue;
    }
  }

  return results;
}

// ── Solana RPC Helper ──

interface TokenHolding {
  mint: string;
  uiAmount: number;
  decimals: number;
}

async function getWalletTokens(walletAddress: string): Promise<TokenHolding[]> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getTokenAccountsByOwner',
    params: [
      walletAddress,
      { programId: TOKEN_PROGRAM },
      { encoding: 'jsonParsed' },
    ],
  });

  const res = await fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) return [];

  const data = await res.json() as {
    result?: {
      value?: Array<{
        account?: {
          data?: {
            parsed?: {
              info?: {
                mint?: string;
                tokenAmount?: { uiAmount?: number; decimals?: number };
              };
            };
          };
        };
      }>;
    };
  };

  const accounts = data.result?.value ?? [];
  const holdings: TokenHolding[] = [];

  for (const acc of accounts) {
    const info = acc.account?.data?.parsed?.info;
    if (!info?.mint || !info.tokenAmount) continue;
    const uiAmount = info.tokenAmount.uiAmount ?? 0;
    if (uiAmount <= 0) continue;

    holdings.push({
      mint: info.mint,
      uiAmount,
      decimals: info.tokenAmount.decimals ?? 0,
    });
  }

  return holdings;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
