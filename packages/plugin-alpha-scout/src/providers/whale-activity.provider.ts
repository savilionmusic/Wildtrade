import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';
import { getCachedWhaleActivity } from '../services/helius.service.js';

const whaleActivityProvider: Provider = {
  get: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<string | null> => {
    console.log('[alpha-scout] Fetching whale activity for provider');

    const activity = await getCachedWhaleActivity();
    if (activity.length === 0) {
      return 'No recent whale activity detected.';
    }

    const lines = activity.slice(0, 20).map((tx) => {
      const direction = tx.type === 'buy' ? 'BOUGHT' : 'SOLD';
      const walletShort = `${tx.wallet.slice(0, 4)}...${tx.wallet.slice(-4)}`;
      const mintShort = `${tx.mint.slice(0, 4)}...${tx.mint.slice(-4)}`;
      const solAmount = tx.amountSol > 0 ? ` (${tx.amountSol.toFixed(2)} SOL)` : '';
      const time = new Date(tx.timestamp).toISOString();
      return `  ${walletShort} ${direction} ${mintShort}${solAmount} at ${time}`;
    });

    return [
      `Recent Whale Activity (${activity.length} transfers):`,
      ...lines,
      activity.length > 20 ? `  ... and ${activity.length - 20} more` : '',
    ].filter(Boolean).join('\n');
  },
};

export default whaleActivityProvider;
