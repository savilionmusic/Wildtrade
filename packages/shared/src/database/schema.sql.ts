export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS signals (
  id              TEXT PRIMARY KEY,
  mint            TEXT NOT NULL,
  symbol          TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  market_cap_usd  REAL NOT NULL DEFAULT 0,
  liquidity_usd   REAL NOT NULL DEFAULT 0,
  sources         TEXT NOT NULL DEFAULT '[]',
  score_json      TEXT NOT NULL DEFAULT '{}',
  discovered_at   BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  tweet_urls      TEXT NOT NULL DEFAULT '[]',
  whale_wallets   TEXT NOT NULL DEFAULT '[]',
  rugcheck_passed INTEGER NOT NULL DEFAULT 0,
  rugcheck_score  REAL,
  creator_addr    TEXT NOT NULL DEFAULT '',
  in_denylist     INTEGER NOT NULL DEFAULT 0,
  expired         INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_signals_mint ON signals(mint);
CREATE INDEX IF NOT EXISTS idx_signals_discovered ON signals(discovered_at DESC);

CREATE TABLE IF NOT EXISTS positions (
  id                    TEXT PRIMARY KEY,
  signal_id             TEXT,
  mint                  TEXT NOT NULL,
  symbol                TEXT NOT NULL DEFAULT '',
  name                  TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL,
  budget_sol            REAL NOT NULL DEFAULT 0,
  entry_price_usd       REAL,
  current_price_usd     REAL,
  token_balance         REAL NOT NULL DEFAULT 0,
  sol_deployed          REAL NOT NULL DEFAULT 0,
  sol_returned          REAL NOT NULL DEFAULT 0,
  pnl_sol               REAL NOT NULL DEFAULT 0,
  pnl_pct               REAL NOT NULL DEFAULT 0,
  dca_legs              TEXT NOT NULL DEFAULT '[]',
  exit_tiers            TEXT NOT NULL DEFAULT '[]',
  paper                 INTEGER NOT NULL DEFAULT 1,
  opened_at             BIGINT NOT NULL,
  closed_at             BIGINT,
  total_budget_lamports TEXT,
  entry_price_sol       REAL,
  current_price_sol     REAL,
  unrealized_pnl_sol    REAL,
  dca_legs_json         TEXT,
  exit_tiers_json       TEXT,
  is_paper_trade        INTEGER,
  approval_required     INTEGER NOT NULL DEFAULT 0,
  approved_at           BIGINT,
  approved_by           TEXT,
  created_at            BIGINT,
  realized_pnl_sol      REAL,
  last_reconciled_at    BIGINT,
  entry_mcap            REAL
);

CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);

CREATE TABLE IF NOT EXISTS errors (
  id                TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  message           TEXT NOT NULL,
  raw_error         TEXT,
  mint              TEXT,
  position_id       TEXT,
  rpc_endpoint      TEXT,
  occurred_at       BIGINT NOT NULL,
  retry_count       INTEGER NOT NULL DEFAULT 0,
  resolved          INTEGER NOT NULL DEFAULT 0,
  resolved_at       BIGINT,
  recovery_action   TEXT
);

CREATE INDEX IF NOT EXISTS idx_errors_category ON errors(category);
CREATE INDEX IF NOT EXISTS idx_errors_occurred ON errors(occurred_at DESC);

CREATE TABLE IF NOT EXISTS rpc_endpoints (
  url                  TEXT PRIMARY KEY,
  provider             TEXT NOT NULL,
  priority             INTEGER NOT NULL,
  is_healthy           INTEGER NOT NULL DEFAULT 1,
  last_error_at        BIGINT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_used_at         BIGINT
);

CREATE TABLE IF NOT EXISTS denylist (
  address     TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  added_at    BIGINT NOT NULL,
  source      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconcile_log (
  id                TEXT PRIMARY KEY,
  position_id       TEXT,
  mint              TEXT NOT NULL,
  discrepancy_type  TEXT NOT NULL,
  on_chain_balance  TEXT,
  db_balance        TEXT,
  delta_lamports    TEXT,
  action_taken      TEXT,
  detected_at       BIGINT NOT NULL,
  resolved          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_reconcile_position ON reconcile_log(position_id);

CREATE TABLE IF NOT EXISTS trader_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_history (
  id          TEXT PRIMARY KEY,
  mint        TEXT NOT NULL,
  symbol      TEXT NOT NULL DEFAULT '',
  entry_score REAL NOT NULL DEFAULT 0,
  entry_mcap  REAL NOT NULL DEFAULT 0,
  pnl_pct     REAL NOT NULL DEFAULT 0,
  hold_time_ms BIGINT NOT NULL DEFAULT 0,
  exit_reason TEXT NOT NULL DEFAULT '',
  phase       TEXT NOT NULL DEFAULT '',
  closed_at   BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trade_history_closed ON trade_history(closed_at DESC);
`;
