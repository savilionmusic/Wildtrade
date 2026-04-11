export const SOLANA_SERVICE_NAME = 'chain_solana';
export const SOLANA_WALLET_DATA_CACHE_KEY = 'solana/walletData';

export const PROVIDER_CONFIG = {
  /** DexScreener — free, no key needed */
  DEXSCREENER_API: 'https://api.dexscreener.com',
  /** Jupiter Price API v2 — free, no key */
  JUPITER_PRICE_API: 'https://api.jup.ag/price/v2',
  MAX_RETRIES: 3,
  RETRY_DELAY: 2000,
  DEFAULT_RPC: 'https://api.mainnet-beta.solana.com',
  /** DexScreener cache TTL */
  PRICE_CACHE_TTL_MS: 30_000,
  /** Portfolio cache TTL */
  PORTFOLIO_CACHE_TTL_MS: 120_000,
  TOKEN_ADDRESSES: {
    SOL: 'So11111111111111111111111111111111111111112',
    BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
    ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  },
} as const;
