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
 * Volume score: 0-25
 * $0 = 0, $50k+ = 25, linear scale between.
 */
function scoreVolume(volume24h: number): number {
  const MAX_VOLUME = 50_000;
  return clamp(Math.round((volume24h / MAX_VOLUME) * 25), 0, 25);
}

/**
 * Holder score: 0-25
 * Rewards higher holder count and penalises top-10 concentration > 50%.
 * holderCount: 0-500+ maps to 0-15
 * top10Concentration: 0%-100% inverted and maps to 0-10
 */
function scoreHolders(holderCount: number, top10Concentration: number): number {
  const holderPart = clamp(Math.round((holderCount / 500) * 15), 0, 15);
  const concentrationPenalty = top10Concentration > 50
    ? Math.round(((top10Concentration - 50) / 50) * 10)
    : 0;
  const concentrationPart = 10 - clamp(concentrationPenalty, 0, 10);
  return clamp(holderPart + concentrationPart, 0, 25);
}

/**
 * Social score: 0-25
 * KOL mentions: 0 = 0, 1 = 8, 2 = 15, 3+ = 20-25
 */
function scoreSocial(kolMentions: number): number {
  if (kolMentions <= 0) return 0;
  if (kolMentions === 1) return 8;
  if (kolMentions === 2) return 15;
  if (kolMentions === 3) return 20;
  return 25;
}

/**
 * Whale score: 0-25
 * Positive net flow (buys > sells) = higher score.
 * whaleNetFlow in SOL: -100..+100 mapped to 0..25
 * Liquidity used as a confidence multiplier: < $1k liquidity caps at 10.
 */
function scoreWhale(whaleNetFlow: number, liquidityUsd: number): number {
  const normalized = clamp((whaleNetFlow + 100) / 200, 0, 1);
  let raw = Math.round(normalized * 25);
  if (liquidityUsd < 1_000) {
    raw = Math.min(raw, 10);
  }
  return clamp(raw, 0, 25);
}

function deriveConviction(total: number): SignalConviction {
  if (total >= 70) return 'high';
  if (total >= 40) return 'medium';
  return 'low';
}

export function calculateCompositeScore(params: ScoreParams): CompositeScore {
  const volumeScore = scoreVolume(params.volume24h);
  const holderScore = scoreHolders(params.holderCount, params.top10Concentration);
  const socialScore = scoreSocial(params.kolMentions);
  const whaleScore = scoreWhale(params.whaleNetFlow, params.liquidityUsd);
  const total = volumeScore + holderScore + socialScore + whaleScore;
  const conviction = deriveConviction(total);

  console.log(
    `[alpha-scout] Score breakdown: vol=${volumeScore} hold=${holderScore} soc=${socialScore} whale=${whaleScore} total=${total} conviction=${conviction}`
  );

  return { volumeScore, holderScore, socialScore, whaleScore, total, conviction };
}
