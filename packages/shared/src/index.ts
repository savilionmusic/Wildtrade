// Types
export type { AlphaSignal, CompositeScore, SignalSource, SignalConviction } from './types/signals.js';
export type {
  TradePosition, DCALeg, ExitTier, PositionStatus,
} from './types/positions.js';
export type {
  AgentName, SocketEventType, SocketPayload, ApprovalRequestData,
  ApprovalResponseData, DcaLegExecutedData, ExitTriggeredData,
  AgentStatusData, RpcRotatedData, RugcheckFlaggedData,
  InterAgentMessage, InterAgentMessageType,
} from './types/messages.js';
export type {
  TradingError, BackoffConfig, ReconcileDiscrepancy, ErrorCategory,
} from './types/errors.js';

// Constants
export * from './constants.js';

// RPC
export * from './rpc.js';

// Database
export { getDb, closeDb } from './database/db.service.js';
