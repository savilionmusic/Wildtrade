import { getDb, SIGNAL_DEFAULT_TTL_MS } from '@wildtrade/shared';
import type { Evaluator, IAgentRuntime, Memory, EvaluationExample } from '@elizaos/core';

const EXPIRY_CHECK_BUFFER_MS = 60_000; // Check signals expiring within 1 minute

const alphaScoreEvaluator: Evaluator = {
  name: 'ALPHA_SCORE_EVALUATOR',
  description: 'Checks the database for alpha signals approaching expiry and marks them as expired. Helps keep the signal table clean and prevents stale signals from being acted upon.',
  similes: ['CHECK_SIGNAL_EXPIRY', 'EXPIRE_SIGNALS', 'CLEANUP_SIGNALS'],
  alwaysRun: false,
  examples: [
    {
      context: 'The evaluator checks for signals nearing expiry after each message cycle.',
      messages: [
        {
          user: '{{user1}}',
          content: { text: 'What signals are active?' },
        },
      ],
      outcome: 'Expired signals are marked in the database. Active signal count is logged.',
    } as EvaluationExample,
  ],

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    // Only run if there might be signals to expire - lightweight check
    try {
      const db = await getDb();
      const result = await db.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM signals WHERE expired = 0',
      );
      const activeCount = result.rows[0]?.cnt ?? 0;
      return activeCount > 0;
    } catch {
      return false;
    }
  },

  handler: async (_runtime: IAgentRuntime, _message: Memory): Promise<void> => {
    const now = Date.now();
    const expiryThreshold = now + EXPIRY_CHECK_BUFFER_MS;

    try {
      const db = await getDb();

      // Mark signals that have passed their expiry time
      const expiredResult = await db.query<{ cnt: number }>(
        `UPDATE signals SET expired = 1
         WHERE expired = 0 AND expires_at <= $1
         RETURNING id`,
        [now],
      );

      const expiredCount = expiredResult.rows.length;
      if (expiredCount > 0) {
        console.log(`[alpha-scout] Marked ${expiredCount} signal(s) as expired`);
      }

      // Log signals approaching expiry (within buffer)
      const approachingResult = await db.query<{ id: string; mint: string; expires_at: number }>(
        `SELECT id, mint, expires_at FROM signals
         WHERE expired = 0 AND expires_at > $1 AND expires_at <= $2`,
        [now, expiryThreshold],
      );

      if (approachingResult.rows.length > 0) {
        for (const row of approachingResult.rows) {
          const remainingMs = row.expires_at - now;
          const remainingSec = Math.round(remainingMs / 1000);
          console.log(
            `[alpha-scout] Signal ${row.id} (${row.mint}) expiring in ${remainingSec}s`
          );
        }
      }

      // Log summary of active signals
      const activeResult = await db.query<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM signals WHERE expired = 0',
      );
      const activeCount = activeResult.rows[0]?.cnt ?? 0;
      console.log(`[alpha-scout] Active signals: ${activeCount} (TTL: ${SIGNAL_DEFAULT_TTL_MS / 1000}s)`);
    } catch (err) {
      console.log(`[alpha-scout] Evaluator error: ${String(err)}`);
    }
  },
};

export default alphaScoreEvaluator;
