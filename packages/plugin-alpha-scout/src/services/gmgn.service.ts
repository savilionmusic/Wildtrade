/**
 * GMGN.ai Client — Free-tier friendly, rate-limited, cached.
 *
 * Uses undocumented GMGN REST API to fetch:
 *   - Top smart money wallet rankings
 *   - Wallet activity (recent buys)
 *   - Smart money trades on specific tokens
 *   - Token info and safety data
 *
 * All calls are cached aggressively and rate-limited to stay within
 * free/anonymous usage limits. No API key required.
 */

// ── Types ──

export interface GmgnWallet {
  wallet_address: string;
  realized_profit: number;
  unrealized_profit: number;
  pnl_7d: number;
  pnl_30d: number;
  winrate: number;
  total_profit_pnl: number;
  buy: number;
  sell: number;
  token_num: number;
  pnl_2x_5x_num: number;
  pnl_gt_5x_num: number;
  last_active_timestamp: number;
  tags: string[];
  sol_balance: number;
}

export interface GmgnWalletTrade {
  wallet_address: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  event_type: 'buy' | 'sell';
  sol_amount: number;
  token_amount: number;
  price_usd: number;
  timestamp: number;
  market_cap: number;
}

export interface GmgnTokenInfo {
  address: string;
  symbol: string;
  name: string;
  price: number;
  market_cap: number;
  liquidity: number;
  volume_24h: number;
  holder_count: number;
  smart_buy_24h: number;
  smart_sell_24h: number;
  smart_degen_count: number;
  rug_ratio: number;
  is_honeypot: boolean;
}

// ── Rate Limiter (simple token bucket) ──

const RATE_LIMIT = {
  maxRequests: 3,       // max 3 requests
  windowMs: 10_000,     // per 10 seconds — very conservative for free tier
};

let requestTimestamps: number[] = [];

async function waitForRateLimit(): Promise<void> {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < RATE_LIMIT.windowMs);

  if (requestTimestamps.length >= RATE_LIMIT.maxRequests) {
    const oldestInWindow = requestTimestamps[0];
    const waitMs = RATE_LIMIT.windowMs - (now - oldestInWindow) + 100;
    console.log(`[gmgn] Rate limit: waiting ${waitMs}ms`);
    await new Promise(r => setTimeout(r, waitMs));
  }

  requestTimestamps.push(Date.now());
}

// ── Cache ──

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string, ttlMs: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache<T>(key: string, data: T): void {
  cache.set(key, { data, timestamp: Date.now() });
}

// ── HTTP Client ──

const BASE_URL = 'https://gmgn.ai';

const HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://gmgn.ai/',
  'Origin': 'https://gmgn.ai',
};

// Track whether we've already warned about GMGN being blocked
let gmgn403Warned = false;

async function gmgnFetch<T>(path: string): Promise<T | null> {
  await waitForRateLimit();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const res = await fetch(`${BASE_URL}${path}`, {
      headers: HEADERS,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      if (res.status === 403 && !gmgn403Warned) {
        console.log(`[gmgn] API blocked by Cloudflare (403) — using curated wallets instead. This is normal.`);
        gmgn403Warned = true;
      } else if (res.status !== 403) {
        console.log(`[gmgn] API error ${res.status} for ${path}`);
      }
      return null;
    }

    // Reset warning flag if we get a successful response
    gmgn403Warned = false;

    const json = await res.json() as Record<string, unknown>;

    // GMGN wraps responses in { code: 0, data: ... }
    if (json.code === 0 && json.data) {
      return json.data as T;
    }

    // Some endpoints return data directly
    return json as T;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('abort')) {
      // Timeout — don't spam
    } else {
      console.log(`[gmgn] Fetch error: ${message}`);
    }
    return null;
  }
}

// ── Public API ──

const WALLET_CACHE_TTL = 3_600_000;    // 1 hour — wallet lists don't change fast
const ACTIVITY_CACHE_TTL = 120_000;     // 2 min — activity needs fresher data
const TOKEN_CACHE_TTL = 300_000;        // 5 min — token info

/**
 * Fetch top smart money wallets ranked by PnL.
 * @param timeframe - '1d' | '7d' | '30d'
 * @param tag - 'smart_degen' | 'pump_smart' | 'renowned'
 * @param limit - Max wallets to return (default 30)
 */
export async function getTopWallets(
  timeframe: '1d' | '7d' | '30d' = '7d',
  tag: string = 'smart_degen',
  limit: number = 30,
): Promise<GmgnWallet[]> {
  const cacheKey = `wallets:${tag}:${timeframe}`;
  const cached = getCached<{ rank: GmgnWallet[] }>(cacheKey, WALLET_CACHE_TTL);
  if (cached?.rank) return cached.rank.slice(0, limit);

  const path = `/defi/quotation/v1/rank/sol/wallets/${timeframe}?tag=${tag}&orderby=pnl_${timeframe}&direction=desc&limit=${limit}`;
  const data = await gmgnFetch<{ rank: GmgnWallet[] }>(path);

  if (data?.rank) {
    setCache(cacheKey, data);
    console.log(`[gmgn] Fetched ${data.rank.length} top wallets (${tag}, ${timeframe})`);
    return data.rank.slice(0, limit);
  }

  return [];
}

/**
 * Fetch recent buy activity for a specific wallet.
 */
export async function getWalletBuys(
  walletAddress: string,
  limit: number = 10,
): Promise<GmgnWalletTrade[]> {
  const cacheKey = `activity:${walletAddress}`;
  const cached = getCached<GmgnWalletTrade[]>(cacheKey, ACTIVITY_CACHE_TTL);
  if (cached) return cached;

  const path = `/defi/quotation/v1/wallet_activity/sol?type=buy&wallet=${walletAddress}&limit=${limit}&cost=10`;
  const data = await gmgnFetch<{ activities?: GmgnWalletTrade[] }>(path);

  const activities = data?.activities ?? [];

  // Normalize
  const trades: GmgnWalletTrade[] = activities.map((a: Record<string, unknown>) => ({
    wallet_address: walletAddress,
    token_address: String(a.token_address ?? a.mint ?? ''),
    token_symbol: String(a.token_symbol ?? a.symbol ?? ''),
    token_name: String(a.token_name ?? a.name ?? ''),
    event_type: 'buy' as const,
    sol_amount: Number(a.sol_amount ?? a.cost ?? 0),
    token_amount: Number(a.token_amount ?? a.amount ?? 0),
    price_usd: Number(a.price_usd ?? a.price ?? 0),
    timestamp: Number(a.timestamp ?? a.block_time ?? Date.now() / 1000) * 1000,
    market_cap: Number(a.market_cap ?? 0),
  }));

  if (trades.length > 0) {
    setCache(cacheKey, trades);
  }

  return trades;
}

/**
 * Fetch smart money trades (buys) for a specific token.
 */
export async function getSmartMoneyTradesForToken(
  tokenAddress: string,
  limit: number = 20,
): Promise<GmgnWalletTrade[]> {
  const cacheKey = `sm-trades:${tokenAddress}`;
  const cached = getCached<GmgnWalletTrade[]>(cacheKey, ACTIVITY_CACHE_TTL);
  if (cached) return cached;

  const path = `/defi/quotation/v1/trades/sol/${tokenAddress}?limit=${limit}&maker=&tag[]=smart_degen&tag[]=pump_smart`;
  const data = await gmgnFetch<{ trades?: unknown[] }>(path);

  const trades: GmgnWalletTrade[] = (data?.trades ?? []).map((t: unknown) => {
    const tx = t as Record<string, unknown>;
    return {
      wallet_address: String(tx.maker ?? tx.wallet ?? ''),
      token_address: tokenAddress,
      token_symbol: String(tx.token_symbol ?? ''),
      token_name: String(tx.token_name ?? ''),
      event_type: String(tx.event ?? tx.type ?? 'buy') as 'buy' | 'sell',
      sol_amount: Number(tx.sol_amount ?? tx.quote_amount ?? 0),
      token_amount: Number(tx.token_amount ?? tx.base_amount ?? 0),
      price_usd: Number(tx.price_usd ?? tx.price ?? 0),
      timestamp: Number(tx.timestamp ?? tx.block_time ?? Date.now() / 1000) * 1000,
      market_cap: Number(tx.market_cap ?? 0),
    };
  });

  if (trades.length > 0) {
    setCache(cacheKey, trades);
  }

  return trades;
}

/**
 * Fetch token info including smart money stats and safety.
 */
export async function getTokenInfo(tokenAddress: string): Promise<GmgnTokenInfo | null> {
  const cacheKey = `token:${tokenAddress}`;
  const cached = getCached<GmgnTokenInfo>(cacheKey, TOKEN_CACHE_TTL);
  if (cached) return cached;

  const path = `/defi/quotation/v1/tokens/sol/${tokenAddress}`;
  const data = await gmgnFetch<{ token?: Record<string, unknown> }>(path);

  if (!data?.token) return null;

  const t = data.token;
  const info: GmgnTokenInfo = {
    address: tokenAddress,
    symbol: String(t.symbol ?? ''),
    name: String(t.name ?? ''),
    price: Number(t.price ?? 0),
    market_cap: Number(t.market_cap ?? 0),
    liquidity: Number(t.liquidity ?? 0),
    volume_24h: Number(t.volume_24h ?? 0),
    holder_count: Number(t.holder_count ?? 0),
    smart_buy_24h: Number(t.smart_buy_24h ?? 0),
    smart_sell_24h: Number(t.smart_sell_24h ?? 0),
    smart_degen_count: Number(t.smart_degen_count ?? 0),
    rug_ratio: Number(t.rug_ratio ?? 0),
    is_honeypot: Boolean(t.is_honeypot ?? false),
  };

  setCache(cacheKey, info);
  return info;
}

/**
 * Score a wallet's quality for filtering.
 * Returns 0-100 based on win rate, PnL, big wins, and memecoin focus.
 * Heavily favors pump_smart wallets that trade low-cap memecoins.
 */
export function scoreWallet(wallet: GmgnWallet): number {
  let score = 0;

  // Win rate (0-25 points)
  score += Math.min(25, wallet.winrate * 25);

  // 7d PnL positive = good (0-15 points)
  if (wallet.pnl_7d > 0) {
    score += Math.min(15, wallet.pnl_7d * 4);
  }

  // Big win count — memecoins produce big multiples (0-20 points)
  score += Math.min(10, wallet.pnl_2x_5x_num * 2);
  score += Math.min(10, wallet.pnl_gt_5x_num * 3);

  // Activity recency (0-15 points) — active in last 24h = max
  const hoursSinceActive = (Date.now() - wallet.last_active_timestamp * 1000) / 3_600_000;
  if (hoursSinceActive < 1) score += 15;
  else if (hoursSinceActive < 6) score += 12;
  else if (hoursSinceActive < 24) score += 8;
  else if (hoursSinceActive < 72) score += 4;

  // Trade volume — moderate volume preferred (degen, not institutional) (0-10 points)
  score += Math.min(10, (wallet.buy + wallet.sell) * 0.08);

  // MEMECOIN FOCUS BONUS (0-15 points)
  // pump_smart tag = the wallet trades PumpFun tokens
  const isPumpSmart = wallet.tags?.includes('pump_smart');
  if (isPumpSmart) score += 15;

  // Penalize wallets with very high SOL balance — likely buying big-cap blue chips
  if (wallet.sol_balance > 500) score -= 10;
  else if (wallet.sol_balance > 200) score -= 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Get filtered, high-quality smart money wallets.
 * Fetches from GMGN, scores each, returns those above threshold.
 * Falls back to curated wallets if GMGN API is blocked (403).
 */
export async function getQualityWallets(
  minScore: number = 40,
  limit: number = 50,
): Promise<Array<GmgnWallet & { qualityScore: number }>> {
  // Fetch pump_smart FIRST (PumpFun memecoin traders) — these are our priority.
  // smart_degen is secondary — may include big-cap traders we'll filter via scoring.
  const [pumpSmart, degens] = await Promise.all([
    getTopWallets('7d', 'pump_smart', 40),
    getTopWallets('7d', 'smart_degen', 20),
  ]);

  // Deduplicate by address — pump_smart wallets are added first to preserve priority
  const seen = new Set<string>();
  const all: GmgnWallet[] = [];
  for (const w of [...pumpSmart, ...degens]) {
    if (!seen.has(w.wallet_address)) {
      seen.add(w.wallet_address);
      all.push(w);
    }
  }

  // If GMGN returned nothing (403/blocked), use curated fallback wallets
  if (all.length === 0) {
    console.log('[gmgn] GMGN API blocked — using curated smart money wallets');
    return CURATED_SMART_WALLETS.slice(0, limit).map(addr => ({
      wallet_address: addr,
      realized_profit: 0,
      unrealized_profit: 0,
      pnl_7d: 1,
      pnl_30d: 1,
      winrate: 0.6,
      total_profit_pnl: 1,
      buy: 50,
      sell: 30,
      token_num: 20,
      pnl_2x_5x_num: 5,
      pnl_gt_5x_num: 2,
      last_active_timestamp: Math.floor(Date.now() / 1000),
      tags: ['curated'],
      sol_balance: 0,
      qualityScore: 60,
    }));
  }

  // Score and filter
  const scored = all
    .map(w => ({ ...w, qualityScore: scoreWallet(w) }))
    .filter(w => w.qualityScore >= minScore)
    .sort((a, b) => b.qualityScore - a.qualityScore)
    .slice(0, limit);

  console.log(`[gmgn] Quality wallets: ${scored.length}/${all.length} passed score >= ${minScore}`);
  return scored;
}

/**
 * Curated memecoin wallets — PumpFun/micro-cap focused.
 * Used as fallback when GMGN API is blocked by Cloudflare.
 * These wallets are discovered dynamically via wallet-intelligence.
 * An empty list forces the system to rely on DexScreener wallet discovery
 * (which now only discovers wallets from 10k-500k mcap tokens).
 */
const CURATED_SMART_WALLETS: string[] = [
  // Leave empty — discovered wallets from wallet-intelligence are better
  // than stale addresses. The system falls through to wallet-intel discovery
  // which finds profitable traders on live memecoin-range tokens.
];
