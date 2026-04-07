export type SignalSource = 'pumpportal' | 'helius_whale' | 'twitter_kol';
export type SignalConviction = 'low' | 'medium' | 'high';

export interface CompositeScore {
  volumeScore: number;       // 0–25
  holderScore: number;       // 0–25
  socialScore: number;       // 0–25
  whaleScore: number;        // 0–25
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
