import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import { LAMPORTS_PER_SOL, SOL_MINT } from '@wildtrade/shared';
import { getPosition, updatePosition } from '../services/position.service.js';
import { getQuote, executeSwap } from '../services/jupiter.service.js';
import { getPublicKey } from '../lib/wallet.js';

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';

function extractPositionId(text: string): string | null {
  const uuidMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch ? uuidMatch[0] : null;
}

export const cancelPositionAction: Action = {
  name: 'CANCEL_POSITION',
  description: 'Cancel an existing position by selling all remaining tokens and closing the position',
  similes: ['CLOSE_POSITION', 'EXIT_ALL', 'DUMP_POSITION', 'EMERGENCY_EXIT'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Cancel position abc12345-1234-1234-1234-123456789abc',
        },
      },
      {
        user: '{{agent}}',
        content: {
          text: 'Position abc12345 cancelled. Sold all remaining tokens. Received 0.3 SOL. Realized PnL: -0.2 SOL.',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text || '';
    return /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text);
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text || '';

    const positionId = extractPositionId(text);
    if (!positionId) {
      if (callback) await callback({ text: 'Could not extract position ID from message.' });
      return { success: false, error: 'No position ID found' };
    }

    const position = await getPosition(positionId);
    if (!position) {
      if (callback) await callback({ text: `Position ${positionId} not found.` });
      return { success: false, error: 'Position not found' };
    }

    if (position.status === 'closed' || position.status === 'cancelled' || position.status === 'failed') {
      if (callback) await callback({ text: `Position ${positionId} is already ${position.status}.` });
      return { success: false, error: `Position already ${position.status}` };
    }

    console.log(`[smart-trader] Cancelling position ${positionId} (${position.mintAddress})`);

    const tokenBalance = BigInt(position.tokenBalance);
    let receivedSol = 0;

    if (tokenBalance > 0n) {
      try {
        if (PAPER_TRADING) {
          const price = position.currentPriceSol || position.entryPriceSol;
          receivedSol = Number(tokenBalance) * price;

          console.log(`[smart-trader] [PAPER] Sold all ${tokenBalance.toString()} tokens at ${price} SOL, received ${receivedSol.toFixed(6)} SOL`);
        } else {
          const quote = await getQuote(
            position.mintAddress,
            SOL_MINT,
            tokenBalance.toString(),
          );

          const publicKey = getPublicKey();
          await executeSwap(quote, publicKey);

          receivedSol = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;

          console.log(`[smart-trader] Sold all ${tokenBalance.toString()} tokens, received ${receivedSol.toFixed(6)} SOL`);
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`[smart-trader] Failed to sell tokens during cancellation: ${errMsg}`);

        if (callback) await callback({ text: `Failed to sell remaining tokens: ${errMsg}. Position marked as failed.` });

        await updatePosition(positionId, {
          status: 'failed',
          closedAt: Date.now(),
        });

        return { success: false, error: errMsg };
      }
    }

    const totalBudgetSol = Number(BigInt(position.totalBudgetLamports)) / LAMPORTS_PER_SOL;
    const existingRealized = position.realizedPnlSol || 0;
    const cancellationPnl = receivedSol - (totalBudgetSol - existingRealized);
    const totalRealized = existingRealized + cancellationPnl;

    const updatedTiers = position.exitTiers.map((tier) => {
      if (tier.status === 'watching' || tier.status === 'triggered') {
        return { ...tier, status: 'failed' as const };
      }
      return tier;
    });

    await updatePosition(positionId, {
      status: 'cancelled',
      tokenBalance: '0',
      realizedPnlSol: totalRealized,
      exitTiers: updatedTiers,
      closedAt: Date.now(),
    });

    const summary = [
      `Position ${positionId} cancelled`,
      `Tokens sold: ${tokenBalance.toString()}`,
      `SOL received: ${receivedSol.toFixed(6)}`,
      `Total realized PnL: ${totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(6)} SOL`,
      `Mode: ${PAPER_TRADING ? 'PAPER' : 'LIVE'}`,
    ].join('\n');

    console.log(`[smart-trader] Cancel summary:\n${summary}`);

    if (callback) {
      await callback({ text: summary });
    }

    return {
      success: true,
      positionId,
      receivedSol,
      totalRealized,
      status: 'cancelled',
    };
  },
};
