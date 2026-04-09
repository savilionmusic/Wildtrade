import { fetch } from 'cross-fetch';

export interface NarrativeResult {
  narrative: string;
  hypeScore: number;
  isSpam: boolean;
}

const META_SCOREBOARD = new Map<string, { count: number; lastSeen: number }>();
// Token cache to prevent re-parsing same token multiple times quickly
const parsedTokens = new Set<string>();

export async function detectNarrative(mint: string, tweets: string[]): Promise<NarrativeResult | null> {
  if (parsedTokens.has(mint)) return null;
  
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.log('[AI NARRATIVE] Missing OPENROUTER_API_KEY');
    return null;
  }

  try {
    parsedTokens.add(mint);
    
    // Clear old tokens from cache after 15 mins
    setTimeout(() => parsedTokens.delete(mint), 15 * 60_000);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [{
          role: 'system',
          content: 'You analyze cryptocurrency tweets. Output JSON with exactly three keys: "narrative" (string, a short 1-3 word meta category like "AI Agent", "Cat Meme", "DeSci", etc.), "hypeScore" (number 1-10 describing the hype/momentum based on context), "isSpam" (boolean, true if it looks like generic bot spam without real narrative).'
        }, {
          role: 'user',
          content: `Analyze these tweets for token ${mint}:\n\n${tweets.join('\n\n')}`
        }]
      })
    });

    if (!res.ok) {
      console.log(`[AI NARRATIVE] API Error: ${res.status}`);
      return null;
    }

    const json = await res.json() as any;
    const contentStr = json.choices?.[0]?.message?.content;
    if (!contentStr) return null;

    const parsed = JSON.parse(contentStr) as NarrativeResult;
    
    if (parsed && !parsed.isSpam && parsed.narrative) {
      console.log(`[AI NARRATIVE] Parse complete for CA ${mint.slice(0,8)}...: Narrative '${parsed.narrative}', Hype ${parsed.hypeScore}/10`);
      
      const normalizedNarrative = parsed.narrative.trim().toLowerCase();
      const existing = META_SCOREBOARD.get(normalizedNarrative) || { count: 0, lastSeen: 0 };
      META_SCOREBOARD.set(normalizedNarrative, {
        count: existing.count + 1,
        lastSeen: Date.now()
      });
      
      // Cleanup old narratives
      const cutoff = Date.now() - 24 * 3600_000;
      for (const [k, v] of META_SCOREBOARD.entries()) {
        if (v.lastSeen < cutoff) META_SCOREBOARD.delete(k);
      }
      
      // Print top meta
      const top = getTopNarratives();
      if (top.length > 0) {
        console.log(`[META] Current Top Narratives: ${top.map((t, i) => `${i+1}. ${t}`).join(', ')}`);
      }
    } else if (parsed?.isSpam) {
      console.log(`[AI NARRATIVE] CA ${mint.slice(0,8)} is marked as SPAM.`);
    }
    
    return parsed;
  } catch (err) {
    console.error('[AI NARRATIVE] Error parsing', err);
    return null;
  }
}

export function getTopNarratives(): string[] {
  return Array.from(META_SCOREBOARD.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(x => x[0]);
}

// Store results so scanner-engine can use them
const aiHypeCache = new Map<string, NarrativeResult>();

export function cacheNarrativeResult(mint: string, result: NarrativeResult) {
  aiHypeCache.set(mint, result);
  // keep for 1 hour
  setTimeout(() => aiHypeCache.delete(mint), 3600_000);
}

export function getCachedNarrative(mint: string): NarrativeResult | undefined {
  return aiHypeCache.get(mint);
}
