import { fetch } from 'cross-fetch';

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

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: "You are an expert crypto risk-manager AI. Output strictly valid JSON."
        }, {
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!res.ok) return true; // Fail open
    const json = await res.json() as any;
    const content = json.choices?.[0]?.message?.content;
    if (!content) return true;

    const result = JSON.parse(content);
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

export async function runAiActivePositionAnalyzer(
  mint: string,
  symbol: string,
  initialSol: number,
  currentSol: number,
  multiplier: number,
  holdMins: number,
  marketCap: number,
  volume1h: number,
  topHoldersPercent: number, // percentage of supply held by top 10
): Promise<{ action: AiTradeAction; confidence: number; reason: string }> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return { action: 'HOLD', confidence: 0, reason: 'No AI key' };
  }

  try {
    const prompt = `
You are an expert Solana memecoin portfolio manager and day trader AI.
You are monitoring an ACTIVE HOLDING for the token: ${symbol} (${mint}).

Current Trade Status:
  - Return: ${multiplier.toFixed(2)}x (Initial size: ${initialSol.toFixed(2)} SOL)
  - Hold Time: ${Math.round(holdMins)} minutes
  - Market Cap: $${marketCap.toLocaleString()}
  - 1hr Volume: $${volume1h.toLocaleString()}
  - Top 10 Holders Own: ${topHoldersPercent.toFixed(1)}% of supply

Context for Memecoins:
  - Under 30 mins hold is very fresh.
  - Multiplier > 2x is highly profitable.
  - Multiplier < 0.6x is a deep drawdown.
  - Top 10 Holders > 40% is extremely risky (insider cabal risk).
  - High volume on low market cap = sustained hype. Lower volume = dying trend.

Your job is to recommend the single best Action for this trade right now.
Possible Actions:
  - "HOLD": Wait for further development.
  - "EXIT": The pump is dead, volume is dropping, or cabal risk is too high. Sell the entire bag.
  - "DCA_IN": The dip looks healthy (momentum intact, low cabal risk, good volume) and price dropped 20-50%. Buy more.
  - "TAKE_PROFIT": We hit 1.5x - 3x. Sell 50-80% to lock gains.
  - "MOON_BAG": We are up significantly (3x+). Sell most to secure profit, but leave 10% running forever.

Output strictly valid JSON: {"action": "HOLD|EXIT|DCA_IN|TAKE_PROFIT|MOON_BAG", "confidence": number 0-100, "reason": "short explanation"}
    `.trim();

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek/deepseek-chat',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: "You are an expert crypto portfolio AI. Output strictly valid JSON."
        }, {
          role: 'user',
          content: prompt
        }]
      })
    });

    if (!res.ok) return { action: 'HOLD', confidence: 0, reason: 'API Errored' };
    const json = await res.json() as any;
    const content = json.choices?.[0]?.message?.content;
    if (!content) return { action: 'HOLD', confidence: 0, reason: 'Empty AI Response' };

    const result = JSON.parse(content);
    return {
      action: result.action || 'HOLD',
      confidence: result.confidence || 50,
      reason: result.reason || 'AI evaluation complete'
    };
  } catch (err) {
    console.error('[AI Portfolio Manager] Error analyzing trade:', err);
    return { action: 'HOLD', confidence: 0, reason: 'Exception in AI evaluation' };
  }
}

