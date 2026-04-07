import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from '@elizaos/core';

const SOLANA_PUBKEY_REGEX = /[1-9A-HJ-NP-Za-km-z]{32,44}/;

function extractPubkey(text: string): string | null {
  const match = text.match(SOLANA_PUBKEY_REGEX);
  return match ? match[0] : null;
}

// In-memory whale tracking list (persisted via runtime memory for the session)
const WHALE_TRACKING_KEY = 'alpha-scout-whale-wallets';

async function getTrackedWallets(runtime: IAgentRuntime): Promise<string[]> {
  try {
    const existing = await runtime.cacheManager.get<string[]>(WHALE_TRACKING_KEY);
    return existing ?? [];
  } catch {
    return [];
  }
}

async function setTrackedWallets(runtime: IAgentRuntime, wallets: string[]): Promise<void> {
  try {
    await runtime.cacheManager.set(WHALE_TRACKING_KEY, wallets);
  } catch (err) {
    console.log(`[alpha-scout] Failed to persist wallet list: ${String(err)}`);
  }
}

const trackWhaleWalletAction: Action = {
  name: 'TRACK_WHALE_WALLET',
  description: 'Add or remove a Solana whale wallet address from the tracking list for alpha signal detection.',
  similes: ['ADD_WHALE', 'REMOVE_WHALE', 'WATCH_WALLET', 'UNWATCH_WALLET', 'TRACK_WALLET'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Track this whale wallet: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: { text: 'Added 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 to whale tracking list.' },
      } as ActionExample,
    ],
    [
      {
        user: '{{user1}}',
        content: { text: 'Stop tracking wallet 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1' },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: { text: 'Removed 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1 from whale tracking list.' },
      } as ActionExample,
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : (message.content as Record<string, unknown>)?.text as string ?? '';
    return SOLANA_PUBKEY_REGEX.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : (message.content as Record<string, unknown>)?.text as string ?? '';
    const wallet = extractPubkey(text);

    if (!wallet) {
      if (callback) await callback({ text: 'No valid Solana wallet address found in message.' });
      return null;
    }

    const lowerText = text.toLowerCase();
    const isRemove = lowerText.includes('remove') ||
      lowerText.includes('stop') ||
      lowerText.includes('untrack') ||
      lowerText.includes('unwatch') ||
      lowerText.includes('delete');

    const wallets = await getTrackedWallets(runtime);

    if (isRemove) {
      const idx = wallets.indexOf(wallet);
      if (idx === -1) {
        const msg = `Wallet ${wallet} is not in the tracking list.`;
        console.log(`[alpha-scout] ${msg}`);
        if (callback) await callback({ text: msg });
        return { wallet, action: 'not_found' };
      }
      wallets.splice(idx, 1);
      await setTrackedWallets(runtime, wallets);
      const msg = `Removed ${wallet} from whale tracking list. Now tracking ${wallets.length} wallet(s).`;
      console.log(`[alpha-scout] ${msg}`);
      if (callback) await callback({ text: msg });
      return { wallet, action: 'removed', totalTracked: wallets.length };
    }

    // Add wallet
    if (wallets.includes(wallet)) {
      const msg = `Wallet ${wallet} is already being tracked.`;
      console.log(`[alpha-scout] ${msg}`);
      if (callback) await callback({ text: msg });
      return { wallet, action: 'already_tracked' };
    }

    wallets.push(wallet);
    await setTrackedWallets(runtime, wallets);
    const msg = `Added ${wallet} to whale tracking list. Now tracking ${wallets.length} wallet(s).`;
    console.log(`[alpha-scout] ${msg}`);
    if (callback) await callback({ text: msg });
    return { wallet, action: 'added', totalTracked: wallets.length };
  },
};

export default trackWhaleWalletAction;
