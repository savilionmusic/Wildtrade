import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import type { ExitTier } from '@wildtrade/shared';
import { LAMPORTS_PER_SOL, SOL_MINT } from '@wildtrade/shared';
import { getPosition, updatePosition } from '../services/position.service.js';
import { getQuote, executeSwap } from '../services/jupiter.service.js';
import { getPublicKey } from '../lib/wallet.js';

const PAPER_TRADING = process.env.PAPER_TRADING === 'true';

function extractPositionId(text: string): string | null {
  const uuidMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuidMatch ? uuidMatch[0] : null;
}

function extractTierIndex(text: string): number | null {
  const tierMatch = text.match(/tier\s*(\d)/i);
  if (tierMatch) return parseInt(tierMatch[1], 10);

  const multiplierMatch = text.match(/(\d+)x/i);
  if (multiplierMatch) {
    const mult = parseInt(multiplierMatch[1], 10);
    if (mult === 2) return 0;
    if (mult === 5) return 1;
    if (mult === 10) return 2;
  }
  return null;
}

export const triggerExitTierAction: Action = {
  name: 'TRIGGER_EXIT_TIER',
  description: 'Trigger an exit tier for an existing position, selling a portion of tokens at a profit target',
  similes: ['EXIT_TIER', 'TAKE_PROFIT', 'SELL_TIER', 'PARTIAL_EXIT'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Trigger exit tier 0 (2x) for position abc12345-1234-1234-1234-123456789abc',
        },
      },
      {
        user: '{{agent}}',
        content: {
          text: 'Exit tier 0 (2x) triggered for position abc12345. Sold 50% of tokens. Received 0.5 SOL.',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text || '';
    const hasPositionId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text);
    const hasTierRef = /tier|exit|\dx/i.test(text);
    return hasPositionId && hasTierRef;
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

    if (position.status !== 'open' && position.status !== 'partial_exit') {
      if (callback) await callback({ text: `Position ${positionId} is in status '${position.status}', cannot trigger exit.` });
      return { success: false, error: `Invalid position status: ${position.status}` };
    }

    const requestedTierIdx = extractTierIndex(text);
    let targetTier: ExitTier | undefined;

    if (requestedTierIdx !== null) {
      targetTier = position.exitTiers.find(
        (t) => t.tierIndex === requestedTierIdx && t.status === 'watching',
      );
    }

    if (!targetTier) {
      targetTier = position.exitTiers.find((t) => t.status === 'watching');
    }

    if (!targetTier) {
      if (callback) await callback({ text: `No unfilled exit tiers remaining for position ${positionId}.` });
      return { success: false, error: 'No exit tiers available' };
    }

    console.log(`[smart-trader] Triggering exit tier ${targetTier.tierIndex} (${targetTier.targetMultiple}x) for position ${positionId}`);

    const currentBalance = BigInt(position.tokenBalance);
    const sellAmount = (currentBalance * BigInt(targetTier.sellPercent)) / 100n;

    if (sellAmount <= 0n) {
      if (callback) await callback({ text: `Sell amount is zero for tier ${targetTier.tierIndex}. No tokens to sell.` });
      return { success: false, error: 'Zero sell amount' };
    }

    const updatedTiers = [...position.exitTiers];
    const tierToUpdate = updatedTiers.find((t) => t.tierIndex === targetTier!.tierIndex)!;
    tierToUpdate.status = 'triggered';
    tierToUpdate.triggeredAt = Date.now();

    let receivedSol = 0;

    try {
      if (PAPER_TRADING) {
        receivedSol = (Number(sellAmount) * (position.currentPriceSol || position.entryPriceSol)) ;
        tierToUpdate.txSignature = `paper-exit-${positionId}-tier${targetTier.tierIndex}`;
        tierToUpdate.status = 'filled';
        tierToUpdate.executedAt = Date.now();
        tierToUpdate.receivedSol = receivedSol;

        console.log(`[smart-trader] [PAPER] Exit tier ${targetTier.tierIndex}: sold ${sellAmount.toString()} tokens, received ${receivedSol.toFixed(6)} SOL`);
      } else {
        tierToUpdate.status = 'submitted';

        const quote = await getQuote(
          position.mintAddress,
          SOL_MINT,
          sellAmount.toString(),
        );

        const publicKey = getPublicKey();
        const swapResult = await executeSwap(quote, publicKey);

        receivedSol = Number(BigInt(quote.outAmount)) / LAMPORTS_PER_SOL;
        tierToUpdate.txSignature = swapResult.swapTransaction.slice(0, 88);
        tierToUpdate.status = 'filled';
        tierToUpdate.executedAt = Date.now();
        tierToUpdate.receivedSol = receivedSol;

        console.log(`[smart-trader] Exit tier ${targetTier.tierIndex}: sold ${sellAmount.toString()} tokens, received ${receivedSol.toFixed(6)} SOL, tx=${tierToUpdate.txSignature}`);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`[smart-trader] Exit tier ${targetTier.tierIndex} failed: ${errMsg}`);
      tierToUpdate.status = 'failed';

      await updatePosition(positionId, { exitTiers: updatedTiers });

      if (callback) await callback({ text: `Exit tier ${targetTier.tierIndex} failed: ${errMsg}` });
      return { success: false, error: errMsg };
    }

    const newBalance = currentBalance - sellAmount;
    const existingRealized = position.realizedPnlSol || 0;
    const inputCostForTier = (Number(BigInt(position.totalBudgetLamports)) / LAMPORTS_PER_SOL) * (targetTier.sellPercent / 100);
    const tierPnl = receivedSol - inputCostForTier;
    const totalRealized = existingRealized + tierPnl;

    const allTiersFilled = updatedTiers.every((t) => t.status === 'filled' || t.status === 'failed');
    const newStatus = allTiersFilled ? 'closed' as const : 'partial_exit' as const;

    const positionUpdate: Record<string, unknown> = {
      tokenBalance: newBalance.toString(),
      exitTiers: updatedTiers,
      realizedPnlSol: totalRealized,
      status: newStatus,
    };

    if (newStatus === 'closed') {
      positionUpdate.closedAt = Date.now();
    }

    await updatePosition(positionId, positionUpdate as Partial<import('@wildtrade/shared').TradePosition>);

    const summary = [
      `Exit tier ${targetTier.tierIndex} (${targetTier.targetMultiple}x) executed for position ${positionId}`,
      `Sold: ${sellAmount.toString()} tokens (${targetTier.sellPercent}%)`,
      `Received: ${receivedSol.toFixed(6)} SOL`,
      `Tier PnL: ${tierPnl >= 0 ? '+' : ''}${tierPnl.toFixed(6)} SOL`,
      `Total realized PnL: ${totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(6)} SOL`,
      `Remaining balance: ${newBalance.toString()} tokens`,
      `Position status: ${newStatus}`,
      `Mode: ${PAPER_TRADING ? 'PAPER' : 'LIVE'}`,
    ].join('\n');

    console.log(`[smart-trader] Exit summary:\n${summary}`);

    if (callback) {
      await callback({ text: summary });
    }

    return {
      success: true,
      positionId,
      tierIndex: targetTier.tierIndex,
      receivedSol,
      tierPnl,
      totalRealized,
      remainingBalance: newBalance.toString(),
      status: newStatus,
    };
  },
};
