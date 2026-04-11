import { Connection } from '@solana/web3.js';
import {
  getDb,
  RPC_FAILURE_THRESHOLD,
  RPC_HEALTH_CHECK_MS,
  normalizeHttpRpcEndpoint,
  selectPublicHttpRpcEndpoint,
  shouldAllowPublicRpcFallback,
} from '@wildtrade/shared';

interface RpcEndpointRow {
  url: string;
  provider: string;
  priority: number;
  is_healthy: number;
  last_error_at: number | null;
  consecutive_failures: number;
  last_used_at: number | null;
}

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;

function getSeedEndpoints(): Array<{ url: string; provider: string; priority: number }> {
  const endpoints: Array<{ url: string; provider: string; priority: number }> = [];
  const seen = new Set<string>();

  const candidates: Array<{ url: string | null; provider: string; priority: number }> = [
    {
      url: normalizeHttpRpcEndpoint(process.env.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_CONSTANTK),
      provider: 'constant-k',
      priority: 0,
    },
    {
      url: normalizeHttpRpcEndpoint(process.env.SOLANA_RPC_QUICKNODE),
      provider: 'quicknode',
      priority: 1,
    },
  ];

  if (shouldAllowPublicRpcFallback()) {
    candidates.push({
      url: selectPublicHttpRpcEndpoint(),
      provider: 'public',
      priority: 2,
    });
  }

  for (const candidate of candidates) {
    if (!candidate.url || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    endpoints.push(candidate as { url: string; provider: string; priority: number });
  }

  return endpoints;
}

/**
 * Seed the rpc_endpoints table with endpoints from environment variables.
 * Existing rows are left intact (ON CONFLICT DO NOTHING).
 */
export async function seedEndpoints(): Promise<void> {
  const db = await getDb();
  for (const ep of getSeedEndpoints()) {
    await db.query(
      `INSERT INTO rpc_endpoints (url, provider, priority, is_healthy, consecutive_failures)
       VALUES ($1, $2, $3, 1, 0)
       ON CONFLICT (url) DO NOTHING`,
      [ep.url, ep.provider, ep.priority],
    );
    console.log(`[self-healer] rpc-rotator: seeded ${ep.provider} endpoint`);
  }
}

/**
 * Return the highest-priority healthy endpoint URL, or null if none available.
 * Also stamps last_used_at for the chosen endpoint.
 */
export async function getHealthyEndpoint(): Promise<string | null> {
  const db = await getDb();
  const result = await db.query<RpcEndpointRow>(
    `SELECT url FROM rpc_endpoints
     WHERE is_healthy = 1
     ORDER BY priority ASC
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) {
    console.log('[self-healer] rpc-rotator: no healthy endpoint available');
    return null;
  }
  await db.query(
    `UPDATE rpc_endpoints SET last_used_at = $1 WHERE url = $2`,
    [Date.now(), row.url],
  );
  return row.url;
}

/**
 * Report a failure for a given endpoint. Increments consecutive_failures.
 * If failures reach RPC_FAILURE_THRESHOLD, marks endpoint as unhealthy.
 */
export async function reportFailure(url: string, error: string): Promise<void> {
  const db = await getDb();
  const now = Date.now();

  await db.query(
    `UPDATE rpc_endpoints
     SET consecutive_failures = consecutive_failures + 1,
         last_error_at = $1
     WHERE url = $2`,
    [now, url],
  );

  const result = await db.query<{ consecutive_failures: number }>(
    `SELECT consecutive_failures FROM rpc_endpoints WHERE url = $1`,
    [url],
  );
  const failures = result.rows[0]?.consecutive_failures ?? 0;

  console.log(`[self-healer] rpc-rotator: failure for ${url} (${failures}/${RPC_FAILURE_THRESHOLD}): ${error}`);

  if (failures >= RPC_FAILURE_THRESHOLD) {
    await db.query(
      `UPDATE rpc_endpoints SET is_healthy = 0 WHERE url = $1`,
      [url],
    );
    console.log(`[self-healer] rpc-rotator: marked ${url} as unhealthy`);
  }
}

/**
 * Force rotate: mark the current best endpoint as unhealthy
 * and return the next healthy one.
 */
export async function forceRotate(): Promise<{ previousUrl: string | null; newUrl: string | null }> {
  const db = await getDb();

  // Get current best endpoint
  const currentResult = await db.query<RpcEndpointRow>(
    `SELECT url FROM rpc_endpoints
     WHERE is_healthy = 1
     ORDER BY priority ASC
     LIMIT 1`,
  );
  const previousUrl = currentResult.rows[0]?.url ?? null;

  if (previousUrl) {
    await db.query(
      `UPDATE rpc_endpoints SET is_healthy = 0, consecutive_failures = $1 WHERE url = $2`,
      [RPC_FAILURE_THRESHOLD, previousUrl],
    );
    console.log(`[self-healer] rpc-rotator: force-rotated away from ${previousUrl}`);
  }

  const newUrl = await getHealthyEndpoint();
  console.log(`[self-healer] rpc-rotator: rotated to ${newUrl ?? 'NONE'}`);
  return { previousUrl, newUrl };
}

/**
 * Get all endpoints with their current status.
 */
export async function getAllEndpoints(): Promise<RpcEndpointRow[]> {
  const db = await getDb();
  const result = await db.query<RpcEndpointRow>(
    `SELECT url, provider, priority, is_healthy, last_error_at, consecutive_failures, last_used_at
     FROM rpc_endpoints
     ORDER BY priority ASC`,
  );
  return result.rows;
}

/**
 * Ping unhealthy endpoints by calling getSlot via JSON-RPC.
 * If the call succeeds, restore the endpoint to healthy status.
 */
async function runHealthChecks(): Promise<void> {
  const db = await getDb();
  const result = await db.query<RpcEndpointRow>(
    `SELECT url, provider FROM rpc_endpoints WHERE is_healthy = 0`,
  );

  for (const row of result.rows) {
    try {
      const connection = new Connection(row.url, { commitment: 'confirmed', fetch: global.fetch });
      await connection.getSlot();

      // Endpoint responded: restore it
      await db.query(
        `UPDATE rpc_endpoints
         SET is_healthy = 1, consecutive_failures = 0
         WHERE url = $1`,
        [row.url],
      );
      console.log(`[self-healer] rpc-rotator: restored ${row.provider} (${row.url})`);
    } catch {
      // Still unhealthy, leave it
      console.log(`[self-healer] rpc-rotator: ${row.provider} still unreachable`);
    }
  }
}

/**
 * Start periodic health checks for unhealthy endpoints.
 */
export function startHealthChecks(): void {
  if (healthCheckInterval) return;
  console.log(`[self-healer] rpc-rotator: starting health checks every ${RPC_HEALTH_CHECK_MS}ms`);
  healthCheckInterval = setInterval(() => {
    runHealthChecks().catch((err) => {
      console.log(`[self-healer] rpc-rotator: health check error: ${err}`);
    });
  }, RPC_HEALTH_CHECK_MS);
}

/**
 * Stop periodic health checks.
 */
export function stopHealthChecks(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log('[self-healer] rpc-rotator: stopped health checks');
  }
}
