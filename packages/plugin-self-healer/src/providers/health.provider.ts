import { getDb } from '@wildtrade/shared';
import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { getHealthyEndpoint, getAllEndpoints } from '../services/rpc-rotator.service.js';
import { getLastReconcileAt } from '../services/reconciler.service.js';

const healthProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string> => {
    const db = await getDb();

    // Active RPC endpoint
    const activeRpc = await getHealthyEndpoint() ?? 'NONE';

    // RPC pool health
    const endpoints = await getAllEndpoints();
    const poolLines = endpoints.map((ep) => {
      const status = ep.is_healthy ? 'HEALTHY' : 'UNHEALTHY';
      return `  - ${ep.provider} (priority ${ep.priority}): ${status} | failures: ${ep.consecutive_failures} | ${ep.url}`;
    });
    const poolHealth = poolLines.length > 0 ? poolLines.join('\n') : '  (no endpoints configured)';

    // Unresolved error count
    const errResult = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM errors WHERE resolved = 0`,
    );
    const unresolvedErrors = errResult.rows[0]?.cnt ?? 0;

    // Last reconciliation time
    const lastReconAt = getLastReconcileAt();
    const lastReconStr = lastReconAt
      ? new Date(lastReconAt).toISOString()
      : 'never';

    // Open discrepancies count
    const discResult = await db.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM reconcile_log WHERE resolved = 0`,
    );
    const openDiscrepancies = discResult.rows[0]?.cnt ?? 0;

    const report = [
      '=== Self-Healer Health Report ===',
      `Active RPC: ${activeRpc}`,
      `RPC Pool:`,
      poolHealth,
      `Unresolved Errors: ${unresolvedErrors}`,
      `Last Reconciliation: ${lastReconStr}`,
      `Open Discrepancies: ${openDiscrepancies}`,
      '=================================',
    ].join('\n');

    return report;
  },
};

export default healthProvider;
