import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { getRecentSmartBuys } from '../services/smart-money-monitor.service.js';

const whaleActivityProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string | null> => {
    console.log('[alpha-scout] Fetching whale activity for provider');

    const activity = getRecentSmartBuys();
    if (activity.length === 0) {
      return 'No recent whale activity detected.';
    }

    const lines = activity.slice(0, 20).map((tx) => {
      const walletShort = `${tx.wallet.slice(0, 4)}...${tx.wallet.slice(-4)}`;
      const tokenShort = `${tx.tokenAddress.slice(0, 4)}...${tx.tokenAddress.slice(-4)}`;
      const solAmount = tx.solAmount > 0 ? ` (${tx.solAmount.toFixed(2)} SOL)` : '';
      const time = new Date(tx.timestamp).toISOString();
      return `  ${walletShort} BOUGHT ${tx.tokenSymbol || tokenShort}${solAmount} at ${time}`;
    });

    return [
      `Recent Whale Activity (${activity.length} transfers):`,
      ...lines,
      activity.length > 20 ? `  ... and ${activity.length - 20} more` : '',
    ].filter(Boolean).join('\n');
  },
};

export default whaleActivityProvider;
