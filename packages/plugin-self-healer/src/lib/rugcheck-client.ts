const RUGCHECK_API_BASE = process.env.RUGCHECK_API_BASE || 'https://api.rugcheck.xyz/v1';

// Throttle configuration
let lastCallTime = 0;
const MIN_INTERVAL_MS = 2000; // Max 1 call every 2 seconds

// Simple in-memory cache to avoid duplicate calls on the same mint
const cache = new Map<string, { result: RugcheckResult; timestamp: number }>();
const CACHE_TTL_MS = 60_000 * 5; // 5 minutes

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
  const now = Date.now();
  
  // Check cache first
  const cached = cache.get(mint);
  if (cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  // Throttle
  const timeSinceLast = now - lastCallTime;
  if (timeSinceLast < MIN_INTERVAL_MS) {
    console.log(`[self-healer] rugcheck: Rate limiting... waiting ${MIN_INTERVAL_MS - timeSinceLast}ms`);
    await new Promise(r => setTimeout(r, MIN_INTERVAL_MS - timeSinceLast));
  }
  lastCallTime = Date.now();

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
      if (response.status === 429) {
        console.log(`[self-healer] rugcheck: rate limited (429)! Backing off for 10s.`);
        lastCallTime = Date.now() + 10_000; // Increase throttle timeout on next call
      }
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

    // Critical risk flags always mark as rug regardless of score
    const hasCriticalRisk = risks.some((r) =>
      r.toLowerCase().includes('honeypot') ||
      r.toLowerCase().includes('mintable')
    );
    // Soft risk flags only matter with a low score
    const hasSoftRisk = risks.some((r) =>
      r.toLowerCase().includes('rug') ||
      r.toLowerCase().includes('freeze')
    );
    // Score < 30 = definite rug. 30-50 = only rug if risk flags present
    const isRug = hasCriticalRisk || score < 30 || (score < 50 && hasSoftRisk);

    console.log(`[self-healer] rugcheck: ${mint} score=${score} isRug=${isRug} risks=[${risks.join(', ')}]`);

    const payload = { score, isRug, risks };
    cache.set(mint, { result: payload, timestamp: Date.now() });

    return payload;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`[self-healer] rugcheck: API error for ${mint}: ${errMsg}`);
    return { score: 0, isRug: true, risks: ['api_unavailable'] };
  }
}
