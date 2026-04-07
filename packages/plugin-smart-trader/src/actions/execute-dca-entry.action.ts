import type { Action, IAgentRuntime, Memory, State, HandlerCallback } from '@elizaos/core';
import type { AlphaSignal } from '@wildtrade/shared';
import { LAMPORTS_PER_SOL, SOL_MINT } from '@wildtrade/shared';
import { createPosition, updatePosition } from '../services/position.service.js';
import { getQuote, executeSwap, getPrice } from '../services/jupiter.service.js';
import { getPublicKey } from '../lib/wallet.js';

const TOTAL_BUDGET_SOL = Number(process.env.TOTAL_BUDGET_SOL || '1');
const MAX_POSITION_SIZE_SOL = Number(process.env.MAX_POSITION_SIZE_SOL || '0.5');
const PAPER_TRADING = process.env.PAPER_TRADING === 'true';
const AUTONOMOUS_MODE = process.env.AUTONOMOUS_MODE === 'true';

function extractSignalFromText(text: string): AlphaSignal | null {
  const jsonMatch = text.match(/\{[\s\S]*"mintAddress"[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]) as AlphaSignal;
  } catch {
    return null;
  }
}

function computeBudgetLamports(conviction: string): string {
  let multiplier = 0.6;
  if (conviction === 'high') {
    multiplier = 1.0;
  } else if (conviction === 'medium') {
    multiplier = 0.6;
  } else {
    multiplier = 0.3;
  }
  const budgetSol = TOTAL_BUDGET_SOL * multiplier;
  const budgetLamports = BigInt(Math.floor(budgetSol * LAMPORTS_PER_SOL));
  return budgetLamports.toString();
}

export const executeDcaEntryAction: Action = {
  name: 'EXECUTE_DCA_ENTRY',
  description: 'Execute a DCA entry for a new trading position based on an alpha signal',
  similes: ['DCA_ENTRY', 'OPEN_POSITION', 'BUY_TOKEN', 'ENTER_TRADE'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'Execute DCA entry for signal: {"id":"sig-001","mintAddress":"TokenMint123","symbol":"TEST","name":"Test Token","marketCapUsd":50000,"liquidityUsd":10000,"sources":["pumpportal"],"score":{"volumeScore":20,"holderScore":20,"socialScore":15,"whaleScore":15,"total":70,"conviction":"medium"},"discoveredAt":1700000000000,"expiresAt":1700001800000,"tweetUrls":[],"whaleWallets":[],"rugcheckPassed":true,"creatorAddress":"Creator123","inDenylist":false}',
        },
      },
      {
        user: '{{agent}}',
        content: {
          text: 'Position created and DCA entry initiated for TEST (TokenMint123). Budget: 0.6 SOL across 3 DCA legs (20%/30%/50%).',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text || '';
    return text.includes('mintAddress');
  },

  handler: async (
    _runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : message.content?.text || '';
    const signal = extractSignalFromText(text);

    if (!signal) {
      console.log('[smart-trader] EXECUTE_DCA_ENTRY: Could not parse signal from message');
      if (callback) {
        await callback({ text: 'Failed to parse alpha signal from message content.' });
      }
      return { success: false, error: 'Invalid signal data' };
    }

    console.log(`[smart-trader] Processing DCA entry for ${signal.symbol} (${signal.mintAddress})`);

    const budgetLamports = computeBudgetLamports(signal.score.conviction);
    const budgetSol = Number(BigInt(budgetLamports)) / LAMPORTS_PER_SOL;

    const position = await createPosition(signal, budgetLamports, PAPER_TRADING);
    console.log(`[smart-trader] Position ${position.id} created with budget ${budgetSol} SOL`);

    const autoApprove = AUTONOMOUS_MODE || budgetSol <= MAX_POSITION_SIZE_SOL;

    if (autoApprove) {
      const approvedBy = AUTONOMOUS_MODE ? 'autonomous' as const : 'auto_small' as const;
      await updatePosition(position.id, {
        status: 'approved',
        approvedAt: Date.now(),
        approvedBy,
      });
      console.log(`[smart-trader] Position ${position.id} auto-approved (${approvedBy})`);
    } else {
      console.log(`[smart-trader] Position ${position.id} requires manual approval (budget ${budgetSol} SOL > max ${MAX_POSITION_SIZE_SOL} SOL)`);
      if (callback) {
        await callback({
          text: `Position ${position.id} for ${signal.symbol} requires manual approval. Budget: ${budgetSol.toFixed(4)} SOL exceeds auto-approve limit of ${MAX_POSITION_SIZE_SOL} SOL.`,
        });
      }
      return { success: true, positionId: position.id, status: 'pending_approval' };
    }

    await updatePosition(position.id, { status: 'dca_filling' });

    let totalTokensAcquired = BigInt(0);
    let weightedPriceSum = 0;
    let totalWeightedAmount = 0;
    const updatedLegs = [...position.dcaLegs];

    for (const leg of updatedLegs) {
      if (leg.scheduledAt > Date.now()) {
        console.log(`[smart-trader] Leg ${leg.legIndex} scheduled for later (${new Date(leg.scheduledAt).toISOString()})`);
        continue;
      }

      try {
        leg.status = 'submitted';

        if (PAPER_TRADING) {
          const priceData = await getPrice([signal.mintAddress]);
          const tokenPrice = priceData[signal.mintAddress]?.price;

          if (!tokenPrice || tokenPrice <= 0) {
            console.log(`[smart-trader] No price data for ${signal.mintAddress}, using market cap estimate`);
            const estimatedPrice = signal.marketCapUsd > 0 ? signal.liquidityUsd / signal.marketCapUsd : 0.000001;
            const inputSol = Number(BigInt(leg.inputAmountLamports)) / LAMPORTS_PER_SOL;
            const outputTokens = Math.floor(inputSol / estimatedPrice);
            leg.outputAmountTokens = String(outputTokens);
            leg.averagePriceSol = estimatedPrice;
          } else {
            const inputSol = Number(BigInt(leg.inputAmountLamports)) / LAMPORTS_PER_SOL;
            const outputTokens = Math.floor(inputSol / tokenPrice);
            leg.outputAmountTokens = String(outputTokens);
            leg.averagePriceSol = tokenPrice;
          }

          leg.executedAt = Date.now();
          leg.txSignature = `paper-${position.id}-leg${leg.legIndex}`;
          leg.status = 'confirmed';

          console.log(`[smart-trader] [PAPER] Leg ${leg.legIndex} filled: ${leg.outputAmountTokens} tokens at ${leg.averagePriceSol} SOL`);
        } else {
          const quote = await getQuote(
            SOL_MINT,
            signal.mintAddress,
            leg.inputAmountLamports,
          );

          const publicKey = getPublicKey();
          const swapResult = await executeSwap(quote, publicKey);

          leg.outputAmountTokens = quote.outAmount;
          const inputSol = Number(BigInt(leg.inputAmountLamports)) / LAMPORTS_PER_SOL;
          const outputTokens = Number(BigInt(quote.outAmount));
          leg.averagePriceSol = outputTokens > 0 ? inputSol / outputTokens : 0;
          leg.executedAt = Date.now();
          leg.txSignature = swapResult.swapTransaction.slice(0, 88);
          leg.status = 'confirmed';

          console.log(`[smart-trader] Leg ${leg.legIndex} filled: ${leg.outputAmountTokens} tokens, tx=${leg.txSignature}`);
        }

        const tokensFromLeg = BigInt(leg.outputAmountTokens || '0');
        totalTokensAcquired += tokensFromLeg;

        if (leg.averagePriceSol && leg.averagePriceSol > 0) {
          const legWeight = Number(BigInt(leg.inputAmountLamports)) / LAMPORTS_PER_SOL;
          weightedPriceSum += leg.averagePriceSol * legWeight;
          totalWeightedAmount += legWeight;
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(`[smart-trader] Leg ${leg.legIndex} failed: ${errMsg}`);
        leg.status = 'failed';
        leg.failureReason = errMsg;
      }
    }

    const entryPrice = totalWeightedAmount > 0 ? weightedPriceSum / totalWeightedAmount : 0;
    const allLegsProcessed = updatedLegs.every((l) => l.status === 'confirmed' || l.status === 'failed');
    const anyConfirmed = updatedLegs.some((l) => l.status === 'confirmed');
    const allFailed = updatedLegs.every((l) => l.status === 'failed');

    let newStatus: 'open' | 'dca_filling' | 'failed';
    if (allFailed) {
      newStatus = 'failed';
    } else if (allLegsProcessed && anyConfirmed) {
      newStatus = 'open';
    } else {
      newStatus = 'dca_filling';
    }

    await updatePosition(position.id, {
      status: newStatus,
      entryPriceSol: entryPrice,
      currentPriceSol: entryPrice,
      tokenBalance: totalTokensAcquired.toString(),
      dcaLegs: updatedLegs,
    });

    const summary = [
      `Position ${position.id} for ${signal.symbol} (${signal.mintAddress})`,
      `Status: ${newStatus}`,
      `Budget: ${budgetSol.toFixed(4)} SOL (conviction: ${signal.score.conviction})`,
      `Tokens acquired: ${totalTokensAcquired.toString()}`,
      `Entry price: ${entryPrice.toFixed(10)} SOL`,
      `DCA legs: ${updatedLegs.filter((l) => l.status === 'confirmed').length}/${updatedLegs.length} filled`,
      `Mode: ${PAPER_TRADING ? 'PAPER' : 'LIVE'}`,
    ].join('\n');

    console.log(`[smart-trader] DCA entry summary:\n${summary}`);

    if (callback) {
      await callback({ text: summary });
    }

    return {
      success: true,
      positionId: position.id,
      status: newStatus,
      entryPrice,
      tokenBalance: totalTokensAcquired.toString(),
    };
  },
};
