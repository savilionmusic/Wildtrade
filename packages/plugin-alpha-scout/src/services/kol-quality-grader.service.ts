import { fetch } from 'cross-fetch';

export type KolStrategy = 'flip' | 'conviction' | 'unknown';

export async function analyzeKolTweetQuality(tweetText?: string): Promise<KolStrategy> {
  if (!tweetText || tweetText.trim().length < 10) return 'unknown';
  
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return 'unknown';

  try {
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
          content: 'You analyze cryptocurrency tweets and determine the author\\'s conviction. Output JSON with exactly one key: "strategy" (must be strictly the string "flip" or "conviction"). "flip" means it looks like a low-effort pump-and-dump (e.g. "Ape this now", rocket emojis, no deep research). "conviction" means there is detailed research, utility discussion, tokenomics breakdown, or developer team analysis.'
        }, {
          role: 'user',
          content: `Analyze this tweet:\n\n"${tweetText}"`
        }]
      })
    });

    if (!res.ok) return 'unknown';
    const json = await res.json() as any;
    const content = json.choices?.[0]?.message?.content;
    if (!content) return 'unknown';

    const result = JSON.parse(content);
    if (result.strategy === 'flip' || result.strategy === 'conviction') {
      return result.strategy;
    }
  } catch (err) {
    console.error('[KOL Quality] Grader error:', err);
  }
  return 'unknown';
}
