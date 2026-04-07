import type { Plugin } from '@elizaos/core';

import recoverPositionAction from './actions/recover-position.action.js';
import rotateRpcAction from './actions/rotate-rpc.action.js';
import flagHoneypotAction from './actions/flag-honeypot.action.js';

import healthProvider from './providers/health.provider.js';

import errorDetectorEvaluator from './evaluators/error-detector.evaluator.js';

export { seedEndpoints, getHealthyEndpoint, reportFailure, forceRotate, getAllEndpoints, startHealthChecks, stopHealthChecks } from './services/rpc-rotator.service.js';
export { runReconciliation, getLastReconcileAt, startInterval, stopInterval } from './services/reconciler.service.js';
export { exponentialBackoff, sleep } from './lib/backoff.js';
export { checkToken } from './lib/rugcheck-client.js';
export { isInDenylist, addToDenylist, getDenylist } from './lib/denylist-manager.js';

export const pluginSelfHealer: Plugin = {
  name: 'plugin-self-healer',
  description: 'Auditor agent plugin for RPC rotation, position reconciliation, rug detection, and error recovery in the Wildtrade trading bot.',
  actions: [
    recoverPositionAction,
    rotateRpcAction,
    flagHoneypotAction,
  ],
  providers: [
    healthProvider,
  ],
  evaluators: [
    errorDetectorEvaluator,
  ],
  services: [],
};

export default pluginSelfHealer;
