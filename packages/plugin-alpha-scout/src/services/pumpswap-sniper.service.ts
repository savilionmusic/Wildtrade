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
  const rpcUrl = process.env.SOLANA_RPC_HELIUS
    || process.env.SOLANA_RPC_QUICKNODE
    || process.env.SOLANA_RPC_URL
    || 'https://api.mainnet-beta.solana.com';

  // Convert HTTP URL to WebSocket URL
  const wsUrl = rpcUrl
    .replace('https://', 'wss://')
    .replace('http://', 'ws://');

  try {
    connection = new Connection(rpcUrl, {
      wsEndpoint: wsUrl,
      commitment: 'confirmed',
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
  if (!connection) return;

  try {
    // Monitor logs from the PumpSwap migration program
    logsSubscriptionId = connection.onLogs(
      new PublicKey(PUMPSWAP_MIGRATION_PROGRAM),
      (logInfo) => {
        if (!running) return;

        try {
          // Parse the log to extract migration details
          const logs = logInfo.logs || [];
          const signature = logInfo.signature;

          // Look for token mint in the log instructions
          let detectedMint = '';
          let detectedPool = '';

          for (const logLine of logs) {
            // PumpSwap migration logs typically contain the token mint
            // Look for patterns like "Program log: Migrate ..." or account references
            if (logLine.includes('Migrate') || logLine.includes('migrate')) {
              log(`Migration log detected in tx ${signature.slice(0, 16)}...`);
            }

            // Extract mint from instruction data
            // The migration instruction typically references the token mint
            const mintMatch = logLine.match(/mint[:\s]+([A-Za-z0-9]{32,44})/i);
            if (mintMatch) {
              detectedMint = mintMatch[1];
            }

            const poolMatch = logLine.match(/pool[:\s]+([A-Za-z0-9]{32,44})/i);
            if (poolMatch) {
              detectedPool = poolMatch[1];
            }
          }

          // If we found a mint, also parse from the transaction accounts
          if (!detectedMint && logInfo.err === null) {
            // The migration transaction includes the token mint as one of the accounts
            // We'll need to fetch the transaction to get account keys
            fetchMigrationDetails(signature).catch(() => {});
          }

          if (detectedMint) {
            handleMigrationDetected({
              mint: detectedMint,
              symbol: '',
              name: '',
              pool: detectedPool,
              source: 'solana_logs',
              detectedAt: Date.now(),
              migrationTx: signature,
            });
          }
        } catch (err) {
          // Don't crash on log parse errors
        }
      },
      'confirmed',
    );

    log('Subscribed to PumpSwap migration program logs');
  } catch (err) {
    log(`Failed to subscribe to migration logs: ${String(err)}`);
  }
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

    // In a PumpSwap migration, the token mint is typically one of the first few accounts
    // after the program IDs. Look for SPL token mints.
    for (const key of accountKeys) {
      const pubkey = typeof key === 'string' ? key : key.pubkey.toBase58();

      // Skip known programs
      if (pubkey === PUMPFUN_PROGRAM_ID || pubkey === PUMPSWAP_MIGRATION_PROGRAM || pubkey === RAYDIUM_AMM_PROGRAM) continue;
      if (pubkey === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') continue; // Token program
      if (pubkey === '11111111111111111111111111111111') continue; // System program
      if (pubkey === 'So11111111111111111111111111111111111111112') continue; // SOL

      // This is likely the token mint — validate by checking if it looks like a mint
      // (44 char base58 string that isn't a known program)
      if (pubkey.length >= 32 && pubkey.length <= 44) {
        handleMigrationDetected({
          mint: pubkey,
          symbol: '',
          name: '',
          pool: '',
          source: 'solana_logs',
          detectedAt: Date.now(),
          migrationTx: signature,
        });
        break; // Only snipe the first detected mint
      }
    }
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
