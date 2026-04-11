import { Connection, PublicKey } from '@solana/web3.js';
import { selectPrimaryHttpRpcEndpoint } from '@wildtrade/shared';
import type { SolanaService } from '@wildtrade/plugin-solana-compat';
import { schedule } from '@wildtrade/plugin-solana-compat';

export interface TokenRiskSnapshot {
  mintAddress: string;
  fetchedAt: number;
  source: 'rpc' | 'solana-service';
  topHolderPct: number;
  top10HolderPct: number;
  holderCountTop20: number;
  totalSupply: number | null;
  circulatingSupply: number | null;
  liquidityUsd: number;
  volume1h: number;
  marketCapUsd: number;
  volumeToLiquidity: number;
  trustScore: number;
  riskScore: number;
  rewardScore: number;
  riskFlags: string[];
  strengthSignals: string[];
}

const CACHE_TTL_MS = 120_000;

let rpcConnection: Connection | null = null;
let solanaServiceRef: SolanaService | null = null;

const riskCache = new Map<string, { expiresAt: number; data: TokenRiskSnapshot }>();

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'bigint') {
    return Number(value);
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (value && typeof value === 'object' && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getConnection(): Connection {
  if (rpcConnection) return rpcConnection;

  rpcConnection = new Connection(selectPrimaryHttpRpcEndpoint(), {
    commitment: 'confirmed',
    fetch: global.fetch,
  });

  return rpcConnection;
}

async function getSupplyMetrics(mintAddress: string, connection: Connection): Promise<{ totalSupply: number | null; circulatingSupply: number | null }> {
  let totalSupply: number | null = null;

  try {
    await schedule('read');
    const supplyResponse = await connection.getTokenSupply(new PublicKey(mintAddress), 'confirmed');
    totalSupply = toFiniteNumber(supplyResponse.value.uiAmount);
  } catch {
    totalSupply = null;
  }

  return { totalSupply, circulatingSupply: null };
}

export function resetRpcConnection(): void {
  rpcConnection = null;
}

export function setSolanaService(svc: SolanaService | null): void {
  solanaServiceRef = svc;
}

export function getSolanaService(): SolanaService | null {
  return solanaServiceRef;
}

export async function getTokenRiskSnapshot(params: {
  mintAddress: string;
  liquidityUsd: number;
  volume1h: number;
  marketCapUsd: number;
  priceChange5m?: number;
  priceChange1h?: number;
  force?: boolean;
}): Promise<TokenRiskSnapshot> {
  const now = Date.now();
  const cacheKey = params.mintAddress;
  const cached = riskCache.get(cacheKey);

  if (!params.force && cached && cached.expiresAt > now) {
    return cached.data;
  }

  const connection = getConnection();
  const mint = new PublicKey(params.mintAddress);

  let topHolderPct = 0;
  let top10HolderPct = 0;
  let holderCountTop20 = 0;
  let dataSource: 'rpc' | 'solana-service' = 'rpc';

  const { totalSupply, circulatingSupply } = await getSupplyMetrics(params.mintAddress, connection);

  // Use SolanaService for enriched circulating supply when available
  let enrichedCirculatingSupply = circulatingSupply;
  if (solanaServiceRef) {
    try {
      const solCirc = await solanaServiceRef.getCirculatingSupply(params.mintAddress);
      if (solCirc > 0) {
        enrichedCirculatingSupply = solCirc;
        dataSource = 'solana-service';
      }
    } catch { /* fall through to RPC data */ }
  }

  try {
    await schedule('read');
    const largestAccounts = await connection.getTokenLargestAccounts(mint, 'confirmed');
    const nonZeroAccounts = largestAccounts.value.filter((account) => Number(account.uiAmount ?? 0) > 0);
    holderCountTop20 = nonZeroAccounts.length;

    const denominator = totalSupply && totalSupply > 0
      ? totalSupply
      : nonZeroAccounts.reduce((sum, account) => sum + Number(account.uiAmount ?? 0), 0);

    if (denominator > 0) {
      const top1Amount = Number(nonZeroAccounts[0]?.uiAmount ?? 0);
      const top10Amount = nonZeroAccounts
        .slice(0, 10)
        .reduce((sum, account) => sum + Number(account.uiAmount ?? 0), 0);

      topHolderPct = (top1Amount / denominator) * 100;
      top10HolderPct = (top10Amount / denominator) * 100;
    }
  } catch {
    holderCountTop20 = 0;
  }

  const liquidityUsd = Math.max(0, params.liquidityUsd);
  const volume1h = Math.max(0, params.volume1h);
  const marketCapUsd = Math.max(0, params.marketCapUsd);
  const volumeToLiquidity = liquidityUsd > 0 ? volume1h / liquidityUsd : 0;
  const priceChange5m = Number(params.priceChange5m ?? 0);
  const priceChange1h = Number(params.priceChange1h ?? 0);

  let trustScore = 55;
  let riskScore = 35;
  let rewardScore = 45;

  const riskFlags: string[] = [];
  const strengthSignals: string[] = [];

  // Concentration scoring is intentionally conservative because LP vaults can appear as top holders.
  if (topHolderPct >= 35) {
    riskScore += 28;
    trustScore -= 22;
    rewardScore -= 10;
    riskFlags.push('single_wallet_concentration');
  } else if (topHolderPct >= 20) {
    riskScore += 14;
    trustScore -= 10;
    riskFlags.push('elevated_top_holder');
  } else if (topHolderPct > 0) {
    trustScore += 6;
    strengthSignals.push('top_holder_distribution_ok');
  }

  if (top10HolderPct >= 75) {
    riskScore += 24;
    trustScore -= 18;
    rewardScore -= 8;
    riskFlags.push('top10_cabal_risk');
  } else if (top10HolderPct >= 55) {
    riskScore += 10;
    trustScore -= 8;
    riskFlags.push('top10_concentration_watch');
  } else if (top10HolderPct > 0) {
    trustScore += 8;
    rewardScore += 4;
    strengthSignals.push('top10_distribution_healthy');
  }

  if (holderCountTop20 > 0 && holderCountTop20 < 8) {
    riskScore += 10;
    trustScore -= 7;
    riskFlags.push('thin_holder_base');
  } else if (holderCountTop20 >= 15) {
    trustScore += 4;
    strengthSignals.push('broad_top20_holder_base');
  }

  if (liquidityUsd < 10_000) {
    riskScore += 18;
    trustScore -= 14;
    rewardScore -= 12;
    riskFlags.push('thin_liquidity');
  } else if (liquidityUsd < 30_000) {
    riskScore += 8;
    trustScore -= 4;
    riskFlags.push('moderate_liquidity');
  } else if (liquidityUsd >= 75_000) {
    trustScore += 8;
    rewardScore += 10;
    strengthSignals.push('healthy_liquidity');
  }

  if (volumeToLiquidity < 0.15) {
    riskScore += 12;
    trustScore -= 8;
    rewardScore -= 10;
    riskFlags.push('weak_turnover');
  } else if (volumeToLiquidity < 0.35) {
    riskScore += 6;
    rewardScore -= 4;
    riskFlags.push('soft_turnover');
  } else if (volumeToLiquidity >= 0.8) {
    trustScore += 8;
    rewardScore += 16;
    strengthSignals.push('strong_turnover');
  }

  if (marketCapUsd > 0 && liquidityUsd > 0) {
    const liquidityBackingRatio = liquidityUsd / marketCapUsd;
    if (liquidityBackingRatio < 0.03) {
      riskScore += 10;
      trustScore -= 6;
      riskFlags.push('weak_liquidity_backing');
    } else if (liquidityBackingRatio >= 0.12) {
      trustScore += 6;
      rewardScore += 6;
      strengthSignals.push('strong_liquidity_backing');
    }
  }

  if (priceChange5m <= -12 && priceChange1h <= -20) {
    riskScore += 10;
    rewardScore -= 8;
    riskFlags.push('momentum_breakdown');
  } else if (priceChange5m >= 8 && priceChange1h >= 15) {
    trustScore += 4;
    rewardScore += 10;
    strengthSignals.push('momentum_expansion');
  }

  if (circulatingSupply !== null && totalSupply !== null && totalSupply > 0) {
    const floatRatio = circulatingSupply / totalSupply;
    if (floatRatio > 0 && floatRatio < 0.6) {
      riskScore += 6;
      trustScore -= 4;
      riskFlags.push('limited_circulating_float');
    }
  }

  // Also check enriched circulating supply from SolanaService
  if (enrichedCirculatingSupply !== null && enrichedCirculatingSupply !== circulatingSupply && totalSupply !== null && totalSupply > 0) {
    const enrichedFloat = enrichedCirculatingSupply / totalSupply;
    if (enrichedFloat > 0 && enrichedFloat < 0.5) {
      riskScore += 4;
      riskFlags.push('enriched_float_low');
    }
  }

  trustScore = clamp(trustScore, 0, 100);
  riskScore = clamp(riskScore, 0, 100);
  rewardScore = clamp(rewardScore, 0, 100);

  const snapshot: TokenRiskSnapshot = {
    mintAddress: params.mintAddress,
    fetchedAt: now,
    source: dataSource,
    topHolderPct,
    top10HolderPct,
    holderCountTop20,
    totalSupply,
    circulatingSupply: enrichedCirculatingSupply ?? circulatingSupply,
    liquidityUsd,
    volume1h,
    marketCapUsd,
    volumeToLiquidity,
    trustScore,
    riskScore,
    rewardScore,
    riskFlags,
    strengthSignals,
  };

  riskCache.set(cacheKey, {
    expiresAt: now + CACHE_TTL_MS,
    data: snapshot,
  });

  return snapshot;
}

/**
 * Check if a creator/dev wallet still holds tokens of a given mint.
 * Returns the token balance (UI amount) or null if lookup fails.
 * Uses rate-limited RPC to avoid burning through Constant-K budget.
 */
const devBalanceCache = new Map<string, { balance: number; expiresAt: number }>();

export async function getCreatorTokenBalance(
  creatorAddress: string,
  mintAddress: string,
): Promise<number | null> {
  const cacheKey = `${creatorAddress}:${mintAddress}`;
  const cached = devBalanceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.balance;

  try {
    const connection = getConnection();
    await schedule('read');
    const accounts = await connection.getTokenAccountsByOwner(
      new PublicKey(creatorAddress),
      { mint: new PublicKey(mintAddress) },
      'confirmed',
    );

    let balance = 0;
    for (const acc of accounts.value) {
      const data = acc.account.data;
      // SPL Token account: amount is at offset 64, 8 bytes LE
      if (data.length >= 72) {
        const raw = data.readBigUInt64LE(64);
        balance += Number(raw);
      }
    }

    // Convert raw amount — assume 6 decimals (most SPL tokens) if we don't know
    const uiBalance = balance / 1e6;
    devBalanceCache.set(cacheKey, { balance: uiBalance, expiresAt: Date.now() + 60_000 });
    return uiBalance;
  } catch {
    return null;
  }
}