import type { Plugin } from '@elizaos/core';
import { executeDcaEntryAction } from './actions/execute-dca-entry.action.js';
import { triggerExitTierAction } from './actions/trigger-exit-tier.action.js';
import { cancelPositionAction } from './actions/cancel-position.action.js';
import { portfolioProvider } from './providers/portfolio.provider.js';
import { priceMonitorProvider } from './providers/price-monitor.provider.js';
import { exitConditionEvaluator } from './evaluators/exit-condition.evaluator.js';

export const pluginSmartTrader: Plugin = {
  name: 'plugin-smart-trader',
  description: 'Wildtrade Smart Trader plugin - executes DCA entries, manages positions, and handles tiered exits on Solana',
  actions: [
    executeDcaEntryAction,
    triggerExitTierAction,
    cancelPositionAction,
  ],
  providers: [
    portfolioProvider,
    priceMonitorProvider,
  ],
  evaluators: [
    exitConditionEvaluator,
  ],
};

export default pluginSmartTrader;

export { executeDcaEntryAction } from './actions/execute-dca-entry.action.js';
export { triggerExitTierAction } from './actions/trigger-exit-tier.action.js';
export { cancelPositionAction } from './actions/cancel-position.action.js';
export { portfolioProvider } from './providers/portfolio.provider.js';
export { priceMonitorProvider } from './providers/price-monitor.provider.js';
export { exitConditionEvaluator } from './evaluators/exit-condition.evaluator.js';
export { calculateDCALegs } from './lib/dca-calculator.js';
export { buildExitTiers } from './lib/exit-strategy.js';
export { getKeypair, getPublicKey } from './lib/wallet.js';
