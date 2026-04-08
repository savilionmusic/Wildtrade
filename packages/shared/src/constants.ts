export const FINDER_TO_TRADER_ROOM = '11111111-0000-0000-0000-000000000001';
export const TRADER_TO_AUDITOR_ROOM = '11111111-0000-0000-0000-000000000002';
export const AUDITOR_TO_ALL_ROOM = '11111111-0000-0000-0000-000000000003';

export const SERVICE_TYPES = {
  WILDTRADE_DB: 'wildtrade_db',
  PUMP_PORTAL: 'pump_portal_scanner',
  HELIUS_TRACKER: 'helius_tracker',
  TWITTER_SCRAPER: 'twitter_scraper',
  JUPITER_SWAP: 'jupiter_swap',
  POSITION_TRACKER: 'position_tracker',
  RPC_ROTATOR: 'rpc_rotator',
  RECONCILER: 'reconciler',
} as const;

export const SCORE_THRESHOLDS = {
  MIN_TO_TRADE: 55,
  HIGH_CONVICTION: 75,
  MEDIUM_CONVICTION: 55,
};

export const DCA_ALLOCATION = [20, 30, 50] as const;

export const EXIT_TIERS = [
  { multiple: 2, sellPct: 50 },
  { multiple: 5, sellPct: 25 },
  { multiple: 10, sellPct: 25 },
] as const;

// Faster exit tiers for migration snipes — take profit quickly
export const MIGRATION_EXIT_TIERS = [
  { multiple: 1.3, sellPct: 40 },
  { multiple: 1.5, sellPct: 30 },
  { multiple: 2, sellPct: 30 },
] as const;

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const APPROVAL_GATE_TTL_MS = 30_000;
export const RECONCILE_INTERVAL_MS = 300_000;
export const SIGNAL_DEFAULT_TTL_MS = 1_800_000;
export const RPC_HEALTH_CHECK_MS = 30_000;
export const PRICE_POLL_INTERVAL_MS = 15_000;
export const RPC_FAILURE_THRESHOLD = 3;
