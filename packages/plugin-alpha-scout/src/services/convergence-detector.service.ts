/**
 * Wallet Convergence Detector — Scans what tokens smart money wallets hold,
 * finds overlapping positions, and scores tokens by how many top wallets converge.
 *
 * Uses FREE Solana public RPC (getTokenAccountsByOwner) + DexScreener for prices.
 * No API keys needed.
 *
 * Flow:
 *   1. Every 5 min, scan a batch of tracked wallets
 *   2. Build a map: tokenMint → [wallet addresses holding it]
 *   3. When 2+ wallets converge on the same token → high-confidence signal
 *   4. Score by: number of wallets × total USD value × token age
 */

const SOLANA_RPC = process.env.SOLANA_RPC_HELIUS || process.env.SOLANA_RPC_PUBLIC || 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const SCAN_INTERVAL_MS = 300_000; // 5 min
const RPC_DELAY_MS = 1_500;       // 1.5s between RPC calls (stay under rate limit)

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
}

export type ConvergenceCallback = (signal: ConvergenceSignal) => void;

// ── State ──
let running = false;
let scanTimer: ReturnType<typeof setInterval> | null = null;
let onConvergence: ConvergenceCallback | null = null;
let walletsToScan: string[] = [];
const recentConvergences: ConvergenceSignal[] = [];
const MAX_CONVERGENCES = 50;

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

// ── Core Scan Logic ──

async function runConvergenceScan(): Promise<void> {
  if (!running || walletsToScan.length === 0) return;

  log(`Scanning ${walletsToScan.length} wallets for convergence...`);

  // 1. Get token holdings for each wallet
  const walletHoldings = new Map<string, Set<string>>(); // wallet → set of mints
  const tokenToWallets = new Map<string, string[]>();     // mint → wallets holding it

  // Scan in batches of 5 to respect rate limits
  const batchSize = 5;
  for (let i = 0; i < walletsToScan.length; i += batchSize) {
    const batch = walletsToScan.slice(i, i + batchSize);

    for (const wallet of batch) {
      try {
        const holdings = await getWalletTokens(wallet);
        walletHoldings.set(wallet, new Set(holdings.map(h => h.mint)));

        for (const h of holdings) {
          if (h.mint === SOL_MINT) continue; // Skip SOL itself
          if (h.uiAmount < 0.001) continue;  // Skip dust

          const existing = tokenToWallets.get(h.mint) || [];
          existing.push(wallet);
          tokenToWallets.set(h.mint, existing);
        }
      } catch (err) {
        // Individual wallet scan failure — continue
      }

      await sleep(RPC_DELAY_MS);
    }
  }

  // 2. Find convergences (2+ wallets holding same token)
  const convergences: Array<{ mint: string; wallets: string[] }> = [];
  for (const [mint, wallets] of tokenToWallets) {
    if (wallets.length >= 2) {
      convergences.push({ mint, wallets: [...new Set(wallets)] });
    }
  }

  if (convergences.length === 0) {
    log('No convergences found this scan');
    return;
  }

  log(`Found ${convergences.length} tokens held by 2+ wallets`);

  // 3. Get prices from DexScreener (batch up to 30 at a time)
  const top = convergences
    .sort((a, b) => b.wallets.length - a.wallets.length)
    .slice(0, 15); // Focus on top 15

  for (const conv of top) {
    await sleep(1500);

    try {
      const dexRes = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${conv.mint}`,
        { headers: { 'Accept': 'application/json' } },
      );

      if (!dexRes.ok) continue;

      const dexData = await dexRes.json() as { pairs?: Array<Record<string, unknown>> };
      const pair = dexData.pairs?.[0];
      if (!pair) continue;

      const price = Number(pair.priceUsd ?? 0);
      const liquidity = Number((pair.liquidity as Record<string, unknown>)?.usd ?? 0);
      const marketCap = Number(pair.marketCap ?? pair.fdv ?? 0);
      const baseToken = pair.baseToken as Record<string, unknown> | undefined;
      const symbol = String(baseToken?.symbol ?? '');
      const name = String(baseToken?.name ?? '');

      // Skip very low liquidity tokens
      if (liquidity < 500) continue;

      // Score confidence
      let confidence: ConvergenceSignal['confidence'] = 'low';
      if (conv.wallets.length >= 5) confidence = 'very_high';
      else if (conv.wallets.length >= 3) confidence = 'high';
      else if (conv.wallets.length >= 2 && liquidity > 5000) confidence = 'medium';

      const signal: ConvergenceSignal = {
        tokenMint: conv.mint,
        tokenSymbol: symbol,
        tokenName: name,
        walletCount: conv.wallets.length,
        wallets: conv.wallets.map(w => w.slice(0, 8) + '...'),
        totalUsdValue: 0, // We'd need per-wallet token amounts for this
        price,
        liquidity,
        marketCap,
        confidence,
        detectedAt: Date.now(),
      };

      recentConvergences.unshift(signal);
      if (recentConvergences.length > MAX_CONVERGENCES) recentConvergences.pop();

      log(
        `CONVERGENCE: ${symbol || conv.mint.slice(0, 8)} — ${conv.wallets.length} wallets | ` +
        `MCap: $${marketCap.toLocaleString()} | Liq: $${liquidity.toLocaleString()} | ${confidence}`,
      );

      if (onConvergence && confidence !== 'low') {
        onConvergence(signal);
      }
    } catch {
      continue;
    }
  }
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
