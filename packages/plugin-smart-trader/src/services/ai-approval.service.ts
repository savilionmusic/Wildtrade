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
