import { Connection, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '@wildtrade/shared';
import type { ReconcileDiscrepancy } from '@wildtrade/shared';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from '@elizaos/core';
import { getHealthyEndpoint } from '../services/rpc-rotator.service.js';

const recoverPositionAction: Action = {
  name: 'RECOVER_POSITION',
  description: 'Recover a position by reconciling its on-chain token balance with the database record and resolving discrepancies.',
  similes: ['FIX_POSITION', 'RECONCILE_POSITION', 'HEAL_POSITION'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'There is a balance mismatch for position abc-123 on mint So11. On-chain shows 5000 but DB has 3000.',
          action: 'RECOVER_POSITION',
        },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: {
          text: 'Recovering position abc-123. Fetching on-chain balance and updating database to match.',
          action: 'RECOVER_POSITION',
        },
      } as ActionExample,
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text ?? '';
    // Must contain discrepancy-related data
    return (
      text.includes('positionId') ||
      text.includes('position_id') ||
      text.includes('balance_mismatch') ||
      text.includes('missing_token_account') ||
      text.includes('orphaned_position') ||
      text.includes('discrepancy')
    );
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text ?? '';

    let discrepancy: ReconcileDiscrepancy;
    try {
      // Attempt to parse from JSON embedded in the message
      const jsonMatch = text.match(/\{[\s\S]*"positionId"[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No discrepancy JSON found in message');
      }
      discrepancy = JSON.parse(jsonMatch[0]) as ReconcileDiscrepancy;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[self-healer] recover-position: failed to parse discrepancy: ${errMsg}`);
      if (callback) {
        await callback({
          text: `Failed to parse discrepancy data: ${errMsg}`,
          action: 'RECOVER_POSITION',
        });
      }
      return { success: false, error: errMsg };
    }

    console.log(`[self-healer] recover-position: recovering ${discrepancy.positionId} (${discrepancy.type})`);

    const db = await getDb();
    const rpcUrl = await getHealthyEndpoint();

    if (!rpcUrl) {
      const msg = 'No healthy RPC endpoint available for recovery';
      console.log(`[self-healer] recover-position: ${msg}`);
      if (callback) {
        await callback({ text: msg, action: 'RECOVER_POSITION' });
      }
      return { success: false, error: msg };
    }

    const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    const walletPubkey = new PublicKey(process.env.SOLANA_WALLET_PUBLIC_KEY || '');
    const mintPubkey = new PublicKey(discrepancy.mintAddress);

    let onChainBalance = '0';
    try {
      const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, {
        mint: mintPubkey,
      });

      if (tokenAccounts.value.length > 0) {
        let totalBalance = BigInt(0);
        for (const account of tokenAccounts.value) {
          const data = account.account.data;
          const amountBytes = data.subarray(64, 72);
          const amount = BigInt(
            amountBytes[0] |
            (amountBytes[1] << 8) |
            (amountBytes[2] << 16) |
            (amountBytes[3] << 24) |
            (amountBytes[4] << 32) |
            (amountBytes[5] << 40) |
            (amountBytes[6] << 48) |
            (amountBytes[7] << 56)
          );
          totalBalance += amount;
        }
        onChainBalance = totalBalance.toString();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[self-healer] recover-position: RPC error: ${errMsg}`);
      if (callback) {
        await callback({ text: `RPC error during recovery: ${errMsg}`, action: 'RECOVER_POSITION' });
      }
      return { success: false, error: errMsg };
    }

    // Update position's token_balance in DB to match on-chain
    await db.query(
      `UPDATE positions SET token_balance = $1, last_reconciled_at = $2 WHERE id = $3`,
      [onChainBalance, Date.now(), discrepancy.positionId],
    );

    // Mark reconcile_log entries as resolved
    await db.query(
      `UPDATE reconcile_log
       SET resolved = 1, action_taken = $1
       WHERE position_id = $2 AND resolved = 0`,
      [`balance_corrected_to_${onChainBalance}`, discrepancy.positionId],
    );

    const summary = `Position ${discrepancy.positionId} recovered: ` +
      `DB balance updated from ${discrepancy.dbBalance} to ${onChainBalance}. ` +
      `Discrepancy type: ${discrepancy.type}. Reconcile log marked resolved.`;

    console.log(`[self-healer] recover-position: ${summary}`);

    if (callback) {
      await callback({ text: summary, action: 'RECOVER_POSITION' });
    }

    return {
      success: true,
      positionId: discrepancy.positionId,
      previousBalance: discrepancy.dbBalance,
      newBalance: onChainBalance,
      type: discrepancy.type,
    };
  },
};

export default recoverPositionAction;
