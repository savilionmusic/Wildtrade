import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { LAMPORTS_PER_SOL } from '@wildtrade/shared';
import { getOpenPositions, updatePosition } from '../services/position.service.js';
import { getPrice } from '../services/jupiter.service.js';

export const priceMonitorProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string | null> => {
    try {
      const positions = await getOpenPositions();

      if (positions.length === 0) {
        return 'No open positions to monitor.';
      }

      const mints = [...new Set(positions.map((p) => p.mintAddress))];
      const priceData = await getPrice(mints);

      const lines: string[] = ['=== Price Monitor Update ===', ''];
      const exitAlerts: string[] = [];

      for (const position of positions) {
        const priceInfo = priceData[position.mintAddress];
        const currentPrice = priceInfo?.price;

        if (currentPrice === undefined || currentPrice === null) {
          lines.push(`  [${position.id.slice(0, 8)}] ${position.mintAddress.slice(0, 8)}... - Price unavailable`);
          continue;
        }

        const tokenBalanceNum = Number(BigInt(position.tokenBalance));
        const currentValueSol = tokenBalanceNum * currentPrice;
        const budgetSol = Number(BigInt(position.totalBudgetLamports)) / LAMPORTS_PER_SOL;
        const unrealizedPnl = currentValueSol - budgetSol + (position.realizedPnlSol || 0);

        await updatePosition(position.id, {
          currentPriceSol: currentPrice,
          unrealizedPnlSol: unrealizedPnl,
          lastReconciledAt: Date.now(),
        });

        const priceChangeMultiple = position.entryPriceSol > 0
          ? currentPrice / position.entryPriceSol
          : 0;

        lines.push(
          `  [${position.id.slice(0, 8)}] ${position.mintAddress.slice(0, 8)}...`,
          `    Price: ${currentPrice.toFixed(10)} SOL (${priceChangeMultiple.toFixed(2)}x entry)`,
          `    Unrealized PnL: ${unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(6)} SOL`,
        );

        for (const tier of position.exitTiers) {
          if (tier.status !== 'watching') continue;

          if (priceChangeMultiple >= tier.targetMultiple) {
            exitAlerts.push(
              `EXIT ALERT: Position ${position.id.slice(0, 8)} hit ${tier.targetMultiple}x target ` +
              `(current: ${priceChangeMultiple.toFixed(2)}x). Tier ${tier.tierIndex} ready to trigger.`,
            );
          }
        }

        lines.push('');
      }

      if (exitAlerts.length > 0) {
        lines.push('--- Exit Alerts ---');
        for (const alert of exitAlerts) {
          lines.push(`  ${alert}`);
        }
        lines.push('');
      }

      const result = lines.join('\n');
      console.log(`[smart-trader] Price monitor: updated ${positions.length} position(s), ${exitAlerts.length} alert(s)`);
      return result;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`[smart-trader] Price monitor error: ${errMsg}`);
      return `Price monitor error: ${errMsg}`;
    }
  },
};
