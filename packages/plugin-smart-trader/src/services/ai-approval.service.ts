import { fetch } from 'cross-fetch';

export async function runAiPreTradeConvictionCheck(
  mint: string,
  symbol: string,
  budgetSol: number,
  score: number,
  marketCap: number,
  reason: string
): Promise<boolean> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || budgetSol < 0.1) {
    // Only run AI gatekeeper on meaningful bets (>= 0.1 SOL)
    // Or skip if no API key is provided
    return true;
  }

  try {
    console.log(`[AI Gatekeeper] Requesting DeepSeek approval for ${symbol} (${budgetSol.toFixed(2)} SOL)...`);
    
    // Give the AI the context needed
    const prompt = `
You are a highly experienced crypto hedge fund AI risk manager. 
Your trading bot requested approval to execute the following trade on Solana:
- Token Symbol: \${symbol}
- Contract Address: \${mint}
- Proposed Trade Size: \${budgetSol} SOL
- Bot's Algorithmic Score: \${score}/100
- Est. Market Cap: $\${marketCap}
- Bot Reason / Context: \${reason}

Does this trade make sense? If you spot massive red flags (e.g., buying into obviously fake metrics or a bot spam score), reject it.
Respond with a JSON object containing exactly one key "approval" which is a boolean (true to allow the trade, false to block it).
    `.trim();

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer \${apiKey}`,
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
      console.log(\`[AI Gatekeeper] DeepSeek REJECTED trade for \${symbol}!\`);
      return false;
    }
    
    console.log(\`[AI Gatekeeper] DeepSeek APPROVED trade for \${symbol}!\`);
    return true;
  } catch (err) {
    console.error('[AI Gatekeeper] Error checking trade conviction:', err);
    return true; // Fail open on network errors
  }
}
