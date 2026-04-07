import type { Evaluator, IAgentRuntime, Memory } from '@elizaos/core';
import { getOpenPositions } from '../services/position.service.js';
import { getPrice } from '../services/jupiter.service.js';

export const exitConditionEvaluator: Evaluator = {
  name: 'EXIT_CONDITION_EVALUATOR',
  description: 'Evaluates open positions against exit tier thresholds and logs recommendations when price targets are hit',
  similes: ['CHECK_EXIT_CONDITIONS', 'EVALUATE_TAKE_PROFIT', 'MONITOR_POSITIONS'],
  alwaysRun: false,
  examples: [
    {
      context: 'Evaluating open positions for exit conditions',
      messages: [
        {
          user: '{{user1}}',
          content: {
            text: 'Check if any positions have hit their exit targets',
          },
        },
      ],
      outcome: 'Scanned 3 open positions. Position abc12345 has hit 2x target - recommend triggering tier 0 exit.',
    },
  ],

  validate: async (_runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    try {
      const positions = await getOpenPositions();
      return positions.length > 0;
    } catch {
      return false;
    }
  },

  handler: async (_runtime: IAgentRuntime, _message: Memory): Promise<void> => {
    try {
      const positions = await getOpenPositions();

      if (positions.length === 0) {
        console.log('[smart-trader] Exit evaluator: no open positions to evaluate');
        return;
      }

      const mints = [...new Set(positions.map((p) => p.mintAddress))];
      const priceData = await getPrice(mints);

      let alertCount = 0;

      for (const position of positions) {
        if (position.status !== 'open' && position.status !== 'partial_exit') {
          continue;
        }

        const priceInfo = priceData[position.mintAddress];
        if (!priceInfo?.price || position.entryPriceSol <= 0) {
          continue;
        }

        const currentPrice = priceInfo.price;
        const priceMultiple = currentPrice / position.entryPriceSol;

        for (const tier of position.exitTiers) {
          if (tier.status !== 'watching') continue;

          if (priceMultiple >= tier.targetMultiple) {
            alertCount++;
            console.log(
              `[smart-trader] EXIT RECOMMENDATION: Position ${position.id} ` +
              `(${position.mintAddress.slice(0, 8)}...) has reached ${priceMultiple.toFixed(2)}x ` +
              `(target: ${tier.targetMultiple}x). Recommend triggering tier ${tier.tierIndex} ` +
              `to sell ${tier.sellPercent}% of holdings.`,
            );
          }
        }

        if (priceMultiple < 0.5) {
          console.log(
            `[smart-trader] STOP-LOSS WARNING: Position ${position.id} ` +
            `(${position.mintAddress.slice(0, 8)}...) is down ${((1 - priceMultiple) * 100).toFixed(1)}% ` +
            `from entry. Current multiple: ${priceMultiple.toFixed(4)}x. Consider cancelling.`,
          );
        }
      }

      console.log(
        `[smart-trader] Exit evaluator: scanned ${positions.length} position(s), ${alertCount} exit alert(s)`,
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`[smart-trader] Exit evaluator error: ${errMsg}`);
    }
  },
};
