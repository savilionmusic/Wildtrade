/**
 * Chat Handler — Routes user messages through the Finder AgentRuntime.
 *
 * Instead of calling OpenRouter directly, this processes messages through
 * ElizaOS so the agent uses her character personality, providers (market data,
 * smart money, whale activity), and can trigger actions (scan tokens, etc.).
 *
 * The Finder agent (Scout) is the team leader — she delegates to Executioner
 * and Fixer through inter-agent messaging.
 */

import {
  composeContext,
  generateMessageResponse,
  ModelClass,
  stringToUuid,
} from '@elizaos/core';
import type {
  AgentRuntime,
  Memory,
  Content,
  State,
  UUID,
} from '@elizaos/core';
import { getScannerStats } from '@wildtrade/plugin-alpha-scout';

// Stable room ID for the user↔Scout chat
const CHAT_ROOM_ID = stringToUuid('wildtrade-user-chat-room');
const CHAT_USER_ID = stringToUuid('wildtrade-desktop-user');

// Track recent proactive alerts so the agent knows what just happened
const recentAlerts: Array<{ type: string; message: string; timestamp: number }> = [];
const MAX_ALERTS = 20;

export function addProactiveAlert(type: string, message: string): void {
  recentAlerts.push({ type, message, timestamp: Date.now() });
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.shift();
}

export function getRecentAlerts(): typeof recentAlerts {
  return recentAlerts;
}

/**
 * Process a user chat message through the Finder AgentRuntime.
 * Returns the agent's response text.
 */
export async function handleChatMessage(
  runtime: AgentRuntime,
  userText: string,
): Promise<{ text: string; action?: string }> {
  // 1. Create a Memory for the user's message
  const userMessage: Memory = {
    id: stringToUuid(`msg-${Date.now()}-${Math.random().toString(36).slice(2)}`),
    userId: CHAT_USER_ID,
    agentId: runtime.agentId,
    roomId: CHAT_ROOM_ID,
    content: {
      text: userText,
      source: 'desktop-chat',
    },
    createdAt: Date.now(),
  };

  try {
    await runtime.messageManager.createMemory(userMessage);
  } catch {
    // Memory creation may fail on first message if room doesn't exist — continue anyway
  }

  // 2. Compose state from all providers (market data, smart money, whale activity)
  let state: State;
  try {
    state = await runtime.composeState(userMessage);
  } catch (err) {
    console.log(`[chat] composeState failed: ${err}`);
    // Fallback to minimal state
    state = {
      bio: (runtime.character.bio as string[])?.join(' ') ?? '',
      lore: (runtime.character.lore as string[])?.join(' ') ?? '',
      messageDirections: '',
      postDirections: '',
      roomId: CHAT_ROOM_ID,
      agentName: runtime.character.name,
      senderName: 'User',
      actors: '',
      recentMessages: '',
      recentMessagesData: [],
      providers: '',
    };
  }

  // 3. Inject additional trading context into state
  const scannerStats = getScannerStats();
  const alertsText = recentAlerts
    .slice(-10)
    .map(a => {
      const ago = Math.round((Date.now() - a.timestamp) / 60000);
      return `[${ago}m ago] ${a.type}: ${a.message}`;
    })
    .join('\n');

  const paperMode = process.env.PAPER_TRADING !== 'false';
  const budget = process.env.TOTAL_BUDGET_SOL || '1.0';

  const tradingContext = [
    `\n=== Trading Status ===`,
    `Mode: ${paperMode ? 'PAPER TRADING (simulated)' : 'LIVE TRADING'}`,
    `Budget: ${budget} SOL`,
    `Scanner: ${scannerStats.running ? 'ACTIVE' : 'stopped'} | Processed: ${scannerStats.processed} tokens | Signals: ${scannerStats.signals} | Forwarded to Trader: ${scannerStats.forwarded}`,
    `Queue: ${scannerStats.queueSize} tokens waiting`,
    alertsText ? `\n=== Recent Activity ===\n${alertsText}` : '(no recent activity)',
  ].join('\n');

  // Append trading context to providers
  state.providers = (state.providers || '') + tradingContext;

  // 4. Build the response template
  const template = `# About {{agentName}}
{{bio}}

# Lore
{{lore}}

# Current conversation
{{recentMessages}}

# Live data from your systems
{{providers}}

# Available actions you can take: {{actionNames}}
{{actions}}

Respond to the user's latest message as {{agentName}}, the Wildtrade team leader. You are their personal trading partner managing the 10 SOL challenge. Be proactive, reference real data from your providers above, and take action when appropriate. Keep responses punchy (2-4 sentences) unless they ask for detail.

{{actionExamples}}

Response format should be formatted in a valid JSON block like this:
\`\`\`json
{ "user": "{{agentName}}", "text": "<string>", "action": "<AVAILABLE_ACTION or null>" }
\`\`\``;

  const context = composeContext({ state, template });

  // 5. Generate response using the agent's configured model
  let response: Content;
  try {
    response = await generateMessageResponse({
      runtime,
      context,
      modelClass: ModelClass.LARGE,
    });
  } catch (err) {
    console.log(`[chat] generateMessageResponse failed: ${err}`);
    return { text: "yo my brain glitched for a sec — try again? If this keeps happening, check your OpenRouter API key in Settings." };
  }

  if (!response || !response.text) {
    return { text: "hmm didn't get a response from the model. Make sure your OpenRouter API key is set in Settings." };
  }

  // 6. Save the agent's response as a memory
  try {
    const responseMemory: Memory = {
      id: stringToUuid(`resp-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      userId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: CHAT_ROOM_ID,
      content: response,
      createdAt: Date.now(),
    };
    await runtime.messageManager.createMemory(responseMemory);

    // 7. Process any actions the model chose (e.g., SCAN_NEW_TOKEN)
    if (response.action && response.action !== 'null' && response.action !== 'NONE') {
      console.log(`[chat] Agent chose action: ${response.action}`);
      try {
        await runtime.processActions(
          userMessage,
          [responseMemory],
          state,
          async (actionResult: Content) => {
            console.log(`[chat] Action ${response.action} result: ${actionResult.text?.slice(0, 100)}`);
            // Send action result back to parent process for display
            if (process.send) {
              process.send({
                type: 'chat:action-result',
                action: response.action,
                result: actionResult.text,
              });
            }
            return [];
          },
        );
      } catch (err) {
        console.log(`[chat] Action processing error: ${err}`);
      }
    }

    // 8. Run evaluators
    try {
      await runtime.evaluate(userMessage, state, true);
    } catch {
      // Evaluators are optional
    }
  } catch (err) {
    console.log(`[chat] Post-response processing error: ${err}`);
  }

  return { text: response.text, action: response.action ?? undefined };
}
