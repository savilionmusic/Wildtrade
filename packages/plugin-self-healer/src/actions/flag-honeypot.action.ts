import { getDb } from '@wildtrade/shared';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from '@elizaos/core';
import { addToDenylist } from '../lib/denylist-manager.js';

const MINT_ADDRESS_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

const flagHoneypotAction: Action = {
  name: 'FLAG_HONEYPOT',
  description: 'Flag a token mint (and optionally its creator) as a honeypot or rug. Adds to denylist and cancels any open positions for the mint.',
  similes: ['FLAG_RUG', 'DENYLIST_TOKEN', 'BLOCK_TOKEN', 'HONEYPOT_DETECTED'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Flag mint 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU as a honeypot. Creator is 3xCreator123. Rugcheck score was 15.',
          action: 'FLAG_HONEYPOT',
        },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: {
          text: 'Flagging mint 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU as honeypot. Adding to denylist and checking for open positions.',
          action: 'FLAG_HONEYPOT',
        },
      } as ActionExample,
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text ?? '';
    return MINT_ADDRESS_REGEX.test(text);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text ?? '';

    // Extract all Solana-style addresses from the message
    const addresses = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];

    if (addresses.length === 0) {
      const msg = 'No valid mint address found in message.';
      console.log(`[self-healer] flag-honeypot: ${msg}`);
      if (callback) {
        await callback({ text: msg, action: 'FLAG_HONEYPOT' });
      }
      return { success: false, error: msg };
    }

    // First address is the mint, second (if present) is the creator
    const mintAddress = addresses[0];
    const creatorAddress = addresses.length > 1 ? addresses[1] : null;

    // Extract reason from message context
    const reasonMatch = text.match(/(?:reason|because|score)[:\s]+(.+?)(?:\.|$)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : 'flagged_as_honeypot';

    console.log(`[self-healer] flag-honeypot: flagging mint ${mintAddress}, creator=${creatorAddress ?? 'unknown'}`);

    // Add mint to denylist
    await addToDenylist(mintAddress!, 'mint', reason, 'auditor_flag');

    // Add creator to denylist if provided
    if (creatorAddress) {
      await addToDenylist(creatorAddress, 'creator', `creator_of_flagged_${mintAddress}`, 'auditor_flag');
    }

    // Check for open positions on this mint
    const db = await getDb();
    const positionsResult = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM positions
       WHERE mint = $1 AND status IN ('open', 'dca_filling', 'partial_exit', 'pending_approval', 'approved')`,
      [mintAddress],
    );

    const cancelledPositions: string[] = [];
    for (const pos of positionsResult.rows) {
      await db.query(
        `UPDATE positions SET status = 'cancelled', closed_at = $1 WHERE id = $2`,
        [Date.now(), pos.id],
      );
      cancelledPositions.push(pos.id);
      console.log(`[self-healer] flag-honeypot: cancelled position ${pos.id} (was ${pos.status})`);
    }

    // Also mark any signals for this mint as in_denylist
    await db.query(
      `UPDATE signals SET in_denylist = 1 WHERE mint = $1`,
      [mintAddress],
    );

    const summary = `Honeypot flagged: mint ${mintAddress}` +
      (creatorAddress ? `, creator ${creatorAddress}` : '') +
      ` added to denylist (reason: ${reason}).` +
      (cancelledPositions.length > 0
        ? ` Cancelled ${cancelledPositions.length} open position(s): ${cancelledPositions.join(', ')}.`
        : ' No open positions found for this mint.');

    console.log(`[self-healer] flag-honeypot: ${summary}`);

    if (callback) {
      await callback({ text: summary, action: 'FLAG_HONEYPOT' });
    }

    return {
      success: true,
      mintAddress,
      creatorAddress,
      reason,
      cancelledPositions,
    };
  },
};

export default flagHoneypotAction;
