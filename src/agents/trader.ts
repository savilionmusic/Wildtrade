import { AgentRuntime } from '@elizaos/core';
import type { Character } from '@elizaos/core';
import { pluginSmartTrader } from '@wildtrade/plugin-smart-trader';
import { pluginSelfHealer } from '@wildtrade/plugin-self-healer';
import traderCharacter from '../../characters/trader.character.json';

export function createTraderRuntime(token: string): AgentRuntime {
  const character = traderCharacter as unknown as Character;
  character.settings = character.settings || {};
  character.settings.secrets = {
    ...character.settings.secrets,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  };

  return new AgentRuntime({
    token,
    modelProvider: 'openrouter' as any,
    character,
    plugins: [pluginSmartTrader, pluginSelfHealer],
    logging: process.env.LOG_LEVEL === 'debug',
  });
}
