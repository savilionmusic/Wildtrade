export type PositionStatus =
  | 'pending_approval'
  | 'approved'
  | 'dca_filling'
  | 'open'
  | 'partial_exit'
  | 'closed'
  | 'failed'
  | 'cancelled';

export interface DCALeg {
  legIndex: 0 | 1 | 2;
  allocPercent: 20 | 30 | 50;
  scheduledAt: number;
  executedAt?: number;
  inputAmountLamports: string;
  outputAmountTokens?: string;
  averagePriceSol?: number;
  txSignature?: string;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  failureReason?: string;
}

export interface ExitTier {
  tierIndex: 0 | 1 | 2;
  targetMultiple: 2 | 5 | 10;
  sellPercent: 50 | 25 | 25;
  triggeredAt?: number;
  executedAt?: number;
  txSignature?: string;
  receivedSol?: number;
  status: 'watching' | 'triggered' | 'submitted' | 'filled' | 'failed';
}

export interface TradePosition {
  id: string;
  signalId: string;
  mintAddress: string;
  status: PositionStatus;
  totalBudgetLamports: string;
  entryPriceSol: number;
  currentPriceSol?: number;
  unrealizedPnlSol?: number;
  tokenBalance: string;
  dcaLegs: DCALeg[];
  exitTiers: ExitTier[];
  isPaperTrade: boolean;
  approvalRequired: boolean;
  approvedAt?: number;
  approvedBy?: 'user' | 'autonomous' | 'auto_small';
  createdAt: number;
  closedAt?: number;
  realizedPnlSol?: number;
  lastReconciledAt?: number;
}
