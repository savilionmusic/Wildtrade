const RUGCHECK_API_BASE = process.env.RUGCHECK_API_BASE || 'https://api.rugcheck.xyz/v1';

export interface RugcheckResult {
  score: number;
  isRug: boolean;
  risks: string[];
}

/**
 * Query the Rugcheck API for a token report and extract risk factors.
 * On any error, returns a conservative fallback marking the token as risky.
 */
export async function checkToken(mint: string): Promise<RugcheckResult> {
  try {
    const url = `${RUGCHECK_API_BASE}/tokens/${mint}/report`;
    console.log(`[self-healer] rugcheck: fetching report for ${mint}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      console.log(`[self-healer] rugcheck: HTTP ${response.status} for ${mint}`);
      return { score: 0, isRug: true, risks: [`http_${response.status}`] };
    }

    const data = await response.json() as Record<string, unknown>;

    const score = typeof data.score === 'number' ? data.score : 0;
    const risks: string[] = [];

    if (Array.isArray(data.risks)) {
      for (const risk of data.risks) {
        if (risk && typeof risk === 'object' && 'name' in risk && typeof risk.name === 'string') {
          risks.push(risk.name);
        } else if (typeof risk === 'string') {
          risks.push(risk);
        }
      }
    }

    // A score below 50 or the presence of critical risk factors indicates a rug
    const isRug = score < 50 || risks.some((r) =>
      r.toLowerCase().includes('rug') ||
      r.toLowerCase().includes('honeypot') ||
      r.toLowerCase().includes('mintable') ||
      r.toLowerCase().includes('freeze')
    );

    console.log(`[self-healer] rugcheck: ${mint} score=${score} isRug=${isRug} risks=[${risks.join(', ')}]`);

    return { score, isRug, risks };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[self-healer] rugcheck: API error for ${mint}: ${errMsg}`);
    return { score: 0, isRug: true, risks: ['api_unavailable'] };
  }
}
