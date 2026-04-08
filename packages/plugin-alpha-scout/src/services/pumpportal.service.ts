import WebSocket from 'ws';

export interface PumpPortalToken {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  timestamp: number;
}

export interface PumpMigrationEvent {
  mint: string;
  symbol: string;
  name: string;
  creator: string;
  pool?: string;
  timestamp: number;
}

export type PumpPortalCallback = (token: PumpPortalToken) => void;
export type PumpMigrationCallback = (event: PumpMigrationEvent) => void;

const WS_URL = 'wss://pumpportal.fun/api/data';
const RECONNECT_DELAY_MS = 5_000;

let ws: WebSocket | null = null;
let callback: PumpPortalCallback | null = null;
let migrationCallback: PumpMigrationCallback | null = null;
let shouldReconnect = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function handleOpen(): void {
  console.log('[alpha-scout] PumpPortal WebSocket connected');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    console.log('[alpha-scout] Subscribed to new token events');
    // Subscribe to migration events (tokens graduating from PumpFun to Raydium)
    ws.send(JSON.stringify({ method: 'subscribeTokenMigration' }));
    console.log('[alpha-scout] Subscribed to token migration events (PumpFun → Raydium)');
  }
}

function handleMessage(raw: WebSocket.RawData): void {
  try {
    const data = JSON.parse(raw.toString());

    // Detect migration events (PumpFun → Raydium)
    // ONLY match on explicit migration txType — NOT on `data.pool` or `data.migrated`
    // which appear on many non-migration messages and cause false positives.
    const txType = String(data.txType ?? data.type ?? data.event ?? '').toLowerCase();
    const isMigration = txType === 'migration' || txType === 'migrate' || txType === 'tokenmigration';
    if (isMigration) {
      const mint: string | undefined = data.mint ?? data.tokenMint ?? data.address;
      if (mint && migrationCallback) {
        const migrationEvent: PumpMigrationEvent = {
          mint,
          symbol: data.symbol ?? data.ticker ?? '',
          name: data.name ?? data.tokenName ?? '',
          creator: data.traderPublicKey ?? data.creator ?? '',
          pool: data.pool ?? data.poolAddress ?? '',
          timestamp: Date.now(),
        };
        console.log(`[alpha-scout] MIGRATION from PumpPortal: ${migrationEvent.symbol} (${migrationEvent.mint}) → Raydium`);
        migrationCallback(migrationEvent);
      }
      return;
    }

    // PumpPortal emits token creation events with mint, symbol, name, traderPublicKey
    const mint: string | undefined = data.mint ?? data.tokenMint ?? data.address;
    if (!mint) return;

    const token: PumpPortalToken = {
      mint,
      symbol: data.symbol ?? data.ticker ?? '',
      name: data.name ?? data.tokenName ?? '',
      creator: data.traderPublicKey ?? data.creator ?? '',
      timestamp: Date.now(),
    };

    console.log(`[alpha-scout] New token from PumpPortal: ${token.symbol} (${token.mint})`);

    if (callback) {
      callback(token);
    }
  } catch (err) {
    console.log(`[alpha-scout] PumpPortal message parse error: ${String(err)}`);
  }
}

function handleClose(): void {
  console.log('[alpha-scout] PumpPortal WebSocket closed');
  ws = null;
  scheduleReconnect();
}

function handleError(err: Error): void {
  console.log(`[alpha-scout] PumpPortal WebSocket error: ${err.message}`);
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  scheduleReconnect();
}

function scheduleReconnect(): void {
  if (!shouldReconnect) return;
  if (reconnectTimer) return;
  console.log(`[alpha-scout] Reconnecting to PumpPortal in ${RECONNECT_DELAY_MS}ms`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (shouldReconnect) {
      connectInternal();
    }
  }, RECONNECT_DELAY_MS);
}

function connectInternal(): void {
  if (ws) return;
  try {
    ws = new WebSocket(WS_URL);
    ws.on('open', handleOpen);
    ws.on('message', handleMessage);
    ws.on('close', handleClose);
    ws.on('error', handleError);
  } catch (err) {
    console.log(`[alpha-scout] PumpPortal connect failed: ${String(err)}`);
    ws = null;
    scheduleReconnect();
  }
}

export function connect(onToken: PumpPortalCallback): void {
  callback = onToken;
  shouldReconnect = true;
  connectInternal();
}

export function onMigration(cb: PumpMigrationCallback): void {
  migrationCallback = cb;
}

export function disconnect(): void {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  callback = null;
  migrationCallback = null;
  console.log('[alpha-scout] PumpPortal disconnected');
}
