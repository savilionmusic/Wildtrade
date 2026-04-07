import type { Server as SocketIOServer } from 'socket.io';
import type { ApprovalResponseData } from '@wildtrade/shared';
import { APPROVAL_GATE_TTL_MS } from '@wildtrade/shared';
import { broadcast } from './server.js';

interface DeferredApproval {
  resolve: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

export interface ApprovalResult {
  approved: boolean;
  approvedBy?: 'user' | 'autonomous' | 'auto_small';
  budgetMultiplier?: number;
  reason?: string;
}

const pending = new Map<string, DeferredApproval>();

export function initApprovalGate(io: SocketIOServer): void {
  io.on('connection', (socket) => {
    socket.on('trade:approve', (data: ApprovalResponseData) => {
      const deferred = pending.get(data.positionId);
      if (!deferred) return;
      clearTimeout(deferred.timer);
      pending.delete(data.positionId);
      deferred.resolve({
        approved: true,
        approvedBy: 'user',
        budgetMultiplier: data.budgetMultiplier,
      });
      broadcast('trade:approved', 'trader', { positionId: data.positionId, approvedBy: 'user' });
    });

    socket.on('trade:reject', (data: { positionId: string }) => {
      const deferred = pending.get(data.positionId);
      if (!deferred) return;
      clearTimeout(deferred.timer);
      pending.delete(data.positionId);
      deferred.resolve({ approved: false, approvedBy: 'user', reason: 'rejected' });
      broadcast('trade:rejected', 'trader', { positionId: data.positionId, reason: 'rejected' });
    });
  });
}

export async function requestApproval(
  positionId: string,
  budgetSol: number,
): Promise<ApprovalResult> {
  // Auto-approve in autonomous mode
  if (process.env.AUTONOMOUS_MODE === 'true') {
    console.log(`[approval-gate] Auto-approved (autonomous mode): ${positionId}`);
    return { approved: true, approvedBy: 'autonomous' };
  }

  // Auto-approve small positions
  const maxSize = parseFloat(process.env.MAX_POSITION_SIZE_SOL || '1.0');
  if (budgetSol <= maxSize) {
    console.log(`[approval-gate] Auto-approved (within size limit ${budgetSol} <= ${maxSize} SOL): ${positionId}`);
    return { approved: true, approvedBy: 'auto_small' };
  }

  // Require manual approval
  console.log(`[approval-gate] Awaiting user approval for ${positionId} (${budgetSol} SOL)`);
  broadcast('trade:approval_required', 'trader', {
    positionId,
    proposedBudgetSol: budgetSol,
    expiresAt: Date.now() + APPROVAL_GATE_TTL_MS,
  });

  return new Promise<ApprovalResult>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(positionId);
      console.log(`[approval-gate] Timed out: ${positionId}`);
      resolve({ approved: false, reason: 'timeout' });
      broadcast('trade:rejected', 'trader', { positionId, reason: 'timeout' });
    }, APPROVAL_GATE_TTL_MS);

    pending.set(positionId, { resolve, timer, expiresAt: Date.now() + APPROVAL_GATE_TTL_MS });
  });
}
