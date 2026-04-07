import { v4 as uuidv4 } from 'uuid';
import {
  getDb,
  FINDER_TO_TRADER_ROOM,
  SCORE_THRESHOLDS,
  SIGNAL_DEFAULT_TTL_MS,
} from '@wildtrade/shared';
import type {
  AlphaSignal,
  InterAgentMessage,
  SignalSource,
} from '@wildtrade/shared';
import type { Action, IAgentRuntime, Memory, State, HandlerCallback, ActionExample } from '@elizaos/core';
import { calculateCompositeScore } from '../lib/score-calculator.js';
import { isInDenylist } from '../lib/denylist-guard.js';

const SOLANA_MINT_REGEX = /[1-9A-HJ-NP-Za-km-z]{43,44}/;
const RUGCHECK_API_BASE = process.env.RUGCHECK_API_BASE ?? 'https://api.rugcheck.xyz/v1';

function extractMintAddress(text: string): string | null {
  const match = text.match(SOLANA_MINT_REGEX);
  return match ? match[0] : null;
}

interface RugCheckReport {
  score?: number;
  risks?: Array<{ name: string; level: string }>;
  topHolders?: Array<{ pct: number }>;
  markets?: Array<{ lp?: { lpLockedPct?: number } }>;
}

async function fetchRugCheckReport(mint: string): Promise<RugCheckReport | null> {
  try {
    const url = `${RUGCHECK_API_BASE}/tokens/${mint}/report`;
    const res = await fetch(url);
    if (!res.ok) {
      console.log(`[alpha-scout] RugCheck API error: ${res.status} for mint ${mint}`);
      return null;
    }
    return (await res.json()) as RugCheckReport;
  } catch (err) {
    console.log(`[alpha-scout] RugCheck fetch error: ${String(err)}`);
    return null;
  }
}

interface MarketInfo {
  price: number;
  volume24h: number;
  marketCap: number;
  liquidity: number;
}

async function fetchMarketInfo(mint: string): Promise<MarketInfo> {
  const fallback: MarketInfo = { price: 0, volume24h: 0, marketCap: 0, liquidity: 0 };

  try {
    const dexRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (dexRes.ok) {
      const dexData = (await dexRes.json()) as { pairs?: Array<Record<string, unknown>> };
      const pair = dexData.pairs?.[0];
      if (pair) {
        return {
          price: Number(pair.priceUsd ?? 0),
          volume24h: Number((pair.volume as Record<string, unknown>)?.h24 ?? 0),
          marketCap: Number(pair.marketCap ?? pair.fdv ?? 0),
          liquidity: Number((pair.liquidity as Record<string, unknown>)?.usd ?? 0),
        };
      }
    }
  } catch {
    // fall through to Jupiter
  }

  try {
    const jupRes = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
    if (jupRes.ok) {
      const jupData = (await jupRes.json()) as { data?: Record<string, Record<string, unknown>> };
      const info = jupData.data?.[mint];
      if (info) {
        return {
          price: Number(info.price ?? 0),
          volume24h: 0,
          marketCap: 0,
          liquidity: 0,
        };
      }
    }
  } catch {
    // use fallback
  }

  return fallback;
}

async function persistSignal(signal: AlphaSignal): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO signals (id, mint, symbol, name, market_cap_usd, liquidity_usd,
       sources, score_json, discovered_at, expires_at, tweet_urls, whale_wallets,
       rugcheck_passed, rugcheck_score, creator_addr, in_denylist, expired)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0)
     ON CONFLICT (id) DO NOTHING`,
    [
      signal.id,
      signal.mintAddress,
      signal.symbol,
      signal.name,
      signal.marketCapUsd,
      signal.liquidityUsd,
      JSON.stringify(signal.sources),
      JSON.stringify(signal.score),
      signal.discoveredAt,
      signal.expiresAt,
      JSON.stringify(signal.tweetUrls),
      JSON.stringify(signal.whaleWallets),
      signal.rugcheckPassed ? 1 : 0,
      signal.rugcheckScore ?? null,
      signal.creatorAddress,
      signal.inDenylist ? 1 : 0,
    ],
  );
}

const scanNewTokenAction: Action = {
  name: 'SCAN_NEW_TOKEN',
  description: 'Scan a new Solana token mint address for alpha signals: check denylist, run rug check, score, and optionally forward to trader.',
  similes: ['CHECK_TOKEN', 'ANALYZE_MINT', 'SCAN_MINT', 'EVALUATE_TOKEN'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Scan this new token: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: { text: 'Scanning token 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU for alpha signals...' },
      } as ActionExample,
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : (message.content as Record<string, unknown>)?.text as string ?? '';
    return SOLANA_MINT_REGEX.test(text);
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : (message.content as Record<string, unknown>)?.text as string ?? '';
    const mintAddress = extractMintAddress(text);

    if (!mintAddress) {
      if (callback) await callback({ text: 'No valid Solana mint address found in message.' });
      return null;
    }

    console.log(`[alpha-scout] Scanning token: ${mintAddress}`);

    // 1. Check denylist
    const db = await getDb();
    const denied = await isInDenylist(db, mintAddress);
    if (denied) {
      const msg = `Token ${mintAddress} is in the denylist. Skipping.`;
      console.log(`[alpha-scout] ${msg}`);
      if (callback) await callback({ text: msg });
      return { mintAddress, denied: true };
    }

    // 2. RugCheck
    const rugReport = await fetchRugCheckReport(mintAddress);
    const rugcheckScore = rugReport?.score ?? 0;
    const highRisks = rugReport?.risks?.filter((r) => r.level === 'high' || r.level === 'critical') ?? [];
    const rugcheckPassed = highRisks.length === 0;

    if (!rugcheckPassed) {
      console.log(`[alpha-scout] RugCheck flagged ${mintAddress} with ${highRisks.length} high/critical risks`);
    }

    // 3. Fetch market data
    const market = await fetchMarketInfo(mintAddress);

    // 4. Calculate holder concentration from rugcheck
    const topHolders = rugReport?.topHolders ?? [];
    const top10Concentration = topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct ?? 0), 0);

    // 5. Score
    const score = calculateCompositeScore({
      volume24h: market.volume24h,
      holderCount: topHolders.length > 0 ? topHolders.length * 10 : 0,
      top10Concentration,
      kolMentions: 0,
      whaleNetFlow: 0,
      liquidityUsd: market.liquidity,
    });

    // 6. Build signal
    const now = Date.now();
    const signal: AlphaSignal = {
      id: uuidv4(),
      mintAddress,
      symbol: '',
      name: '',
      marketCapUsd: market.marketCap,
      liquidityUsd: market.liquidity,
      sources: ['pumpportal' as SignalSource],
      score,
      discoveredAt: now,
      expiresAt: now + SIGNAL_DEFAULT_TTL_MS,
      tweetUrls: [],
      whaleWallets: [],
      rugcheckPassed,
      rugcheckScore,
      creatorAddress: '',
      inDenylist: false,
    };

    // 7. Persist
    await persistSignal(signal);
    console.log(`[alpha-scout] Signal persisted: ${signal.id} score=${score.total}`);

    // 8. If score meets threshold, forward to trader
    if (score.total >= SCORE_THRESHOLDS.MIN_TO_TRADE && rugcheckPassed) {
      const interAgentMsg: InterAgentMessage = {
        fromAgent: 'finder',
        toAgent: 'trader',
        type: 'signal_ready',
        correlationId: signal.id,
        payload: signal,
        timestamp: now,
      };

      await runtime.messageManager.createMemory({
        id: uuidv4() as Memory['id'],
        userId: message.userId,
        agentId: message.agentId,
        roomId: FINDER_TO_TRADER_ROOM as Memory['roomId'],
        content: {
          text: JSON.stringify(interAgentMsg),
        },
        createdAt: now,
      });

      console.log(`[alpha-scout] Signal ${signal.id} forwarded to trader room (score=${score.total})`);
    }

    // 9. Respond
    const summary = [
      `Token: ${mintAddress}`,
      `RugCheck: ${rugcheckPassed ? 'PASSED' : 'FAILED'} (score: ${rugcheckScore})`,
      `Market Cap: $${market.marketCap.toLocaleString()}`,
      `Liquidity: $${market.liquidity.toLocaleString()}`,
      `24h Volume: $${market.volume24h.toLocaleString()}`,
      `Alpha Score: ${score.total}/100 (${score.conviction} conviction)`,
      `  Volume: ${score.volumeScore}/25 | Holders: ${score.holderScore}/25 | Social: ${score.socialScore}/25 | Whale: ${score.whaleScore}/25`,
      score.total >= SCORE_THRESHOLDS.MIN_TO_TRADE && rugcheckPassed
        ? 'Signal forwarded to trader for execution.'
        : 'Score below threshold or RugCheck failed. Not forwarding.',
    ].join('\n');

    if (callback) await callback({ text: summary });
    return signal;
  },
};

export default scanNewTokenAction;
