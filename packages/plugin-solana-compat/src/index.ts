import type { Plugin } from '@elizaos/core';
import { SOLANA_SERVICE_NAME } from './constants.js';
import { walletProvider } from './providers/wallet.js';
import { SolanaService } from './service.js';

export const pluginSolanaCompat: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: 'Solana blockchain plugin — Constant-K RPC optimized, DexScreener/Jupiter prices, rate-limited, no Birdeye/Helius required',
  services: [SolanaService.getInstance()],
  providers: [walletProvider],
};

export default pluginSolanaCompat;

export { SolanaService } from './service.js';
export { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from './constants.js';
export { schedule, classifyMethod, getSchedulerStats } from './rpc-scheduler.js';
export type { RpcCategory } from './rpc-scheduler.js';
export type {
  CacheWrapper,
  DexScreenerPair,
  DexScreenerTokenResponse,
  Item,
  JupiterPriceData,
  JupiterPriceResponse,
  MintBalance,
  Prices,
  TokenAccountEntry,
  TokenMetaCacheEntry,
  TokenSupplyInfo,
  WalletPortfolio,
} from './types.js';
export { getWalletKey } from './keypair-utils.js';
