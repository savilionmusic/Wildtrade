import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { getPortfolioSummary, getOpenPositions } from '../services/position.service.js';

export const portfolioProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string | null> => {
    try {
      const summary = await getPortfolioSummary();
      const openPositions = await getOpenPositions();

      const lines: string[] = [
        '=== Portfolio Summary ===',
        `Open positions: ${summary.openCount}`,
        `Total deployed: ${summary.totalDeployed.toFixed(4)} SOL`,
        `Unrealized PnL: ${summary.totalUnrealized >= 0 ? '+' : ''}${summary.totalUnrealized.toFixed(4)} SOL`,
        `Realized PnL: ${summary.totalRealized >= 0 ? '+' : ''}${summary.totalRealized.toFixed(4)} SOL`,
        `Win rate: ${summary.winRate.toFixed(1)}%`,
        '',
      ];

      if (openPositions.length > 0) {
        lines.push('--- Open Positions ---');
        for (const pos of openPositions) {
          const pnlStr = pos.unrealizedPnlSol !== undefined
            ? `${pos.unrealizedPnlSol >= 0 ? '+' : ''}${pos.unrealizedPnlSol.toFixed(4)} SOL`
            : 'N/A';

          const filledTiers = pos.exitTiers.filter((t) => t.status === 'filled').length;
          const budgetSol = Number(BigInt(pos.totalBudgetLamports)) / 1e9;

          lines.push(
            `  [${pos.id.slice(0, 8)}] ${pos.mintAddress.slice(0, 8)}...`,
            `    Status: ${pos.status} | Budget: ${budgetSol.toFixed(4)} SOL`,
            `    Entry: ${pos.entryPriceSol.toFixed(10)} | Current: ${pos.currentPriceSol?.toFixed(10) || 'N/A'}`,
            `    Tokens: ${pos.tokenBalance} | PnL: ${pnlStr}`,
            `    Exit tiers filled: ${filledTiers}/${pos.exitTiers.length}`,
            `    Paper: ${pos.isPaperTrade ? 'Yes' : 'No'}`,
            '',
          );
        }
      } else {
        lines.push('No open positions.');
      }

      return lines.join('\n');
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.log(`[smart-trader] Portfolio provider error: ${errMsg}`);
      return `Portfolio data unavailable: ${errMsg}`;
    }
  },
};
