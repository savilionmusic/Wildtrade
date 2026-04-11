import type { Plugin } from '@elizaos/core';
import { SOLANA_SERVICE_NAME } from './constants.js';
import { walletProvider } from './providers/wallet.js';
import { SolanaService } from './service.js';

export const pluginSolanaCompat: Plugin = {
  name: SOLANA_SERVICE_NAME,
  description: 'Solana blockchain plugin - Birdeye prices, wallet portfolio, Token-2022, batch RPC, WebSocket subscriptions',
  services: [SolanaService.getInstance()],
  providers: [walletProvider],
};

export default pluginSolanaCompat;

export { SolanaService } from './service.js';
export { SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from './constants.js';
export type {
  BirdeyePriceResponse,
  BirdeyeWalletTokenItem,
  BirdeyeWalletTokenListResponse,
  CacheWrapper,
  Item,
  MintBalance,
  Prices,
  TokenAccountEntry,
  TokenMetaCacheEntry,
  TokenSupplyInfo,
  WalletPortfolio,
} from './types.js';
export { getWalletKey } from './keypair-utils.js';
