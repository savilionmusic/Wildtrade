import { AgentRuntime } from '@elizaos/core';
import type { Character, IDatabaseAdapter } from '@elizaos/core';
import { pluginSelfHealer } from '@wildtrade/plugin-self-healer';
import auditorCharacter from '../../characters/auditor.character.json';

export function createAuditorRuntime(token: string, databaseAdapter: IDatabaseAdapter): AgentRuntime {
  const character = auditorCharacter as unknown as Character;
  character.settings = character.settings || {};
  character.settings.secrets = {
    ...character.settings.secrets,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY || '',
  };

  return new AgentRuntime({
    token,
    modelProvider: 'openrouter' as any,
    character,
    databaseAdapter,
    plugins: [pluginSelfHealer],
    logging: process.env.LOG_LEVEL === 'debug',
  });
}
