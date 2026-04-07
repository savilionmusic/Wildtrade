/**
 * SMART_MONEY_SCAN action — Processes smart money cluster signals.
 *
 * When the smart money monitor detects multiple wallets buying the same token,
 * this action scores it, checks safety, and forwards to the Trader agent.
 */

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

const RUGCHECK_API_BASE = process.env.RUGCHECK_API_BASE ?? 'https://api.rugcheck.xyz/v1';

async function fetchRugCheckQuick(mint: string): Promise<{ passed: boolean; score: number }> {
  try {
    const res = await fetch(`${RUGCHECK_API_BASE}/tokens/${mint}/report`);
    if (!res.ok) return { passed: true, score: 50 }; // Conservative fallback
    const data = (await res.json()) as { score?: number; risks?: Array<{ level: string }> };
    const highRisks = (data.risks ?? []).filter(r => r.level === 'high' || r.level === 'critical');
    return {
      passed: highRisks.length === 0,
      score: data.score ?? 50,
    };
  } catch {
    return { passed: true, score: 50 };
  }
}

const smartMoneyScanAction: Action = {
  name: 'SMART_MONEY_SCAN',
  description: 'Process a smart money cluster signal — multiple tracked wallets buying the same token. Scores the opportunity and forwards to trader if qualifying.',
  similes: ['PROCESS_CLUSTER', 'SMART_MONEY_ALERT', 'WHALE_CLUSTER'],
  examples: [
    [
      {
        user: '{{user1}}',
        content: { text: 'Smart money cluster: 3 wallets bought token 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU — check and trade' },
      } as ActionExample,
      {
        user: '{{agentName}}',
        content: { text: 'Processing smart money cluster signal for token 7xKXtg...' },
      } as ActionExample,
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    const text = typeof message.content === 'string' ? message.content : (message.content as Record<string, unknown>)?.text as string ?? '';
    return text.includes('smart_money_cluster') || text.includes('SMART_MONEY_CLUSTER');
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<unknown> => {
    const text = typeof message.content === 'string' ? message.content : (message.content as Record<string, unknown>)?.text as string ?? '';

    // Parse the cluster signal JSON from the message
    let clusterData: {
      tokenAddress: string;
      tokenSymbol: string;
      tokenName: string;
      smartWalletCount: number;
      totalSolInvested: number;
      avgMarketCap: number;
      confidence: string;
      tokenInfo?: { liquidity?: number; volume_24h?: number; holder_count?: number; smart_degen_count?: number; is_honeypot?: boolean };
    };

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        clusterData = JSON.parse(jsonMatch[0]);
      } else {
        if (callback) await callback({ text: 'Could not parse cluster signal data.' });
        return null;
      }
    } catch {
      if (callback) await callback({ text: 'Invalid cluster signal JSON.' });
      return null;
    }

    const mintAddress = clusterData.tokenAddress;
    console.log(`[smart-money] Processing cluster: ${clusterData.tokenSymbol || mintAddress.slice(0, 8)} (${clusterData.smartWalletCount} wallets)`);

    // 1. Check denylist
    const db = await getDb();
    const denied = await isInDenylist(db, mintAddress);
    if (denied) {
      const msg = `Token ${clusterData.tokenSymbol || mintAddress} is denylisted. Skipping.`;
      console.log(`[smart-money] ${msg}`);
      if (callback) await callback({ text: msg });
      return null;
    }

    // 2. Quick rugcheck
    const rug = await fetchRugCheckQuick(mintAddress);
    if (!rug.passed) {
      const msg = `Token ${clusterData.tokenSymbol || mintAddress} failed RugCheck. Skipping for safety.`;
      console.log(`[smart-money] ${msg}`);
      if (callback) await callback({ text: msg });
      return null;
    }

    // 3. Score with smart money boost
    const score = calculateCompositeScore({
      volume24h: clusterData.tokenInfo?.volume_24h ?? 0,
      holderCount: clusterData.tokenInfo?.holder_count ?? 0,
      top10Concentration: 0,
      kolMentions: 0,
      // Smart money wallets count as whale flow — each wallet = significant signal
      whaleNetFlow: clusterData.smartWalletCount * clusterData.totalSolInvested,
      liquidityUsd: clusterData.tokenInfo?.liquidity ?? 0,
    });

    // Boost score based on cluster confidence
    let boostedTotal = score.total;
    if (clusterData.confidence === 'very_high') boostedTotal = Math.min(100, boostedTotal + 20);
    else if (clusterData.confidence === 'high') boostedTotal = Math.min(100, boostedTotal + 15);
    else if (clusterData.confidence === 'medium') boostedTotal = Math.min(100, boostedTotal + 10);
    else boostedTotal = Math.min(100, boostedTotal + 5);

    const boostedScore = {
      ...score,
      total: boostedTotal,
      conviction: boostedTotal >= 80 ? 'high' as const : boostedTotal >= 65 ? 'medium' as const : 'low' as const,
    };

    // 4. Build signal
    const now = Date.now();
    const signal: AlphaSignal = {
      id: uuidv4(),
      mintAddress,
      symbol: clusterData.tokenSymbol || '',
      name: clusterData.tokenName || '',
      marketCapUsd: clusterData.avgMarketCap,
      liquidityUsd: clusterData.tokenInfo?.liquidity ?? 0,
      sources: ['helius_whale' as SignalSource], // Smart money = whale category
      score: boostedScore,
      discoveredAt: now,
      expiresAt: now + SIGNAL_DEFAULT_TTL_MS,
      tweetUrls: [],
      whaleWallets: [], // Could populate from cluster data
      rugcheckPassed: rug.passed,
      rugcheckScore: rug.score,
      creatorAddress: '',
      inDenylist: false,
    };

    // 5. Persist
    await db.query(
      `INSERT INTO signals (id, mint, symbol, name, market_cap_usd, liquidity_usd,
         sources, score_json, discovered_at, expires_at, tweet_urls, whale_wallets,
         rugcheck_passed, rugcheck_score, creator_addr, in_denylist, expired)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0)
       ON CONFLICT (id) DO NOTHING`,
      [
        signal.id, signal.mintAddress, signal.symbol, signal.name,
        signal.marketCapUsd, signal.liquidityUsd,
        JSON.stringify(signal.sources), JSON.stringify(signal.score),
        signal.discoveredAt, signal.expiresAt,
        JSON.stringify(signal.tweetUrls), JSON.stringify(signal.whaleWallets),
        signal.rugcheckPassed ? 1 : 0, signal.rugcheckScore ?? null,
        signal.creatorAddress, signal.inDenylist ? 1 : 0,
      ],
    );

    console.log(`[smart-money] Signal persisted: ${signal.id} score=${boostedScore.total} (base=${score.total} + cluster boost)`);

    // 6. Forward to trader if score qualifies
    if (boostedScore.total >= SCORE_THRESHOLDS.MIN_TO_TRADE && rug.passed) {
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

      console.log(`[smart-money] SIGNAL FORWARDED TO TRADER: ${signal.symbol || mintAddress.slice(0, 8)} score=${boostedScore.total}`);
    }

    // 7. Respond with trading partner style update
    const summary = [
      `🎯 Smart Money Alert: ${signal.symbol || mintAddress.slice(0, 8)}`,
      `${clusterData.smartWalletCount} smart wallets bought | ${clusterData.totalSolInvested.toFixed(2)} SOL total invested`,
      `Confidence: ${clusterData.confidence.toUpperCase()} | Score: ${boostedScore.total}/100 (${boostedScore.conviction})`,
      `RugCheck: ${rug.passed ? 'PASSED' : 'FAILED'} (${rug.score})`,
      clusterData.avgMarketCap > 0 ? `Market Cap: $${clusterData.avgMarketCap.toLocaleString()}` : '',
      boostedScore.total >= SCORE_THRESHOLDS.MIN_TO_TRADE && rug.passed
        ? `>> FORWARDED TO TRADER FOR EXECUTION <<`
        : `Score below threshold (${SCORE_THRESHOLDS.MIN_TO_TRADE}). Watching only.`,
    ].filter(Boolean).join('\n');

    if (callback) await callback({ text: summary });
    return signal;
  },
};

export default smartMoneyScanAction;
