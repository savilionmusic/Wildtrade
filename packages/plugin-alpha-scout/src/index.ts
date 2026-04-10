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
export { connect as connectPumpPortal, disconnect as disconnectPumpPortal, onMigration as onPumpMigration } from './services/pumpportal.service.js';
export type { PumpPortalToken, PumpPortalCallback, PumpMigrationEvent, PumpMigrationCallback } from './services/pumpportal.service.js';

// Remove Helius to avoid 429 rate limit issues
// Remove Helius to avoid 429 rate limit issues

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
  getTrackedWalletAddresses,
} from './services/smart-money-monitor.service.js';
export type { SmartMoneySignal, SmartMoneyCallback, SmartMoneyBuyCallback, WalletBuy } from './services/smart-money-monitor.service.js';

export {
  startScanner, stopScanner, getScannerStats, enqueueToken,
} from './services/scanner-engine.service.js';

// PumpSwap Migration Sniper
export {
  startPumpSwapSniper, stopPumpSwapSniper,
  onPumpPortalMigration, getSnipeStats,
} from './services/pumpswap-sniper.service.js';
export type { MigrationSnipeEvent, SnipeCallback } from './services/pumpswap-sniper.service.js';

// Pump Launch Sniper
export {
  startPumpLaunchSniper,
  stopPumpLaunchSniper,
  onPumpLaunchToken,
} from './services/pump-launch-sniper.service.js';
export type { PumpLaunchSnipeEvent, PumpLaunchSnipeCallback } from './services/pump-launch-sniper.service.js';

// DexScreener
export { getTrendingTokens, getTokenPairs, searchTokens } from './services/dexscreener.service.js';
export type { TrendingToken, DexPair } from './services/dexscreener.service.js';

export { fetchDexScreenerData } from './providers/market-data.provider.js';

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
  onTelegramMessage, stopTelegramPolling,
} from './services/telegram.service.js';

// Convergence Detector
export {
  startConvergenceDetector, stopConvergenceDetector,
  getRecentConvergences, updateWalletList as updateConvergenceWallets,
} from './services/convergence-detector.service.js';
export type { ConvergenceSignal, ConvergenceCallback } from './services/convergence-detector.service.js';

// Re-export lib utilities
export { calculateCompositeScore } from './lib/score-calculator.js';
export type { ScoreParams } from './lib/score-calculator.js';

export { isInDenylist, addToDenylist } from './lib/denylist-guard.js';
