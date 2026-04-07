export type ErrorCategory =
  | 'rpc_429'
  | 'rpc_504'
  | 'rpc_generic'
  | 'jupiter_quote'
  | 'jupiter_swap'
  | 'tx_simulation'
  | 'tx_timeout'
  | 'rugcheck_api'
  | 'reconcile_diff'
  | 'ws_disconnect';

export interface TradingError {
  id: string;
  category: ErrorCategory;
  message: string;
  rawError?: string;
  mintAddress?: string;
  positionId?: string;
  rpcEndpoint?: string;
  occurredAt: number;
  retryCount: number;
  resolved: boolean;
  resolvedAt?: number;
  recoveryAction?: string;
}

export interface BackoffConfig {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterMs: number;
  maxRetries: number;
}

export interface ReconcileDiscrepancy {
  positionId: string;
  mintAddress: string;
  type: 'missing_token_account' | 'balance_mismatch' | 'orphaned_position' | 'price_stale';
  onChainBalance: string;
  dbBalance: string;
  deltaLamports: string;
  detectedAt: number;
}
