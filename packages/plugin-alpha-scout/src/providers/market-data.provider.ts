import type { Provider, IAgentRuntime, Memory, State } from '@elizaos/core';

const SOLANA_MINT_REGEX = /[1-9A-HJ-NP-Za-km-z]{43,44}/;

interface JupiterPriceData {
  data?: Record<string, { id: string; mintSymbol: string; price: number }>;
}

interface DexScreenerPair {
  baseToken?: { symbol?: string; name?: string };
  priceUsd?: string;
  volume?: { h24?: number };
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
  txns?: { h24?: { buys?: number; sells?: number } };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

async function fetchJupiterPrice(mint: string): Promise<string | null> {
  try {
    const res = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (!res.ok) return null;
    const data = (await res.json()) as JupiterPriceData;
    const info = data.data?.[mint];
    if (!info) return null;
    return [
      `[Jupiter] ${info.mintSymbol ?? mint}`,
      `  Price: $${info.price}`,
    ].join('\n');
  } catch {
    return null;
  }
}

async function fetchDexScreenerData(mint: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return null;
    const data = (await res.json()) as DexScreenerResponse;
    const pair = data.pairs?.[0];
    if (!pair) return null;

    const symbol = pair.baseToken?.symbol ?? 'UNKNOWN';
    const name = pair.baseToken?.name ?? '';
    const price = pair.priceUsd ?? 'N/A';
    const volume24h = pair.volume?.h24 ?? 0;
    const marketCap = pair.marketCap ?? pair.fdv ?? 0;
    const liquidity = pair.liquidity?.usd ?? 0;
    const priceChange24h = pair.priceChange?.h24 ?? 0;
    const buys24h = pair.txns?.h24?.buys ?? 0;
    const sells24h = pair.txns?.h24?.sells ?? 0;

    return [
      `[DexScreener] ${symbol} (${name})`,
      `  Price: $${price}`,
      `  24h Volume: $${volume24h.toLocaleString()}`,
      `  Market Cap: $${marketCap.toLocaleString()}`,
      `  Liquidity: $${liquidity.toLocaleString()}`,
      `  24h Change: ${priceChange24h > 0 ? '+' : ''}${priceChange24h}%`,
      `  24h Txns: ${buys24h} buys / ${sells24h} sells`,
    ].join('\n');
  } catch {
    return null;
  }
}

const marketDataProvider: Provider = {
  get: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<string | null> => {
    const text = typeof message.content === 'string'
      ? message.content
      : (message.content as Record<string, unknown>)?.text as string ?? '';

    const match = text.match(SOLANA_MINT_REGEX);
    if (!match) return null;

    const mint = match[0];
    console.log(`[alpha-scout] Fetching market data for ${mint}`);

    const [dexData, jupData] = await Promise.all([
      fetchDexScreenerData(mint),
      fetchJupiterPrice(mint),
    ]);

    const parts: string[] = [];
    if (dexData) parts.push(dexData);
    if (jupData) parts.push(jupData);

    if (parts.length === 0) {
      return `No market data found for mint ${mint}`;
    }

    return `Market Data for ${mint}:\n${parts.join('\n\n')}`;
  },
};

export default marketDataProvider;
