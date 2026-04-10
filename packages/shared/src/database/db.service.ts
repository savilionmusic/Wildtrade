import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_SQL } from './schema.sql.js';
import path from 'path';

let instance: PGlite | null = null;

// Migration: add new columns to existing positions table if they don't exist yet
const MIGRATION_SQL = `
ALTER TABLE positions ADD COLUMN IF NOT EXISTS symbol TEXT NOT NULL DEFAULT '';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS budget_sol REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_price_usd REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS current_price_usd REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS sol_deployed REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS sol_returned REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS pnl_sol REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS pnl_pct REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS dca_legs TEXT NOT NULL DEFAULT '[]';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_tiers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS paper INTEGER NOT NULL DEFAULT 1;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS opened_at BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS total_budget_lamports TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_mcap REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS closed_at BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS realized_pnl_sol REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS dca_legs_executed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_tiers_hit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS high_water_mark REAL NOT NULL DEFAULT 1.0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_score REAL NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS kol_strategy TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS is_paper_trade INTEGER;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS approval_required INTEGER NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS approved_at BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS created_at BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS last_reconciled_at BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_price_sol REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS current_price_sol REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS unrealized_pnl_sol REAL;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS dca_legs_json TEXT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exit_tiers_json TEXT;
`;

export async function getDb(): Promise<PGlite> {
  if (instance) return instance;
  const rawDir = process.env.PGLITE_DATA_DIR || './.wildtrade-db';
  const dataDir = path.isAbsolute(rawDir) ? rawDir : path.resolve(process.cwd(), rawDir);
  instance = new PGlite(dataDir);
  await instance.exec(SCHEMA_SQL);
  try {
    await instance.exec(MIGRATION_SQL);
  } catch {
    // Migrations may fail silently if columns already exist from the new schema
  }
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
