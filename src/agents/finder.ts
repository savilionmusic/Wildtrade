import { AgentRuntime } from '@elizaos/core';
import type { Character } from '@elizaos/core';
import { pluginAlphaScout } from '@wildtrade/plugin-alpha-scout';
import { pluginSelfHealer } from '@wildtrade/plugin-self-healer';
import finderCharacter from '../../characters/finder.character.json';

export function createFinderRuntime(token: string): AgentRuntime {
  const character = finderCharacter as unknown as Character;
  character.settings = character.settings || {};
  character.settings.secrets = {
    ...character.settings.secrets,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  };

  return new AgentRuntime({
    token,
    modelProvider: 'openrouter' as any,
    character,
    plugins: [pluginAlphaScout, pluginSelfHealer],
    logging: process.env.LOG_LEVEL === 'debug',
  });
}
