import type { Keypair, PublicKey } from '@solana/web3.js';

export interface Item {
  name: string;
  address: string;
  symbol: string;
  decimals: number;
  balance: string;
  uiAmount: string;
  priceUsd: string;
  valueUsd: string;
  valueSol?: string;
}

export interface Prices {
  solana: { usd: string };
  bitcoin: { usd: string };
  ethereum: { usd: string };
}

export interface WalletPortfolio {
  totalUsd: string;
  totalSol?: string;
  items: Array<Item>;
  prices?: Prices;
  lastUpdated?: number;
}

export interface MintBalance {
  amount: string;
  decimals: number;
  uiAmount: number;
}

export interface BirdeyePriceResponse {
  success: boolean;
  data: {
    value: number;
    updateUnixTime: number;
    updateHumanTime: string;
  };
}

export interface BirdeyeWalletTokenItem {
  address: string;
  symbol?: string;
  name?: string;
  decimals?: number;
  balance?: string;
  balanceUsd?: number;
  priceUsd?: string;
  valueUsd?: string;
  uiAmount?: string;
}

export interface BirdeyeWalletTokenListResponse {
  success: boolean;
  data?: {
    totalUsd: number | string;
    items: BirdeyeWalletTokenItem[];
  };
}

export interface CacheWrapper<T> {
  exp: number;
  data: T;
}

export interface TokenAccountEntry {
  pubkey: PublicKey;
  account: {
    data: {
      program: string;
      parsed: {
        type: string;
        info: {
          mint: string;
          owner: string;
          state: string;
          tokenAmount: {
            amount: string;
            decimals: number;
            uiAmount: number;
            uiAmountString: string;
          };
          isNative?: boolean;
          extensions?: Array<Record<string, string | number | boolean>>;
        };
      };
    };
    owner: PublicKey;
    lamports: number;
  };
}

export interface TokenMetaCacheEntry {
  setAt: number;
  data: {
    symbol: string | null;
    supply: string | number | null;
    tokenProgram: string;
    decimals: number;
    isMutable: boolean | null;
  };
}

export interface ParsedTokenResult {
  mint: string;
  symbol: string | null;
  supply: string | number | null;
  tokenProgram: 'Token-2022' | 'Token';
  decimals: number;
  balanceUi: number;
  isMutable: boolean | null;
}

export interface ExchangeProvider {
  name: string;
  getQuote(params: SwapQuoteParams): Promise<JupiterQuote>;
  executeSwap(params: SwapExecuteParams): Promise<SwapResult>;
}

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: string;
  slippageBps?: number;
}

export interface SwapExecuteParams {
  quote: JupiterQuote;
  userPublicKey: string;
  wrapAndUnwrapSol?: boolean;
}

export interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  platformFee: null | { amount: string; feeBps: number };
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
      feeAmount: string;
      feeMint: string;
    };
    percent: number;
  }>;
  contextSlot: number;
  timeTaken: number;
}

export interface JupiterSwapResult {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports: number;
  computeUnitLimit: number;
  error?: string;
}

export interface SwapResult {
  success: boolean;
  signature?: string;
  outAmount?: number;
  fees?: SwapFees;
  error?: string;
}

export interface SwapFees {
  totalFee: number;
  platformFee: number;
  networkFee: number;
}

export interface TokenSupplyInfo {
  supply: bigint;
  decimals: number;
  human: string;
}

export interface KeypairResult {
  keypair?: Keypair;
  publicKey?: PublicKey;
}
