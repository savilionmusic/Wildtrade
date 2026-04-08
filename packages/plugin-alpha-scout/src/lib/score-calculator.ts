import type { CompositeScore, SignalConviction } from '@wildtrade/shared';

export interface ScoreParams {
  volume24h: number;
  holderCount: number;
  top10Concentration: number;
  kolMentions: number;
  whaleNetFlow: number;
  liquidityUsd: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Volume score: 0-20
 * $0 = 0, $50k+ = 20, linear scale between.
 */
function scoreVolume(volume24h: number): number {
  const MAX_VOLUME = 50_000;
  return clamp(Math.round((volume24h / MAX_VOLUME) * 20), 0, 20);
}

/**
 * Holder score: 0-20
 * Rewards higher holder count and penalises top-10 concentration > 50%.
 */
function scoreHolders(holderCount: number, top10Concentration: number): number {
  const holderPart = clamp(Math.round((holderCount / 500) * 12), 0, 12);
  const concentrationPenalty = top10Concentration > 50
    ? Math.round(((top10Concentration - 50) / 50) * 8)
    : 0;
  const concentrationPart = 8 - clamp(concentrationPenalty, 0, 8);
  return clamp(holderPart + concentrationPart, 0, 20);
}

/**
 * Social score: 0-25
 * KOL mentions and social signals are HIGH VALUE alpha.
 * Twitter KOL mentions count double (pre-boosted by scanner).
 * 0 = 0, 1 = 8, 2 = 16, 3 = 21, 4+ = 25
 */
function scoreSocial(kolMentions: number): number {
  if (kolMentions <= 0) return 0;
  if (kolMentions === 1) return 8;
  if (kolMentions === 2) return 16;
  if (kolMentions === 3) return 21;
  return 25;
}

/**
 * Whale score: 0-25
 * Smart money flow is the STRONGEST signal we have.
 * When whaleNetFlow is exactly 0 (unknown/not measured), return 0 — not a midpoint.
 * Positive net flow (buys > sells) = higher score.
 * SOL amounts: 1+ SOL = notable, 5+ SOL = very strong, 10+ SOL = max
 */
function scoreWhale(whaleNetFlow: number, liquidityUsd: number): number {
  // If we have no whale data, don't assume neutral — return 0
  if (whaleNetFlow === 0) return 0;

  // Direct SOL flow scoring — more intuitive than normalized
  let raw: number;
  if (whaleNetFlow >= 10) raw = 25;
  else if (whaleNetFlow >= 5) raw = 20;
  else if (whaleNetFlow >= 2) raw = 15;
  else if (whaleNetFlow >= 1) raw = 10;
  else if (whaleNetFlow > 0) raw = Math.round((whaleNetFlow / 1) * 10);
  else raw = 0; // Negative flow = sells dominating

  if (liquidityUsd < 3_000) {
    raw = Math.min(raw, 8); // Cap for very low liquidity
  }
  return clamp(raw, 0, 25);
}

/**
 * Liquidity score: 0-15
 * Measures how tradeable this token actually is.
 * < $3k = gated out in scanner (shouldn't reach here)
 * $3k-$10k = 3, $10k-$50k = 8, $50k+ = 15
 */
function scoreLiquidity(liquidityUsd: number): number {
  if (liquidityUsd < 3_000) return 0;
  if (liquidityUsd < 10_000) return 3;
  if (liquidityUsd < 50_000) return 8;
  return 15;
}

function deriveConviction(total: number): SignalConviction {
  if (total >= 60) return 'high';
  if (total >= 40) return 'medium';
  return 'low';
}

export function calculateCompositeScore(params: ScoreParams): CompositeScore {
  const volumeScore = scoreVolume(params.volume24h);
  const holderScore = scoreHolders(params.holderCount, params.top10Concentration);
  const socialScore = scoreSocial(params.kolMentions);
  const whaleScore = scoreWhale(params.whaleNetFlow, params.liquidityUsd);
  const liquidityScore = scoreLiquidity(params.liquidityUsd);
  const total = Math.min(100, volumeScore + holderScore + socialScore + whaleScore + liquidityScore);
  const conviction = deriveConviction(total);

  console.log(
    `[alpha-scout] Score breakdown: vol=${volumeScore} hold=${holderScore} soc=${socialScore} whale=${whaleScore} liq=${liquidityScore} total=${total} conviction=${conviction}`
  );

  return { volumeScore, holderScore, socialScore, whaleScore, liquidityScore, total, conviction };
}
