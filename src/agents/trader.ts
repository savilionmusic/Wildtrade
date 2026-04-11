import { AgentRuntime } from '@elizaos/core';
import type { Character, IDatabaseAdapter, Plugin } from '@elizaos/core';
import { pluginSmartTrader } from '@wildtrade/plugin-smart-trader';
import { pluginSelfHealer } from '@wildtrade/plugin-self-healer';
import { selectPrimaryHttpRpcEndpoint } from '@wildtrade/shared';
import traderCharacter from '../../characters/trader.character.json';

async function loadOptionalSolanaPlugin(): Promise<Plugin[]> {
  try {
    const mod = await import('@elizaos/plugin-solana');
    const services = [mod.SolanaService, mod.SolanaWalletService].filter(Boolean);

    if (services.length === 0) {
      return [];
    }

    return [
      {
        name: 'chain_solana',
        npmName: '@elizaos/plugin-solana',
        description: 'Optional Solana chain services',
        services: services as Plugin['services'],
      },
    ];
  } catch (error) {
    console.warn(
      `[trader] Optional @elizaos/plugin-solana unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

export async function createTraderRuntime(token: string, databaseAdapter: IDatabaseAdapter): Promise<AgentRuntime> {
  const character = traderCharacter as unknown as Character;
  character.settings = character.settings || {};
  const primaryRpcUrl = selectPrimaryHttpRpcEndpoint();
  character.settings.secrets = {
    ...character.settings.secrets,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
    SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || primaryRpcUrl,
    SOLANA_PUBLIC_KEY: process.env.SOLANA_PUBLIC_KEY || process.env.WALLET_PUBLIC_KEY || '',
    SOLANA_PRIVATE_KEY: process.env.SOLANA_PRIVATE_KEY || process.env.WALLET_PRIVATE_KEY || '',
    WALLET_PUBLIC_KEY: process.env.WALLET_PUBLIC_KEY || process.env.SOLANA_PUBLIC_KEY || '',
    WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || process.env.SOLANA_PRIVATE_KEY || '',
    HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
    SLIPPAGE: process.env.SLIPPAGE || process.env.JUPITER_SLIPPAGE_BPS || '50',
    SOL_ADDRESS: process.env.SOL_ADDRESS || 'So11111111111111111111111111111111111111112',
  };

  const optionalPlugins = await loadOptionalSolanaPlugin();

  return new AgentRuntime({
    token,
    modelProvider: 'openrouter' as any,
    character,
    databaseAdapter,
    plugins: [...optionalPlugins, pluginSmartTrader, pluginSelfHealer],
    logging: process.env.LOG_LEVEL === 'debug',
  });
}
