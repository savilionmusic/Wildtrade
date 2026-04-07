/**
 * DexScreener Service — Free, no API key required.
 *
 * Fetches trending tokens and new Solana pairs from DexScreener public API.
 * Rate-limited to stay within free tier (300 req/min).
 */

// ── Types ──

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number; m5: number };
  priceChange: { h24: number; h6: number; h1: number; m5: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  pairCreatedAt: number;
  txns: { h24: { buys: number; sells: number }; h6: { buys: number; sells: number } };
}

export interface TrendingToken {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  priceChange24h: number;
  pairAge: number; // ms since pair created
  buyTxns24h: number;
  sellTxns24h: number;
  dexId: string;
}

// ── Rate limiter ──

let lastCallTime = 0;
const MIN_INTERVAL_MS = 1_000; // 1 req/sec to be easy on APIs

async function rateLimitedFetch(url: string): Promise<Response | null> {
  const now = Date.now();
  const wait = MIN_INTERVAL_MS - (now - lastCallTime);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastCallTime = Date.now();

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.log(`[dexscreener] API error ${res.status} for ${url}`);
      return null;
    }
    return res;
  } catch (err) {
    console.log(`[dexscreener] Fetch error: ${String(err)}`);
    return null;
  }
}

// ── Cache ──

const cache = new Map<string, { data: unknown; expiresAt: number }>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown, ttlMs: number = 120_000): void {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ── Public API ──

/**
 * Get token pairs by mint address.
 */
export async function getTokenPairs(mint: string): Promise<DexPair[]> {
  const cacheKey = `pairs:${mint}`;
  const cached = getCached<DexPair[]>(cacheKey);
  if (cached) return cached;

  const res = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  if (!res) return [];

  const data = (await res.json()) as { pairs?: DexPair[] };
  const pairs = (data.pairs ?? []).filter(p => p.chainId === 'solana');
  setCache(cacheKey, pairs, 60_000);
  return pairs;
}

/**
 * Search for tokens by keyword.
 */
export async function searchTokens(query: string, limit: number = 10): Promise<DexPair[]> {
  const cacheKey = `search:${query}`;
  const cached = getCached<DexPair[]>(cacheKey);
  if (cached) return cached;

  const res = await rateLimitedFetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`);
  if (!res) return [];

  const data = (await res.json()) as { pairs?: DexPair[] };
  const pairs = (data.pairs ?? []).filter(p => p.chainId === 'solana').slice(0, limit);
  setCache(cacheKey, pairs, 120_000);
  return pairs;
}

/**
 * Get the latest new Solana pairs (new launches).
 * Uses the token profiles/boosted endpoint for trending.
 */
export async function getNewSolanaPairs(): Promise<TrendingToken[]> {
  const cacheKey = 'new-pairs';
  const cached = getCached<TrendingToken[]>(cacheKey);
  if (cached) return cached;

  // DexScreener latest pairs for Solana
  const res = await rateLimitedFetch('https://api.dexscreener.com/latest/dex/pairs/solana');
  if (!res) return [];

  const data = (await res.json()) as { pairs?: DexPair[] };
  const pairs = data.pairs ?? [];

  const tokens = pairs
    .filter(p => p.liquidity?.usd > 500 && p.volume?.h24 > 100) // minimal quality filter
    .map(pairToTrending)
    .slice(0, 30);

  setCache(cacheKey, tokens, 120_000); // 2 min cache
  return tokens;
}

/**
 * Get trending/boosted tokens from DexScreener.
 */
export async function getTrendingTokens(): Promise<TrendingToken[]> {
  const cacheKey = 'trending';
  const cached = getCached<TrendingToken[]>(cacheKey);
  if (cached) return cached;

  const res = await rateLimitedFetch('https://api.dexscreener.com/token-boosts/top/v1');
  if (!res) return [];

  const data = (await res.json()) as Array<{ chainId: string; tokenAddress: string; description?: string; amount?: number }>;
  const solTokens = data.filter(t => t.chainId === 'solana');

  // Fetch pair data for each trending token (max 5 to stay rate-limited)
  const tokens: TrendingToken[] = [];
  for (const t of solTokens.slice(0, 5)) {
    const pairs = await getTokenPairs(t.tokenAddress);
    if (pairs.length > 0) {
      tokens.push(pairToTrending(pairs[0]));
    }
  }

  setCache(cacheKey, tokens, 180_000); // 3 min cache
  return tokens;
}

// ── Helpers ──

function pairToTrending(pair: DexPair): TrendingToken {
  return {
    mint: pair.baseToken.address,
    symbol: pair.baseToken.symbol,
    name: pair.baseToken.name,
    priceUsd: parseFloat(pair.priceUsd) || 0,
    volume24h: pair.volume?.h24 ?? 0,
    liquidity: pair.liquidity?.usd ?? 0,
    marketCap: pair.marketCap ?? pair.fdv ?? 0,
    priceChange24h: pair.priceChange?.h24 ?? 0,
    pairAge: Date.now() - (pair.pairCreatedAt ?? Date.now()),
    buyTxns24h: pair.txns?.h24?.buys ?? 0,
    sellTxns24h: pair.txns?.h24?.sells ?? 0,
    dexId: pair.dexId ?? '',
  };
}
