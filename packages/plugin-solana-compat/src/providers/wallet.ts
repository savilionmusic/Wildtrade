import type { IAgentRuntime, Provider, State } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import BigNumber from 'bignumber.js';
import { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from '../constants.js';
import { getWalletKey } from '../keypair-utils.js';
import type { SolanaService } from '../service.js';
import type { WalletPortfolio } from '../types.js';

export const walletProvider: Provider = {
  get: async (runtime: IAgentRuntime, _message: unknown, state?: State): Promise<string | null> => {
    try {
      const solanaService = runtime.getService(SOLANA_SERVICE_NAME as any) as SolanaService | null;
      if (!solanaService) return null;

      const portfolioCache = await runtime.cacheManager.get<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY);
      const portfolio = portfolioCache ?? await solanaService.updateWalletData(true);
      if (!portfolio) return null;

      const { publicKey } = await getWalletKey(runtime, false);
      const pubkeyStr = publicKey ? ` (${publicKey.toBase58()})` : '';
      const agentName = (state as any)?.agentName ?? runtime.character.name ?? 'The agent';

      const totalSol = portfolio.totalSol ?? '0';
      const totalUsd = new BigNumber(portfolio.totalUsd).toFixed(2);

      const tokenLines: string[] = [];
      portfolio.items.forEach((item) => {
        if (new BigNumber(item.uiAmount).isGreaterThan(0)) {
          tokenLines.push(
            `  ${item.symbol || item.name} (${item.address}): ${new BigNumber(item.uiAmount).toFixed(6)} ($${new BigNumber(item.valueUsd).toFixed(2)})`,
          );
        }
      });

      let text = `${agentName}'s Solana Wallet${pubkeyStr}:\n`;
      text += `  Total: $${totalUsd} (~${totalSol} SOL)\n`;
      if (tokenLines.length > 0) {
        text += `  Tokens:\n${tokenLines.join('\n')}\n`;
      } else {
        text += '  No token holdings.\n';
      }

      return text;
    } catch (error) {
      elizaLogger.error('walletProvider error:', error);
      return null;
    }
  },
};
