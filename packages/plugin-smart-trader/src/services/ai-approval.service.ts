import { fetch } from 'cross-fetch';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek/deepseek-chat';
const FALLBACK_AI_MODEL = 'openai/gpt-4o-mini';
const AI_REQUEST_TIMEOUT_MS = 15_000;
const AI_MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeResponseBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim().slice(0, 240) || 'empty response body';
}

function parseJsonObject(content: string): Record<string, any> | null {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed) as Record<string, any>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]) as Record<string, any>;
    } catch {
      return null;
    }
  }
}

function getAbortSignal(timeoutMs: number): { signal?: AbortSignal; cleanup: () => void } {
  if (typeof AbortController === 'undefined') {
    return { cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeoutId),
  };
}

function getAiModelCandidates(): string[] {
  const models = [DEEPSEEK_MODEL, process.env.TRADER_MODEL, FALLBACK_AI_MODEL]
    .map((model) => String(model ?? '').trim())
    .filter(Boolean);

  return [...new Set(models)];
}

async function requestAiJson(
  logPrefix: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<Record<string, any> | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  const models = getAiModelCandidates();

  for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
    const model = models[modelIndex];
    const maxAttempts = modelIndex === 0 ? AI_MAX_RETRIES : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { signal, cleanup } = getAbortSignal(AI_REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
          }),
          signal,
        });

        if (!res.ok) {
          const responseBody = await res.text();
          console.log(
            `${logPrefix} OpenRouter error ${res.status} on ${model} ` +
            `(attempt ${attempt}/${maxAttempts}): ${summarizeResponseBody(responseBody)}`
          );
        } else {
          const json = await res.json() as any;
          const content = json.choices?.[0]?.message?.content;

          if (!content) {
            console.log(`${logPrefix} Empty AI response from ${model} (attempt ${attempt}/${maxAttempts})`);
          } else {
            const parsed = parseJsonObject(content);
            if (parsed) return parsed;
            console.log(`${logPrefix} Invalid AI JSON from ${model} (attempt ${attempt}/${maxAttempts}): ${content.slice(0, 240)}`);
          }
        }
      } catch (error: any) {
        const isTimeout = error?.name === 'AbortError';
        console.log(
          `${logPrefix} ${isTimeout ? 'Request timed out' : 'Request failed'} on ${model} ` +
          `(attempt ${attempt}/${maxAttempts}): ${String(error?.message ?? error)}`
        );
      } finally {
        cleanup();
      }

      if (attempt < maxAttempts) {
        await sleep(1000 * attempt);
      }
    }
  }

  return null;
}

function normalizeTradeAction(action: unknown): AiTradeAction {
  const normalized = String(action ?? 'HOLD').toUpperCase();
  if (normalized === 'EXIT' || normalized === 'DCA_IN' || normalized === 'TAKE_PROFIT' || normalized === 'MOON_BAG') {
    return normalized;
  }
  return 'HOLD';
}

export async function runAiPreTradeConvictionCheck(
  mint: string,
  symbol: string,
  budgetSol: number,
  score: number,
  marketCap: number,
  reason: string,
  kolStrategy?: 'flip' | 'conviction',
): Promise<boolean> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || budgetSol < 0.1) {
    return true;
  }

  // Auto-approve conviction KOL calls — Gold KOL + DeepSeek-graded conviction signals
  // already survived two AI checks (KOL quality grader + alpha screener).
  // Blocking them here would kill our best alpha.
  if (kolStrategy === 'conviction') {
    console.log(`[AI Gatekeeper] Auto-APPROVED ${symbol} — conviction KOL signal (skip AI gate)`);
    return true;
  }

  try {
    console.log(`[AI Gatekeeper] Requesting DeepSeek approval for ${symbol} (${budgetSol.toFixed(2)} SOL)...`);
    
    const kolContext = kolStrategy === 'flip'
      ? '\n  - KOL Signal: Yes (FLIP strategy — quick momentum play, a KOL tweeted about this)'
      : '';

    const prompt = `
You are a Solana memecoin trading bot's final risk check. This bot trades micro-cap tokens ($5k-$500k market cap) on Solana — these are NOT blue-chip investments. Small market caps and high volatility are EXPECTED and NORMAL for this strategy.

Trade request:
  - Token: ${symbol}
  - Contract: ${mint}
  - Size: ${budgetSol} SOL (small position)
  - Bot Score: ${score}/100 (already passed 10+ algorithmic filters)
  - Market Cap: $${marketCap.toLocaleString()}
  - Context: ${reason}${kolContext}

Your job: ONLY reject if you see OBVIOUS scam indicators like:
  - Token name is a known scam pattern (e.g. "FREE ETH", obvious honeypot names)
  - The reason/context mentions critical red flags the bot missed

You should APPROVE most trades because the bot's algorithmic pipeline already filtered out rugs, honeypots, low-liquidity tokens, and spam. A score of 50+ means it passed all safety checks.

Small market cap ($5k-$100k) is the SWEET SPOT for this strategy, not a red flag.

Respond with JSON: {"approval": true} or {"approval": false}
    `.trim();

    const result = await requestAiJson(
      '[AI Gatekeeper]',
      'You are an expert crypto risk-manager AI. Output strictly valid JSON.',
      prompt,
    );

    if (!result) {
      console.log(`[AI Gatekeeper] AI approval chain unavailable after retries. Failing open for ${symbol}.`);
      return true;
    }

    if (result.approval === false) {
      console.log(`[AI Gatekeeper] DeepSeek REJECTED trade for ${symbol}!`);
      return false;
    }
    
    console.log(`[AI Gatekeeper] DeepSeek APPROVED trade for ${symbol}!`);
    return true;
  } catch (err) {
    console.error('[AI Gatekeeper] Error checking trade conviction:', err);
    return true; // Fail open on network errors
  }
}

export type AiTradeAction = 'HOLD' | 'EXIT' | 'DCA_IN' | 'TAKE_PROFIT' | 'MOON_BAG';

export interface ActivePositionAiContext {
  mint: string;
  symbol: string;
  initialSol: number;
  currentSol: number;
  multiplier: number;
  holdMins: number;
  marketCap: number;
  liquidityUsd: number;
  volume1h: number;
  currentStopMultiplier: number;
  highWaterMark: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange1h: number;
  trendLabel: string;
  topHolderPct: number;
  top10HolderPct: number;
  holderCountTop20: number;
  trustScore: number;
  riskScore: number;
  rewardScore: number;
  riskFlags: string[];
  strengthSignals: string[];
}

export interface AiPositionAnalysis {
  action: AiTradeAction;
  confidence: number;
  reason: string;
  expectedUpsidePct: number;
  expectedDownsidePct: number;
}

export async function runAiActivePositionAnalyzer(
  context: ActivePositionAiContext,
): Promise<AiPositionAnalysis> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return {
      action: 'HOLD',
      confidence: 0,
      reason: 'No AI key',
      expectedUpsidePct: 0,
      expectedDownsidePct: 0,
    };
  }

  try {
    const prompt = `
You are an expert Solana memecoin portfolio manager and day trader AI.
You are monitoring an ACTIVE HOLDING for the token: ${context.symbol} (${context.mint}).

Current Trade Status:
  - Return: ${context.multiplier.toFixed(2)}x (Initial size: ${context.initialSol.toFixed(2)} SOL, current value: ${context.currentSol.toFixed(2)} SOL)
  - Hold Time: ${Math.round(context.holdMins)} minutes
  - Market Cap: $${context.marketCap.toLocaleString()}
  - Liquidity: $${context.liquidityUsd.toLocaleString()}
  - 1hr Volume: $${context.volume1h.toLocaleString()}
  - Current trailing stop floor: ${context.currentStopMultiplier.toFixed(2)}x
  - High-water mark: ${context.highWaterMark.toFixed(2)}x

Short-Term Chart Read:
  - 5m change: ${context.priceChange5m >= 0 ? '+' : ''}${context.priceChange5m.toFixed(1)}%
  - 15m change: ${context.priceChange15m >= 0 ? '+' : ''}${context.priceChange15m.toFixed(1)}%
  - 1h change: ${context.priceChange1h >= 0 ? '+' : ''}${context.priceChange1h.toFixed(1)}%
  - Trend label: ${context.trendLabel}

On-Chain Risk Read:
  - Largest holder: ${context.topHolderPct.toFixed(1)}% of supply
  - Top 10 holders: ${context.top10HolderPct.toFixed(1)}% of supply
  - Top 20 holder count detected: ${context.holderCountTop20}
  - Trust score: ${context.trustScore}/100
  - Risk score: ${context.riskScore}/100
  - Reward score: ${context.rewardScore}/100
  - Risk flags: ${context.riskFlags.length > 0 ? context.riskFlags.join(', ') : 'none'}
  - Strength signals: ${context.strengthSignals.length > 0 ? context.strengthSignals.join(', ') : 'none'}

Context for Memecoins:
  - Under 30 mins hold is very fresh.
  - Multiplier > 2x is highly profitable.
  - Multiplier < 0.6x is a deep drawdown.
  - Rising volume with good liquidity can justify patience.
  - High concentration + fading momentum means protect capital fast.
  - High volume on low market cap = sustained hype. Lower volume = dying trend.

Your job is to act like a ruthless professional trader and recommend the single best Action for this trade right now.
You must compare expected upside over the next 15-30 minutes versus realistic downside if momentum fails.

Possible Actions:
  - "HOLD": Wait for further development.
  - "EXIT": The pump is dead, volume is dropping, or cabal risk is too high. Sell the entire bag.
  - "DCA_IN": The dip looks healthy (momentum intact, low cabal risk, good volume) and price dropped 20-50%. Buy more.
  - "TAKE_PROFIT": We hit 1.5x - 3x. Sell 50-80% to lock gains.
  - "MOON_BAG": We are up significantly (3x+). Sell most to secure profit, but leave 10% running forever.

Rules:
  - Do not recommend DCA_IN if risk score is above 60.
  - Prefer TAKE_PROFIT over HOLD when downside is larger than upside and the trade is already green.
  - Prefer EXIT when concentration risk is high and momentum is breaking.
  - Prefer MOON_BAG only when reward score is strong and risk is controlled.

Output strictly valid JSON: {"action": "HOLD|EXIT|DCA_IN|TAKE_PROFIT|MOON_BAG", "confidence": number 0-100, "reason": "short explanation", "expectedUpsidePct": number, "expectedDownsidePct": number}
    `.trim();

    const result = await requestAiJson(
      '[AI Portfolio Manager]',
      'You are an expert crypto portfolio AI. Output strictly valid JSON.',
      prompt,
    );

    if (!result) {
      return {
        action: 'HOLD',
        confidence: 0,
        reason: 'AI unavailable after retries',
        expectedUpsidePct: 0,
        expectedDownsidePct: 0,
      };
    }

    return {
      action: normalizeTradeAction(result.action),
      confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : 50,
      reason: result.reason || 'AI evaluation complete',
      expectedUpsidePct: Number.isFinite(Number(result.expectedUpsidePct)) ? Number(result.expectedUpsidePct) : 0,
      expectedDownsidePct: Number.isFinite(Number(result.expectedDownsidePct)) ? Number(result.expectedDownsidePct) : 0,
    };
  } catch (err) {
    console.error('[AI Portfolio Manager] Error analyzing trade:', err);
    return {
      action: 'HOLD',
      confidence: 0,
      reason: 'Exception in AI evaluation',
      expectedUpsidePct: 0,
      expectedDownsidePct: 0,
    };
  }
}

