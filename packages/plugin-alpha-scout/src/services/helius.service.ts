export interface WhaleTransaction {
  wallet: string;
  mint: string;
  type: 'buy' | 'sell';
  amountSol: number;
  timestamp: number;
}

const HELIUS_TX_URL = 'https://api.helius.xyz/v0/addresses';

function getApiKey(): string {
  const key = process.env.HELIUS_API_KEY ?? '';
  if (!key) {
    console.log('[alpha-scout] WARNING: HELIUS_API_KEY not set');
  }
  return key;
}

function getTrackedWallets(): string[] {
  const raw = process.env.SMART_MONEY_WALLETS ?? '';
  if (!raw) return [];
  return raw.split(',').map((w) => w.trim()).filter(Boolean);
}

async function fetchRecentTransactions(wallet: string, apiKey: string): Promise<unknown[]> {
  const url = `${HELIUS_TX_URL}/${wallet}/transactions?api-key=${apiKey}&limit=20`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[alpha-scout] Helius API error for wallet ${wallet}: ${res.status}`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.log(`[alpha-scout] Helius fetch error for ${wallet}: ${String(err)}`);
    return [];
  }
}

function parseTransaction(wallet: string, tx: Record<string, unknown>): WhaleTransaction | null {
  // Helius Enhanced API returns enriched transactions with tokenTransfers
  const tokenTransfers = tx.tokenTransfers as Array<Record<string, unknown>> | undefined;
  if (!tokenTransfers || tokenTransfers.length === 0) return null;

  for (const transfer of tokenTransfers) {
    const mint = transfer.mint as string | undefined;
    if (!mint) continue;

    const fromAddr = transfer.fromUserAccount as string | undefined;
    const toAddr = transfer.toUserAccount as string | undefined;
    const tokenAmount = Number(transfer.tokenAmount ?? 0);

    if (tokenAmount <= 0) continue;

    // Determine buy or sell based on direction relative to the tracked wallet
    let type: 'buy' | 'sell' | null = null;
    if (toAddr === wallet) {
      type = 'buy';
    } else if (fromAddr === wallet) {
      type = 'sell';
    }

    if (!type) continue;

    // Estimate SOL amount from nativeTransfers if available
    const nativeTransfers = tx.nativeTransfers as Array<Record<string, unknown>> | undefined;
    let amountSol = 0;
    if (nativeTransfers) {
      for (const nt of nativeTransfers) {
        const lamports = Number(nt.amount ?? 0);
        if (lamports > 0) {
          amountSol += lamports / 1_000_000_000;
        }
      }
    }

    const timestamp = (tx.timestamp as number) ?? Math.floor(Date.now() / 1000);

    return { wallet, mint, type, amountSol, timestamp: timestamp * 1000 };
  }

  return null;
}

export async function pollWhaleActivity(
  wallets?: string[],
): Promise<WhaleTransaction[]> {
  const apiKey = getApiKey();
  if (!apiKey) return [];

  const walletsToTrack = wallets ?? getTrackedWallets();
  if (walletsToTrack.length === 0) {
    console.log('[alpha-scout] No whale wallets configured for tracking');
    return [];
  }

  const results: WhaleTransaction[] = [];

  const promises = walletsToTrack.map(async (wallet) => {
    const txs = await fetchRecentTransactions(wallet, apiKey);
    for (const raw of txs) {
      const parsed = parseTransaction(wallet, raw as Record<string, unknown>);
      if (parsed) {
        results.push(parsed);
      }
    }
  });

  await Promise.all(promises);

  console.log(`[alpha-scout] Polled ${walletsToTrack.length} whale wallets, found ${results.length} token transfers`);
  return results;
}

// Module-level cache of last poll results for the provider
let lastPollResults: WhaleTransaction[] = [];
let lastPollTimestamp = 0;
const CACHE_TTL_MS = 60_000;

export async function getCachedWhaleActivity(dynamicWallets?: string[]): Promise<WhaleTransaction[]> {
  const now = Date.now();
  if (now - lastPollTimestamp < CACHE_TTL_MS && lastPollResults.length > 0) {
    return lastPollResults;
  }
  lastPollResults = await pollWhaleActivity(dynamicWallets);
  lastPollTimestamp = now;
  return lastPollResults;
}
