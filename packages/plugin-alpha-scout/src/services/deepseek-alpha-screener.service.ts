/**
 * DeepSeek Alpha Screener — AI-powered token quality filter.
 *
 * Before a token gets forwarded to the trader, DeepSeek evaluates
 * whether it's genuine alpha or noise. This dramatically reduces
 * garbage trades from random DexScreener trending tokens.
 *
 * Only runs on non-KOL tokens (KOL tokens already have social proof).
 */

import { fetch } from 'cross-fetch';

export interface AlphaScreenResult {
  worthy: boolean;
  confidence: 'low' | 'medium' | 'high';
  reasoning: string;
}

export async function screenTokenWithDeepSeek(params: {
  symbol: string;
  mint: string;
  marketCap: number;
  liquidity: number;
  volume24h: number;
  tokenAgeMinutes: number;
  priceChange5m: number;
  priceChange1h: number;
  buySellRatio: number;
  holderCount: number;
  topHolderPct: number;
  whaleNetFlow: number;
  kolMentions: number;
  score: number;
  narrativeTag?: string;
  // On-chain risk data from SolanaService / chain-risk
  chainRisk?: {
    top10HolderPct: number;
    circulatingSupply: number | null;
    totalSupply: number | null;
    trustScore: number;
    riskScore: number;
    rewardScore: number;
    riskFlags: string[];
    strengthSignals: string[];
  };
}): Promise<AlphaScreenResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { worthy: true, confidence: 'low', reasoning: 'No API key — skipping AI screen' };
  }

  try {
    const chainRiskSection = params.chainRisk ? `
ON-CHAIN RISK ANALYSIS (from Solana RPC):
- Top 10 Holder Concentration: ${params.chainRisk.top10HolderPct.toFixed(1)}%
- Circulating Supply: ${params.chainRisk.circulatingSupply ? params.chainRisk.circulatingSupply.toLocaleString() : 'unknown'}
- Total Supply: ${params.chainRisk.totalSupply ? params.chainRisk.totalSupply.toLocaleString() : 'unknown'}
- Trust Score: ${params.chainRisk.trustScore}/100
- Risk Score: ${params.chainRisk.riskScore}/100
- Reward Score: ${params.chainRisk.rewardScore}/100
- Risk Flags: ${params.chainRisk.riskFlags.length > 0 ? params.chainRisk.riskFlags.join(', ') : 'NONE'}
- Strength Signals: ${params.chainRisk.strengthSignals.length > 0 ? params.chainRisk.strengthSignals.join(', ') : 'none detected'}` : '';

    const prompt = `You are an elite Solana memecoin/microcap alpha analyst. Analyze this token and decide if it's worth trading.

TOKEN DATA:
- Symbol: ${params.symbol}
- Market Cap: $${params.marketCap.toLocaleString()}
- Liquidity: $${params.liquidity.toLocaleString()}
- 24h Volume: $${params.volume24h.toLocaleString()}
- Token Age: ${params.tokenAgeMinutes >= 0 ? params.tokenAgeMinutes.toFixed(0) + ' minutes' : 'unknown'}
- Price Change (5m): ${params.priceChange5m > 0 ? '+' : ''}${params.priceChange5m.toFixed(1)}%
- Price Change (1h): ${params.priceChange1h > 0 ? '+' : ''}${params.priceChange1h.toFixed(1)}%
- Buy/Sell Ratio (1h): ${params.buySellRatio.toFixed(2)}
- Holder Count (top 20): ${params.holderCount}
- Top Holder Concentration: ${params.topHolderPct.toFixed(1)}%
- Smart Money Net Flow: ${params.whaleNetFlow.toFixed(2)} SOL
- KOL Mentions: ${params.kolMentions}
- Bot Algorithmic Score: ${params.score}/100
${params.narrativeTag ? `- Narrative/Meta: ${params.narrativeTag}` : ''}
${chainRiskSection}

DECISION CRITERIA:
- Is there real buying pressure or is this a pump-and-dump in progress?
- Does the volume-to-liquidity ratio suggest organic interest?
- Is the token age + momentum consistent with genuine early alpha?
- Are there red flags (too much concentration, no holders, fake volume)?
${params.chainRisk ? '- Do the on-chain risk flags raise concern? Is the trust score acceptable?' : ''}
${params.chainRisk ? '- Is the circulating supply distribution healthy (not concentrated)?' : ''}
- Would a professional crypto trader enter this position?

Respond with JSON: {"worthy": boolean, "confidence": "low"|"medium"|"high", "reasoning": "1 sentence"}`;

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are an expert Solana microcap analyst. Output strictly valid JSON.' },
          { role: 'user', content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      return { worthy: true, confidence: 'low', reasoning: 'API error — fail open' };
    }

    const json = await res.json() as any;
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      return { worthy: true, confidence: 'low', reasoning: 'Empty response — fail open' };
    }

    const result = JSON.parse(content);
    return {
      worthy: result.worthy === true,
      confidence: ['low', 'medium', 'high'].includes(result.confidence) ? result.confidence : 'low',
      reasoning: String(result.reasoning || 'No reasoning provided'),
    };
  } catch (err) {
    console.error('[DeepSeek Alpha Screener] Error:', err);
    return { worthy: true, confidence: 'low', reasoning: 'Error — fail open' };
  }
}
