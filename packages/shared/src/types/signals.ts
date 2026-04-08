export type SignalSource = 'pumpportal' | 'helius_whale' | 'twitter_kol' | 'smart_money' | 'migration' | 'convergence' | 'dexscreener';
export type SignalConviction = 'low' | 'medium' | 'high';

export interface CompositeScore {
  volumeScore: number;       // 0–20
  holderScore: number;       // 0–20
  socialScore: number;       // 0–20
  whaleScore: number;        // 0–20
  liquidityScore: number;    // 0–15
  total: number;             // 0–100
  conviction: SignalConviction;
}

export interface AlphaSignal {
  id: string;
  mintAddress: string;
  symbol: string;
  name: string;
  marketCapUsd: number;
  liquidityUsd: number;
  sources: SignalSource[];
  score: CompositeScore;
  discoveredAt: number;
  expiresAt: number;
  tweetUrls: string[];
  whaleWallets: string[];
  rugcheckPassed: boolean;
  rugcheckScore?: number;
  creatorAddress: string;
  inDenylist: boolean;
}
