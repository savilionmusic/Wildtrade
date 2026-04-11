/**
 * PumpSwap Migration Sniper — Catches PumpFun tokens migrating to PumpSwap/Raydium.
 *
 * Inspired by https://github.com/cutupdev/PumpSwap-Migration-Sniper-Bot
 *
 * Strategy:
 *   1. Listen for migration events via PumpPortal WebSocket (already connected)
 *   2. Also monitor Solana logs for the PumpSwap migration program
 *   3. When a migration is detected, immediately forward to autonomous trader
 *      with a HIGH priority flag for instant buy (skip DCA queue)
 *   4. Use tighter exit tiers for migration snipes (take profit faster)
 *
 * Tokens that migrate from PumpFun typically pump 30-100%+ within minutes
 * as the bonding curve graduates and DEX liquidity opens up.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import {
  DEFAULT_PUBLIC_RPC_ENDPOINT,
  selectPrimaryHttpRpcEndpoint,
  selectPrimaryWsRpcEndpoint,
} from '@wildtrade/shared';

// PumpSwap / PumpFun migration program IDs
const PUMPFUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP_MIGRATION_PROGRAM = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';

// Rate limit: max 1 snipe per 10 seconds (was 30s — too slow for burst migrations)
const MIN_SNIPE_INTERVAL_MS = 10_000;
const MAX_SNIPES_PER_HOUR = 15;

// ── Types ──

export interface MigrationSnipeEvent {
  mint: string;
  symbol: string;
  name: string;
  pool: string;
  source: 'pumpportal_ws' | 'solana_logs';
  detectedAt: number;
  migrationTx?: string;
}

export type SnipeCallback = (event: MigrationSnipeEvent) => void;

// ── State ──

let running = false;
let snipeCallback: SnipeCallback | null = null;
let logsSubscriptionId: number | null = null;
let connection: Connection | null = null;
let lastSnipeTime = 0;
let snipesThisHour: number[] = [];

type LogCb = (msg: string) => void;
let log: LogCb = (msg) => console.log(`[pumpswap-sniper] ${msg}`);

// Track recently sniped mints to avoid duplicates
const recentSnipes = new Set<string>();

// Track WebSocket errors to suppress repeated spam
let wsErrorCount = 0;
let lastWsErrorLog = 0;
const WS_ERROR_LOG_INTERVAL_MS = 60_000; // Only log WS errors once per minute

// ── Public API ──

/**
 * Start monitoring for PumpSwap migrations via Solana WebSocket logs.
 * This supplements the PumpPortal WebSocket migration detection.
 */
export function startPumpSwapSniper(
  callback: SnipeCallback,
  onLog?: LogCb,
): void {
  if (running) return;
  running = true;
  snipeCallback = callback;
  if (onLog) log = onLog;

  log('Starting PumpSwap migration sniper...');

  // Connect to Solana WebSocket for real-time log monitoring
  const rpcUrl = selectPrimaryHttpRpcEndpoint();

  // Validate that the RPC URL looks real (not a placeholder)
  const lowerUrl = rpcUrl.toLowerCase();
  if (
    lowerUrl.includes('your_') || lowerUrl.includes('your-') ||
    lowerUrl.includes('placeholder') || lowerUrl.includes('example') ||
    rpcUrl === DEFAULT_PUBLIC_RPC_ENDPOINT
  ) {
    log('Skipping Solana WebSocket — no dedicated private RPC URL is configured for on-chain migration detection.');
    log('Will rely on PumpPortal WebSocket for migration events only.');
    return;
  }

  const wsUrl = selectPrimaryWsRpcEndpoint();

  try {
    connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'confirmed',
      fetch: global.fetch,
    });

    // Subscribe to logs mentioning the PumpSwap migration program
    subscribeToMigrationLogs();
    log(`Monitoring PumpSwap migrations via Solana logs (${wsUrl.slice(0, 40)}...)`);
  } catch (err) {
    log(`Failed to connect for log monitoring: ${String(err)} — will rely on PumpPortal WS only`);
  }
}

export function stopPumpSwapSniper(): void {
  running = false;
  snipeCallback = null;

  if (connection && logsSubscriptionId !== null) {
    try {
      connection.removeOnLogsListener(logsSubscriptionId);
    } catch { /* ignore */ }
    logsSubscriptionId = null;
  }

  connection = null;
  recentSnipes.clear();
  log('PumpSwap sniper stopped');
}

/**
 * Called by scanner-engine when PumpPortal detects a migration.
 * This gives us a second chance to snipe if the log subscription missed it.
 */
export function onPumpPortalMigration(event: {
  mint: string;
  symbol: string;
  name: string;
  pool?: string;
}): void {
  if (!running || !snipeCallback) return;

  handleMigrationDetected({
    mint: event.mint,
    symbol: event.symbol || '',
    name: event.name || '',
    pool: event.pool || '',
    source: 'pumpportal_ws',
    detectedAt: Date.now(),
  });
}

export function getSnipeStats(): {
  running: boolean;
  recentSnipes: number;
  snipesThisHour: number;
} {
  cleanupHourlySnipes();
  return {
    running,
    recentSnipes: recentSnipes.size,
    snipesThisHour: snipesThisHour.length,
  };
}

// ── Internal: Solana Log Subscription ──

function subscribeToMigrationLogs(): void {
  // WEBSOCKET OVERRIDE: We no longer poll Solana RPC for migration logs.
  // We rely entirely on `pumpportal.service.ts` WebSocket which feeds `onPumpPortalMigration`.
  // Fetching `getParsedTransaction` on every migration was causing massive 429 rate limit bans.
  log(`Skipping direct RPC log subscription to save rate limits. Relying on PumpPortal WebSocket.`);
}

async function fetchMigrationDetails(signature: string): Promise<void> {
  if (!connection) return;

  try {
    // Fetch the full transaction to extract token mint from accounts
    const tx = await connection.getParsedTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.transaction) return;

    const accountKeys = tx.transaction.message.accountKeys;

    // Known programs and accounts to skip
    const SKIP_PUBKEYS = new Set([
      PUMPFUN_PROGRAM_ID,
      PUMPSWAP_MIGRATION_PROGRAM,
      RAYDIUM_AMM_PROGRAM,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',  // Token program
      'Token2011111111111111111111111111111111111111', // Token-2022
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // ATA program
      '11111111111111111111111111111111',               // System program
      'So11111111111111111111111111111111111111112',    // Wrapped SOL
      'SysvarRent111111111111111111111111111111111',    // Rent sysvar
      'SysvarC1ock11111111111111111111111111111111',    // Clock sysvar
      'ComputeBudget111111111111111111111111111111',    // Compute budget
    ]);

    // Look for the actual SPL token mint by checking parsed account info
    // In a parsed transaction, accounts that are token mints have `program: 'spl-token'`
    // and `type: 'mint'` in their parsed info.
    const candidates: string[] = [];
    for (const key of accountKeys) {
      const pubkey = typeof key === 'string' ? key : key.pubkey.toBase58();
      if (SKIP_PUBKEYS.has(pubkey)) continue;
      if (pubkey.length < 32 || pubkey.length > 44) continue;
      candidates.push(pubkey);
    }

    // Try to validate candidates are actual token mints via getMultipleAccountsInfo (single RPC call to avoid 429 limits)
    try {
      const candidatesToValidate = candidates.slice(0, 5);
      const pubKeys = candidatesToValidate.map(c => new PublicKey(c));
      const accounts = await connection!.getMultipleAccountsInfo(pubKeys);

      for (let i = 0; i < accounts.length; i++) {
        const acct = accounts[i];
        if (acct && acct.owner.toBase58() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
          // It's an SPL token. A mint account is 82 bytes.
          if (acct.data.length === 82) {
            handleMigrationDetected({
              mint: candidatesToValidate[i]!,
              symbol: '',
              name: '',
              pool: '',
              source: 'solana_logs',
              detectedAt: Date.now(),
              migrationTx: signature,
            });
            return;
          }
        }
      }
    } catch {
      // Fetch failed, skip and avoid blocking
    }

    // No confirmed mint found — do NOT fire on unverified accounts
    log(`Migration tx ${signature.slice(0, 16)}... — could not confirm token mint from accounts`);
  } catch {
    // Transaction fetch failed — not critical
  }
}

// ── Internal: Migration Handler ──

function handleMigrationDetected(event: MigrationSnipeEvent): void {
  if (!running || !snipeCallback) return;

  const { mint } = event;

  // Skip if already sniped recently
  if (recentSnipes.has(mint)) return;

  // Rate limit: at least MIN_SNIPE_INTERVAL between snipes
  const now = Date.now();
  if (now - lastSnipeTime < MIN_SNIPE_INTERVAL_MS) {
    log(`Rate limited: skipping ${event.symbol || mint.slice(0, 8)} (last snipe ${((now - lastSnipeTime) / 1000).toFixed(0)}s ago)`);
    return;
  }

  // Hourly limit check
  cleanupHourlySnipes();
  if (snipesThisHour.length >= MAX_SNIPES_PER_HOUR) {
    log(`Hourly snipe limit reached (${MAX_SNIPES_PER_HOUR}) — skipping ${event.symbol || mint.slice(0, 8)}`);
    return;
  }

  // Mark as sniped
  recentSnipes.add(mint);
  lastSnipeTime = now;
  snipesThisHour.push(now);

  // Clean up old entries after 30 min
  setTimeout(() => recentSnipes.delete(mint), 30 * 60_000);

  log(
    `🎯 MIGRATION SNIPE: ${event.symbol || mint.slice(0, 8)} | ` +
    `Source: ${event.source} | Pool: ${event.pool?.slice(0, 8) || 'unknown'} | ` +
    `${event.migrationTx ? `Tx: ${event.migrationTx.slice(0, 16)}...` : ''}`,
  );

  // Fire callback to autonomous trader for immediate buy
  snipeCallback(event);
}

function cleanupHourlySnipes(): void {
  const hourAgo = Date.now() - 3_600_000;
  snipesThisHour = snipesThisHour.filter(t => t > hourAgo);
}
