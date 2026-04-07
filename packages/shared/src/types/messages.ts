import type { AlphaSignal } from './signals.js';
import type { TradePosition, DCALeg, ExitTier } from './positions.js';
import type { TradingError } from './errors.js';

export type AgentName = 'finder' | 'trader' | 'auditor';

export type SocketEventType =
  | 'signal:new'
  | 'signal:expired'
  | 'trade:approval_required'
  | 'trade:approved'
  | 'trade:rejected'
  | 'trade:dca_leg_executed'
  | 'trade:exit_triggered'
  | 'trade:position_closed'
  | 'position:update'
  | 'agent:status'
  | 'agent:error'
  | 'rpc:rotated'
  | 'rugcheck:flagged'
  | 'denylist:updated'
  | 'reconcile:discrepancy';

export interface SocketPayload<T = unknown> {
  event: SocketEventType;
  agent: AgentName;
  timestamp: number;
  data: T;
}

export interface ApprovalRequestData {
  positionId: string;
  mintAddress: string;
  symbol: string;
  proposedBudgetSol: number;
  signal: AlphaSignal;
  expiresAt: number;
}

export interface ApprovalResponseData {
  positionId: string;
  approved: boolean;
  budgetMultiplier?: number;
}

export interface DcaLegExecutedData {
  positionId: string;
  leg: DCALeg;
  remainingLegs: number;
}

export interface ExitTriggeredData {
  positionId: string;
  tier: ExitTier;
  receivedSol: number;
  remainingTokenBalance: string;
}

export interface AgentStatusData {
  agent: AgentName;
  status: 'online' | 'degraded' | 'offline';
  detail?: string;
  uptimeSeconds?: number;
}

export interface RpcRotatedData {
  fromEndpoint: string;
  toEndpoint: string;
  reason: string;
  consecutiveFailures: number;
}

export interface RugcheckFlaggedData {
  mintAddress: string;
  creatorAddress: string;
  rugcheckScore: number;
  reason: string;
  openPositionId?: string;
}

export type InterAgentMessageType =
  | 'signal_ready'
  | 'trade_failed'
  | 'position_orphaned'
  | 'denylist_updated'
  | 'rpc_rotated'
  | 'recovery_complete';

export interface InterAgentMessage {
  fromAgent: AgentName;
  toAgent: AgentName | 'all';
  type: InterAgentMessageType;
  correlationId: string;
  payload: unknown;
  timestamp: number;
}
