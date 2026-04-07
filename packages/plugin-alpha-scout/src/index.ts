import type { Plugin } from '@elizaos/core';

import scanNewTokenAction from './actions/scan-new-token.action.js';
import trackWhaleWalletAction from './actions/track-whale-wallet.action.js';
import marketDataProvider from './providers/market-data.provider.js';
import whaleActivityProvider from './providers/whale-activity.provider.js';
import alphaScoreEvaluator from './evaluators/alpha-score.evaluator.js';

export const pluginAlphaScout: Plugin = {
  name: 'plugin-alpha-scout',
  description:
    'Finder agent plugin that discovers micro-cap token opportunities on Solana via PumpPortal, Helius whale tracking, and Twitter KOL monitoring. Scores signals and forwards qualifying tokens to the trader agent.',
  actions: [scanNewTokenAction, trackWhaleWalletAction],
  providers: [marketDataProvider, whaleActivityProvider],
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

// Re-export lib utilities
export { calculateCompositeScore } from './lib/score-calculator.js';
export type { ScoreParams } from './lib/score-calculator.js';

export { isInDenylist, addToDenylist } from './lib/denylist-guard.js';
