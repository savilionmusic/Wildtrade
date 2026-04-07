import type { TradePosition, AlphaSignal } from '@wildtrade/shared';
import { getDb } from '@wildtrade/shared';
import { v4 as uuidv4 } from 'uuid';
import { calculateDCALegs } from '../lib/dca-calculator.js';
import { buildExitTiers } from '../lib/exit-strategy.js';

function rowToPosition(row: Record<string, unknown>): TradePosition {
  return {
    id: row.id as string,
    signalId: row.signal_id as string,
    mintAddress: row.mint as string,
    status: row.status as TradePosition['status'],
    totalBudgetLamports: row.total_budget_lamports as string,
    entryPriceSol: row.entry_price_sol as number,
    currentPriceSol: row.current_price_sol as number | undefined,
    unrealizedPnlSol: row.unrealized_pnl_sol as number | undefined,
    tokenBalance: row.token_balance as string,
    dcaLegs: JSON.parse((row.dca_legs_json as string) || '[]'),
    exitTiers: JSON.parse((row.exit_tiers_json as string) || '[]'),
    isPaperTrade: Boolean(row.is_paper_trade),
    approvalRequired: Boolean(row.approval_required),
    approvedAt: row.approved_at as number | undefined,
    approvedBy: row.approved_by as TradePosition['approvedBy'],
    createdAt: row.created_at as number,
    closedAt: row.closed_at as number | undefined,
    realizedPnlSol: row.realized_pnl_sol as number | undefined,
    lastReconciledAt: row.last_reconciled_at as number | undefined,
  };
}

export async function createPosition(
  signal: AlphaSignal,
  budgetLamports: string,
  isPaper: boolean,
): Promise<TradePosition> {
  const db = await getDb();
  const now = Date.now();
  const id = uuidv4();

  const dcaLegs = calculateDCALegs(budgetLamports, now);
  const exitTiers = buildExitTiers();

  const autonomousMode = process.env.AUTONOMOUS_MODE === 'true';
  const approvalRequired = !autonomousMode;

  const position: TradePosition = {
    id,
    signalId: signal.id,
    mintAddress: signal.mintAddress,
    status: 'pending_approval',
    totalBudgetLamports: budgetLamports,
    entryPriceSol: 0,
    tokenBalance: '0',
    dcaLegs,
    exitTiers,
    isPaperTrade: isPaper,
    approvalRequired,
    createdAt: now,
  };

  await db.query(
    `INSERT INTO positions (
      id, signal_id, mint, status, total_budget_lamports,
      entry_price_sol, current_price_sol, unrealized_pnl_sol,
      token_balance, dca_legs_json, exit_tiers_json,
      is_paper_trade, approval_required, approved_at, approved_by,
      created_at, closed_at, realized_pnl_sol, last_reconciled_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8,
      $9, $10, $11,
      $12, $13, $14, $15,
      $16, $17, $18, $19
    )`,
    [
      position.id,
      position.signalId,
      position.mintAddress,
      position.status,
      position.totalBudgetLamports,
      position.entryPriceSol,
      position.currentPriceSol ?? null,
      position.unrealizedPnlSol ?? null,
      position.tokenBalance,
      JSON.stringify(position.dcaLegs),
      JSON.stringify(position.exitTiers),
      position.isPaperTrade ? 1 : 0,
      position.approvalRequired ? 1 : 0,
      position.approvedAt ?? null,
      position.approvedBy ?? null,
      position.createdAt,
      position.closedAt ?? null,
      position.realizedPnlSol ?? null,
      position.lastReconciledAt ?? null,
    ],
  );

  console.log(`[smart-trader] Position created: ${id} for ${signal.symbol} (${signal.mintAddress})`);
  return position;
}

export async function getPosition(id: string): Promise<TradePosition | null> {
  const db = await getDb();
  const result = await db.query('SELECT * FROM positions WHERE id = $1', [id]);

  if (result.rows.length === 0) return null;
  return rowToPosition(result.rows[0] as Record<string, unknown>);
}

export async function getOpenPositions(): Promise<TradePosition[]> {
  const db = await getDb();
  const result = await db.query(
    `SELECT * FROM positions WHERE status NOT IN ('closed', 'failed', 'cancelled') ORDER BY created_at DESC`,
  );
  return result.rows.map((row) => rowToPosition(row as Record<string, unknown>));
}

export async function updatePosition(
  id: string,
  updates: Partial<TradePosition>,
): Promise<void> {
  const db = await getDb();

  const fieldMap: Record<string, string> = {
    status: 'status',
    entryPriceSol: 'entry_price_sol',
    currentPriceSol: 'current_price_sol',
    unrealizedPnlSol: 'unrealized_pnl_sol',
    tokenBalance: 'token_balance',
    dcaLegs: 'dca_legs_json',
    exitTiers: 'exit_tiers_json',
    approvedAt: 'approved_at',
    approvedBy: 'approved_by',
    closedAt: 'closed_at',
    realizedPnlSol: 'realized_pnl_sol',
    lastReconciledAt: 'last_reconciled_at',
  };

  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  for (const [key, value] of Object.entries(updates)) {
    const column = fieldMap[key];
    if (!column) continue;

    let dbValue = value;
    if (key === 'dcaLegs' || key === 'exitTiers') {
      dbValue = JSON.stringify(value);
    } else if (typeof value === 'boolean') {
      dbValue = value ? 1 : 0;
    }

    setClauses.push(`${column} = $${paramIndex}`);
    values.push(dbValue);
    paramIndex++;
  }

  if (setClauses.length === 0) return;

  values.push(id);
  const sql = `UPDATE positions SET ${setClauses.join(', ')} WHERE id = $${paramIndex}`;
  await db.query(sql, values);

  console.log(`[smart-trader] Position updated: ${id} -> ${JSON.stringify(Object.keys(updates))}`);
}

export interface PortfolioSummary {
  totalDeployed: number;
  totalUnrealized: number;
  totalRealized: number;
  winRate: number;
  openCount: number;
}

export async function getPortfolioSummary(): Promise<PortfolioSummary> {
  const db = await getDb();

  const openResult = await db.query(
    `SELECT * FROM positions WHERE status NOT IN ('closed', 'failed', 'cancelled')`,
  );
  const openPositions = openResult.rows as Record<string, unknown>[];

  const closedResult = await db.query(
    `SELECT realized_pnl_sol FROM positions WHERE status = 'closed'`,
  );
  const closedRows = closedResult.rows as Record<string, unknown>[];

  let totalDeployed = 0;
  let totalUnrealized = 0;

  for (const row of openPositions) {
    const budgetLamports = BigInt(row.total_budget_lamports as string);
    totalDeployed += Number(budgetLamports) / 1e9;
    totalUnrealized += (row.unrealized_pnl_sol as number) || 0;
  }

  let totalRealized = 0;
  let wins = 0;
  for (const row of closedRows) {
    const pnl = (row.realized_pnl_sol as number) || 0;
    totalRealized += pnl;
    if (pnl > 0) wins++;
  }

  const totalClosed = closedRows.length;
  const winRate = totalClosed > 0 ? (wins / totalClosed) * 100 : 0;

  return {
    totalDeployed,
    totalUnrealized,
    totalRealized,
    winRate,
    openCount: openPositions.length,
  };
}
