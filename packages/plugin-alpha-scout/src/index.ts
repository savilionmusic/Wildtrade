import type { Plugin } from '@elizaos/core';

import scanNewTokenAction from './actions/scan-new-token.action.js';
import trackWhaleWalletAction from './actions/track-whale-wallet.action.js';
import smartMoneyScanAction from './actions/smart-money-scan.action.js';
import marketDataProvider from './providers/market-data.provider.js';
import whaleActivityProvider from './providers/whale-activity.provider.js';
import smartMoneyProvider from './providers/smart-money.provider.js';
import alphaScoreEvaluator from './evaluators/alpha-score.evaluator.js';

export const pluginAlphaScout: Plugin = {
  name: 'plugin-alpha-scout',
  description:
    'Finder agent plugin that discovers micro-cap token opportunities on Solana via PumpPortal, Helius whale tracking, GMGN smart money monitoring, and Twitter KOL monitoring. Scores signals and forwards qualifying tokens to the trader agent.',
  actions: [scanNewTokenAction, trackWhaleWalletAction, smartMoneyScanAction],
  providers: [marketDataProvider, whaleActivityProvider, smartMoneyProvider],
  evaluators: [alphaScoreEvaluator],
};

export default pluginAlphaScout;

// Re-export services for external initialization
export { connect as connectPumpPortal, disconnect as disconnectPumpPortal } from './services/pumpportal.service.js';
export type { PumpPortalToken, PumpPortalCallback } from './services/pumpportal.service.js';

export { pollWhaleActivity, getCachedWhaleActivity } from './services/helius.service.js';
export type { WhaleTransaction } from './services/helius.service.js';

export { pollKolTimelines, getTwitterPollIntervalMs } from './services/twitter.service.js';
export type { KolTweetResult } from './services/twitter.service.js';

// GMGN smart money
export {
  getTopWallets, getQualityWallets, getWalletBuys,
  getSmartMoneyTradesForToken, getTokenInfo, scoreWallet,
} from './services/gmgn.service.js';
export type { GmgnWallet, GmgnWalletTrade, GmgnTokenInfo } from './services/gmgn.service.js';

export {
  startSmartMoneyMonitor, stopSmartMoneyMonitor,
  getMonitorStatus, getRecentSmartBuys, forceCheck,
} from './services/smart-money-monitor.service.js';
export type { SmartMoneySignal, SmartMoneyCallback, WalletBuy } from './services/smart-money-monitor.service.js';

export {
  startScanner, stopScanner, getScannerStats,
} from './services/scanner-engine.service.js';

// DexScreener
export { getTrendingTokens, getTokenPairs, searchTokens } from './services/dexscreener.service.js';
export type { TrendingToken, DexPair } from './services/dexscreener.service.js';

// Wallet Intelligence
export {
  startWalletIntelligence, stopWalletIntelligence,
  getTrackedWallets, getWalletCount, getRecentWalletBuys,
  getWalletIntelStats, recordWalletBuy,
} from './services/wallet-intelligence.service.js';
export type { TrackedWallet, WalletBuyEvent } from './services/wallet-intelligence.service.js';

// KOL Intelligence
export {
  startKolIntelligence, stopKolIntelligence,
  getKolSignals, getKolStats, setTokenMentionCallback,
} from './services/kol-intelligence.service.js';
export type { KolSignal } from './services/kol-intelligence.service.js';

// Telegram Notifications
export {
  configureTelegram, sendTelegramAlert, isTelegramEnabled,
} from './services/telegram.service.js';

// Re-export lib utilities
export { calculateCompositeScore } from './lib/score-calculator.js';
export type { ScoreParams } from './lib/score-calculator.js';

export { isInDenylist, addToDenylist } from './lib/denylist-guard.js';
