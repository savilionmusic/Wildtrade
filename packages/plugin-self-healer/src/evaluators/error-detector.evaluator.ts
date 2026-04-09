import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@wildtrade/shared';
import type { ErrorCategory } from '@wildtrade/shared';
import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { reportFailure, getHealthyEndpoint } from '../services/rpc-rotator.service.js';

interface ErrorPattern {
  pattern: RegExp;
  category: ErrorCategory | string;
  isRpcError: boolean;
}

const ERROR_PATTERNS: ErrorPattern[] = [
  { pattern: /429|too many requests/i, category: 'rpc_429', isRpcError: true },
  { pattern: /504|gateway timeout/i, category: 'rpc_504', isRpcError: true },
  { pattern: /timeout/i, category: 'tx_timeout', isRpcError: false },
  { pattern: /simulation failed/i, category: 'tx_simulation', isRpcError: false },
  { pattern: /X poll error|Twitter rate limited|X Login Error/i, category: 'social_api_error', isRpcError: false },
  { pattern: /WebSocket connection closed|PumpPortal Error/i, category: 'websocket_drop', isRpcError: false },
];

const DEGRADED_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEGRADED_THRESHOLD = 3;

const errorDetectorEvaluator: Evaluator = {
  name: 'ERROR_DETECTOR',
  description: 'Scans every message for error patterns (HTTP 429, 504, timeouts, simulation failures) and logs them. Triggers RPC failure reporting and degraded status detection.',
  similes: ['DETECT_ERRORS', 'MONITOR_FAILURES', 'CHECK_RPC_HEALTH'],
  alwaysRun: true,

  examples: [
    {
      context: 'A message containing an HTTP 429 error from an RPC call.',
      messages: [
        {
          user: '{{user1}}',
          content: { text: 'RPC call failed with HTTP 429 Too Many Requests on endpoint https://api.helius.xyz' },
        },
      ],
      outcome: 'Error logged as rpc_429, failure reported for the endpoint.',
    },
    {
      context: 'A message about a transaction simulation failure.',
      messages: [
        {
          user: '{{user1}}',
          content: { text: 'Transaction simulation failed: insufficient funds for rent' },
        },
      ],
      outcome: 'Error logged as tx_simulation.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    return true;
  },

  handler: async (_runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text ?? '';
    if (!text) return;

    const db = await getDb();
    const now = Date.now();

    for (const ep of ERROR_PATTERNS) {
      if (!ep.pattern.test(text)) continue;

      // Extract RPC endpoint URL from message if present
      const urlMatch = text.match(/https?:\/\/[^\s'"]+/);
      const rpcEndpoint = urlMatch ? urlMatch[0] : null;

      // Extract mint address if present
      const mintMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      const mintAddress = mintMatch ? mintMatch[0] : null;

      const errorId = uuidv4();

      // Persist to errors table
      await db.query(
        `INSERT INTO errors (id, category, message, raw_error, mint, rpc_endpoint, occurred_at, retry_count, resolved)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0)`,
        [errorId, ep.category, `Detected ${ep.category} pattern`, text, mintAddress, rpcEndpoint, now],
      );

      console.log(`[self-healer] error-detector: logged ${ep.category} error (id=${errorId})`);

      // Report RPC failure if this is an RPC-related error
      if (ep.isRpcError) {
        const endpointUrl = rpcEndpoint ?? await getHealthyEndpoint();
        if (endpointUrl) {
          await reportFailure(endpointUrl, `${ep.category}: ${text.substring(0, 200)}`);
        }
      }

      // Check for degraded status: same category >DEGRADED_THRESHOLD times in DEGRADED_WINDOW_MS
      const windowStart = now - DEGRADED_WINDOW_MS;
      const countResult = await db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM errors
         WHERE category = $1 AND occurred_at >= $2`,
        [ep.category, windowStart],
      );
      const recentCount = countResult.rows[0]?.cnt ?? 0;

      if (recentCount > DEGRADED_THRESHOLD) {
        console.log(
          `[self-healer] error-detector: DEGRADED - ${ep.category} occurred ${recentCount} times ` +
          `in last ${DEGRADED_WINDOW_MS / 1000}s (threshold: ${DEGRADED_THRESHOLD})`
        );

        // Log a degraded status error entry
        await db.query(
          `INSERT INTO errors (id, category, message, occurred_at, retry_count, resolved)
           VALUES ($1, $2, $3, $4, 0, 0)`,
          [
            uuidv4(),
            ep.category,
            `DEGRADED: ${ep.category} exceeded threshold (${recentCount}/${DEGRADED_THRESHOLD} in ${DEGRADED_WINDOW_MS / 1000}s)`,
            now,
          ],
        );
      }
    }
  },
};

export default errorDetectorEvaluator;
