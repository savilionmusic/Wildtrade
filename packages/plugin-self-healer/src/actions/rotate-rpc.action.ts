import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from '@elizaos/core';
import { forceRotate, getHealthyEndpoint } from '../services/rpc-rotator.service.js';

const rotateRpcAction: Action = {
  name: 'ROTATE_RPC',
  description: 'Force rotate the active Solana RPC endpoint to the next healthy one in the pool.',
  similes: ['SWITCH_RPC', 'CHANGE_RPC', 'NEXT_RPC'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: {
          text: 'The current RPC endpoint is failing. Rotate to the next one.',
          action: 'ROTATE_RPC',
        },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: {
          text: 'Rotating RPC endpoint. Marking current as unhealthy and switching to next available.',
          action: 'ROTATE_RPC',
        },
      } as ActionExample,
    ],
  ],

  validate: async (_runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    console.log('[self-healer] rotate-rpc: force rotating RPC endpoint');

    const { previousUrl, newUrl } = await forceRotate();

    if (!newUrl) {
      const msg = 'RPC rotation failed: no healthy endpoints remaining in the pool. ' +
        'All endpoints are marked unhealthy. Health checks will attempt to restore them.';
      console.log(`[self-healer] rotate-rpc: ${msg}`);
      if (callback) {
        await callback({ text: msg, action: 'ROTATE_RPC' });
      }
      return { success: false, previousUrl, newUrl: null };
    }

    const summary = `RPC endpoint rotated successfully. ` +
      `Previous: ${previousUrl ?? 'none'}. ` +
      `New active endpoint: ${newUrl}`;

    console.log(`[self-healer] rotate-rpc: ${summary}`);

    if (callback) {
      await callback({ text: summary, action: 'ROTATE_RPC' });
    }

    return { success: true, previousUrl, newUrl };
  },
};

export default rotateRpcAction;
