/**
 * Smart Money Activity Provider — Shows recent smart wallet buys
 * and cluster detection results to the agent.
 */

import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { getRecentSmartBuys, getMonitorStatus } from '../services/smart-money-monitor.service.js';

const smartMoneyProvider: Provider = {
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<string> => {
    const status = getMonitorStatus();
    const buys = getRecentSmartBuys();

    if (!status.running) {
      return 'Smart money monitor is not running.';
    }

    const lines: string[] = [
      '=== Smart Money Monitor ===',
      `Tracking: ${status.trackedWallets} wallets`,
      `Recent buys in window: ${status.recentBuys}`,
      `Signals emitted: ${status.emittedSignals}`,
      '',
    ];

    if (buys.length === 0) {
      lines.push('No recent smart money buys detected.');
    } else {
      lines.push(`Last ${Math.min(buys.length, 15)} smart money buys:`);

      // Group by token for readability
      const byToken = new Map<string, typeof buys>();
      for (const buy of buys.slice(0, 30)) {
        const existing = byToken.get(buy.tokenAddress) || [];
        existing.push(buy);
        byToken.set(buy.tokenAddress, existing);
      }

      for (const [token, tokenBuys] of byToken) {
        const symbol = tokenBuys[0].tokenSymbol || token.slice(0, 8);
        const uniqueWallets = new Set(tokenBuys.map(b => b.wallet)).size;
        const totalSol = tokenBuys.reduce((s, b) => s + b.solAmount, 0);
        const avgScore = tokenBuys.reduce((s, b) => s + b.qualityScore, 0) / tokenBuys.length;

        lines.push(
          `  ${symbol}: ${uniqueWallets} wallets, ${totalSol.toFixed(2)} SOL, avg quality ${avgScore.toFixed(0)}`,
        );
      }
    }

    return lines.join('\n');
  },
};

export default smartMoneyProvider;
