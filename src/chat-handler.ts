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
import { getScannerStats, getWalletIntelStats, getKolStats } from '@wildtrade/plugin-alpha-scout';
import { getTraderStats, getOpenPositions, getTradeHistory, manualBuy, manualSell } from '@wildtrade/plugin-smart-trader';

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
  const lower = userText.toLowerCase().trim();

  // ── Direct command shortcuts (no LLM needed — instant response) ──
  // These address the user's request: "why won't chat respond to buy/sell commands?"

  // BUY command: "buy <MINT> <SOL>" or "buy <MINT>"
  const buyMatch = userText.match(/\bbuy\b\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+([\d.]+))?/i);
  if (buyMatch) {
    const mintAddress = buyMatch[1];
    const solAmount = parseFloat(buyMatch[2] ?? '0.1');
    const result = await manualBuy(mintAddress, '', solAmount);
    return { text: result };
  }

  // SELL command: "sell <MINT> <PCT>" or "sell <MINT>"
  const sellMatch = userText.match(/\bsell\b\s+([1-9A-HJ-NP-Za-km-z]{32,44})(?:\s+([\d.]+)%?)?/i);
  if (sellMatch) {
    const mintAddress = sellMatch[1];
    const pct = sellMatch[2] ? Math.min(1.0, parseFloat(sellMatch[2]) / 100) : 1.0;
    const result = await manualSell(mintAddress, pct);
    return { text: result };
  }

  // SELL ALL command
  if (/\bsell\s+all\b/i.test(userText)) {
    const openPositions = getOpenPositions();
    if (openPositions.length === 0) return { text: 'No open positions to sell.' };
    const results: string[] = [];
    for (const pos of openPositions) {
      results.push(await manualSell(pos.mintAddress, 1.0));
    }
    return { text: results.join('\n') };
  }

  // SELL HALF command
  if (/\bsell\s+half\b/i.test(userText)) {
    const openPositions = getOpenPositions();
    if (openPositions.length === 0) return { text: 'No open positions to half-sell.' };
    const results: string[] = [];
    for (const pos of openPositions) {
      results.push(await manualSell(pos.mintAddress, 0.5));
    }
    return { text: results.join('\n') };
  }

  // STATUS shortcut — instant answer without LLM latency
  if (/^(status|portfolio|positions?|pnl|balance|how are we|what.s happening)\??$/i.test(lower)) {
    const tStats = getTraderStats();
    const openPos = getOpenPositions();
    const scanStats = getScannerStats();
    let statusMsg = `Portfolio: ${tStats.deployed} SOL deployed | PnL: ${tStats.realized >= 0 ? '+' : ''}${tStats.realized} SOL | Win rate: ${tStats.winRate}% (${tStats.trades} trades) | Mode: ${process.env.PAPER_TRADING !== 'false' ? 'PAPER' : 'LIVE'}\n`;
    statusMsg += `Scanner: ${scanStats.running ? 'ACTIVE' : 'stopped'} | Processed: ${scanStats.processed} | Signals: ${scanStats.signals} | Forwarded: ${scanStats.forwarded}\n`;
    if (openPos.length > 0) {
      statusMsg += `\nOpen positions (${openPos.length}):\n`;
      for (const p of openPos) {
        const mult = p.currentPrice > 0 && p.entryPrice > 0 ? (p.currentPrice / p.entryPrice).toFixed(2) : '?';
        const pnlSign = p.pnlPct >= 0 ? '+' : '';
        statusMsg += `  ${p.symbol}: ${mult}x | ${pnlSign}${p.pnlPct.toFixed(1)}% PnL | ${p.solDeployed.toFixed(4)} SOL | DCA ${p.dcaLegsExecuted}/3 — https://dexscreener.com/solana/${p.mintAddress}\n`;
      }
    } else {
      statusMsg += 'No open positions.';
    }
    return { text: statusMsg.trim() };
  }

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
    // Fallback to minimal state with proper action metadata
    const allActions = (runtime as any).actions || [];
    const actionNames = allActions.map((a: any) => a.name).join(', ');
    const actionDescriptions = allActions.map((a: any) => `${a.name}: ${a.description}`).join('\n');

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
      actionNames: actionNames,
      actionStrings: allActions.map((a: any) => a.name),
      actions: actionDescriptions,
      actionExamples: '',
    } as any;
  }

  // 3. Inject additional trading context into state
  const scannerStats = getScannerStats();
  const walletStats = getWalletIntelStats();
  const kolStats = getKolStats();
  const alertsText = recentAlerts
    .slice(-10)
    .map(a => {
      const ago = Math.round((Date.now() - a.timestamp) / 60000);
      return `[${ago}m ago] ${a.type}: ${a.message}`;
    })
    .join('\n');

  const paperMode = process.env.PAPER_TRADING !== 'false';
  const budget = process.env.TOTAL_BUDGET_SOL || '1.0';

  // Trader stats
  const tStats = getTraderStats();
  const openPos = getOpenPositions();
  const positionsText = openPos.length > 0
    ? openPos.map(p => {
        const pnlSign = p.pnlPct >= 0 ? '+' : '';
        const mult = p.currentPrice > 0 && p.entryPrice > 0 ? (p.currentPrice / p.entryPrice).toFixed(2) : '?';
        return `  ${p.symbol} (https://dexscreener.com/solana/${p.mintAddress}): ${p.solDeployed.toFixed(4)} SOL deployed, ${mult}x, ${pnlSign}${p.pnlPct.toFixed(1)}% PnL, DCA ${p.dcaLegsExecuted}/3`;
      }).join('\n')
    : '(no open positions)';

  const tradingContext = [
    `\n=== Trading Status ===`,
    `Mode: ${paperMode ? 'PAPER TRADING (simulated)' : 'LIVE TRADING'}`,
    `Budget: ${budget} SOL | Goal: 10 SOL`,
    `Phase: ${(tStats as any).phase || 'Phase 1'} | Target MCap: ${(tStats as any).targetMCap || 'micro caps'}`,
    `Trader: ${tStats.running ? 'ACTIVE' : 'STOPPED'} | Deployed: ${tStats.deployed} SOL | Available: ${tStats.available} SOL | PnL: ${tStats.realized} SOL | Win Rate: ${tStats.winRate}% (${tStats.trades} trades)`,
    `Open Positions (${tStats.positions}):`,
    positionsText,
    `Scanner: ${scannerStats.running ? 'ACTIVE' : 'stopped'} | Processed: ${scannerStats.processed} tokens | Signals: ${scannerStats.signals} | Forwarded to Trader: ${scannerStats.forwarded}`,
    `Queue: ${scannerStats.queueSize} tokens waiting`,
    `\n=== Intelligence Systems ===`,
    `Smart Money: Tracking ${walletStats.tracked} wallets | ${walletStats.recentBuys} recent buys`,
    walletStats.topWallets.length > 0 ? `Top wallets: ${walletStats.topWallets.map(w => `${w.alias}(BES:${w.bes})`).join(', ')}` : '',
    `KOL Intel: ${kolStats.running ? 'ACTIVE' : 'stopped'} | ${kolStats.totalSignals} total signals | ${kolStats.recentSignals} in last 5min`,
    alertsText ? `\n=== Recent Activity (IMPORTANT — reference this!) ===\n${alertsText}` : '(no recent activity — scanning is active, waiting for signals)',
  ].join('\n');

  // Add recent trade history for learning context
  const history = getTradeHistory().slice(-5);
  const historyText = history.length > 0
    ? '\n=== Last 5 Trades ===\n' + history.map(t => {
        const sign = t.pnlPct >= 0 ? '+' : '';
        const mins = Math.round(t.holdTimeMs / 60000);
        return `  ${t.symbol}: ${sign}${t.pnlPct.toFixed(1)}% | held ${mins}m | exit: ${t.exitReason}`;
      }).join('\n')
    : '';

  // Append trading context to providers
  state.providers = (state.providers || '') + tradingContext + historyText;

  // 4. Build the response template
  const template = `# About {{agentName}}
{{bio}}

# Lore
{{lore}}

# Current conversation history
{{recentMessages}}

# User just said:
"${userText}"

# Live data from your systems
{{providers}}

# Available actions you can take: {{actionNames}}
{{actions}}

CRITICAL RULES FOR {{agentName}}:
1. RESPOND TO THE USER'S MESSAGE EXPLICITLY ("User just said..."). Listen to what they are asking and reply Conversationally like a real human alpha caller/trader!
2. Reference REAL data from the "Live data from your systems" section if they ask for status or opportunities.
3. If they ask about current trades or PnL, quote actual numbers (scores, wallet counts, prices, MCap, volume).
4. Include DexScreener links when mentioning tokens: https://dexscreener.com/solana/MINT_ADDRESS_HERE
5. NEVER say "I'll look into it" or "let me check". You have live data — USE IT.
6. Keep responses short, punchy, and conversational (2-4 sentences). Act alive, not like a status bot.

{{actionExamples}}

You MUST respond strictly with this JSON format:
\`\`\`json
{ "user": "{{agentName}}", "text": "your actual response here", "action": "ACTION_NAME_OR_null" }
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
