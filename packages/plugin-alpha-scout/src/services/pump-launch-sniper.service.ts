import type { PumpPortalToken } from './pumpportal.service.js';

export interface PumpLaunchSnipeEvent {
  mint: string;
  symbol: string;
  name: string;
  source: 'pumpportal_launch';
  liquidityUsd: number;
  volumeH1Usd: number;
  buySellRatio: number;
  ageMinutes: number;
}

export type PumpLaunchSnipeCallback = (event: PumpLaunchSnipeEvent) => void;

type LogCb = (msg: string) => void;

type QueueItem = {
  token: PumpPortalToken;
  attempts: number;
  nextEligibleAt: number;
};

const BASE_PROCESS_DELAY_MS = Math.max(600, Number(process.env.PUMP_SNIPE_BASE_DELAY_MS ?? 1_500));
const MAX_PROCESS_DELAY_MS = Math.max(BASE_PROCESS_DELAY_MS, Number(process.env.PUMP_SNIPE_MAX_DELAY_MS ?? 10_000));
const MAX_QUEUE_SIZE = Math.max(20, Number(process.env.PUMP_SNIPE_MAX_QUEUE ?? 80));
const MAX_RETRY_ATTEMPTS = Math.max(1, Number(process.env.PUMP_SNIPE_MAX_RETRY ?? 2));
const RETRY_BASE_DELAY_MS = Math.max(1_000, Number(process.env.PUMP_SNIPE_RETRY_BASE_MS ?? 2_000));

const MIN_LIQUIDITY_USD = Math.max(500, Number(process.env.PUMP_SNIPE_MIN_LIQUIDITY_USD ?? 2_500));
const MIN_VOLUME_H1_USD = Math.max(0, Number(process.env.PUMP_SNIPE_MIN_VOLUME_H1_USD ?? 1_000));
const MIN_BUY_SELL_RATIO = Math.max(0.5, Number(process.env.PUMP_SNIPE_MIN_BUY_SELL_RATIO ?? 1.1));
const MAX_PAIR_AGE_MINUTES = Math.max(1, Number(process.env.PUMP_SNIPE_MAX_AGE_MINUTES ?? 30));

let running = false;
let callback: PumpLaunchSnipeCallback | null = null;
let log: LogCb = (msg) => console.log(`[pump-launch-sniper] ${msg}`);

let adaptiveDelayMs = BASE_PROCESS_DELAY_MS;
let processTimer: ReturnType<typeof setTimeout> | null = null;
let processing = false;

const queue: QueueItem[] = [];
const recentlyQueued = new Set<string>();
const recentlySniped = new Set<string>();

export function startPumpLaunchSniper(
  onSnipe: PumpLaunchSnipeCallback,
  onLog?: LogCb,
): void {
  if (running) return;
  running = true;
  callback = onSnipe;
  if (onLog) log = onLog;
  adaptiveDelayMs = BASE_PROCESS_DELAY_MS;
  log(
    `Pump launch sniper online (liq>=${MIN_LIQUIDITY_USD}, vol1h>=${MIN_VOLUME_H1_USD}, ` +
    `buy/sell>=${MIN_BUY_SELL_RATIO.toFixed(2)})`,
  );
}

export function stopPumpLaunchSniper(): void {
  running = false;
  callback = null;
  processing = false;
  if (processTimer) clearTimeout(processTimer);
  processTimer = null;
  queue.length = 0;
  recentlyQueued.clear();
  recentlySniped.clear();
  log('Pump launch sniper stopped');
}

export function onPumpLaunchToken(token: PumpPortalToken): void {
  if (!running || !callback) return;
  if (!token.mint) return;
  if (recentlyQueued.has(token.mint) || recentlySniped.has(token.mint)) return;

  recentlyQueued.add(token.mint);
  setTimeout(() => recentlyQueued.delete(token.mint), 20 * 60_000);

  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
  }

  queue.push({ token, attempts: 0, nextEligibleAt: Date.now() });

  if (!processTimer) {
    scheduleProcess(100);
  }
}

function scheduleProcess(delayMs: number): void {
  if (!running) return;
  if (processTimer) clearTimeout(processTimer);
  processTimer = setTimeout(() => {
    processTimer = null;
    void processQueue();
  }, Math.max(100, delayMs));
}

async function processQueue(): Promise<void> {
  if (!running || processing || !callback) return;
  processing = true;

  try {
    const now = Date.now();
    const idx = queue.findIndex((item) => item.nextEligibleAt <= now);

    if (idx < 0) {
      if (queue.length > 0) {
        const nextAt = Math.min(...queue.map((item) => item.nextEligibleAt));
        scheduleProcess(Math.max(250, nextAt - now));
      }
      return;
    }

    const item = queue.splice(idx, 1)[0];
    await evaluateCandidate(item);
  } finally {
    processing = false;
  }

  if (running) {
    scheduleProcess(adaptiveDelayMs);
  }
}

function increaseBackoff(reason: string): void {
  const prev = adaptiveDelayMs;
  adaptiveDelayMs = Math.min(MAX_PROCESS_DELAY_MS, Math.round(adaptiveDelayMs * 1.5));
  if (adaptiveDelayMs !== prev) {
    log(`Adaptive backoff: ${prev}ms -> ${adaptiveDelayMs}ms (${reason})`);
  }
}

function relaxBackoff(): void {
  adaptiveDelayMs = Math.max(BASE_PROCESS_DELAY_MS, Math.round(adaptiveDelayMs * 0.9));
}

function requeue(item: QueueItem, reason: string, silent = false): void {
  if (item.attempts >= MAX_RETRY_ATTEMPTS) return;
  const nextAttempt = item.attempts + 1;
  queue.push({
    token: item.token,
    attempts: nextAttempt,
    nextEligibleAt: Date.now() + RETRY_BASE_DELAY_MS * nextAttempt,
  });
  if (!silent) {
    log(
      `Retrying ${item.token.symbol || item.token.mint.slice(0, 8)} ` +
      `(attempt ${nextAttempt}/${MAX_RETRY_ATTEMPTS}) - ${reason}`,
    );
  }
}

type DexPair = {
  chainId?: string;
  pairCreatedAt?: number;
  baseToken?: { symbol?: string; name?: string };
  liquidity?: { usd?: number };
  volume?: { h1?: number; h24?: number };
  txns?: { h1?: { buys?: number; sells?: number } };
};

function pickBestPair(pairs: DexPair[]): DexPair | null {
  const solana = pairs.filter((p) => p.chainId === 'solana' || !p.chainId);
  const source = solana.length > 0 ? solana : pairs;
  if (source.length === 0) return null;
  return source.sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0] ?? null;
}

async function evaluateCandidate(item: QueueItem): Promise<void> {
  const token = item.token;

  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${token.mint}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(7_000),
    });

    if (res.status === 429) {
      increaseBackoff('DexScreener 429');
      // Silently requeue without logging to prevent console spam
      requeue(item, 'DexScreener rate limit', true);
      return;
    }

    if (!res.ok) {
      if (res.status >= 500) {
        increaseBackoff(`DexScreener ${res.status}`);
        requeue(item, `DexScreener HTTP ${res.status}`, true);
      }
      return;
    }

    const data = await res.json() as { pairs?: DexPair[] };
    const pair = pickBestPair(data.pairs ?? []);

    if (!pair) {
      requeue(item, 'No pair yet', true);
      return;
    }

    const liquidityUsd = Number(pair.liquidity?.usd ?? 0);
    const volumeH1Usd = Number(pair.volume?.h1 ?? 0);
    const buys = Number(pair.txns?.h1?.buys ?? 0);
    const sells = Number(pair.txns?.h1?.sells ?? 0);
    const buySellRatio = sells > 0 ? buys / sells : buys > 0 ? 5 : 0;

    let ageMinutes = 0;
    if (pair.pairCreatedAt && pair.pairCreatedAt > 0) {
      ageMinutes = (Date.now() - Number(pair.pairCreatedAt)) / 60_000;
      if (ageMinutes > MAX_PAIR_AGE_MINUTES) {
        return;
      }
    }

    if (liquidityUsd < MIN_LIQUIDITY_USD) return;
    if (volumeH1Usd < MIN_VOLUME_H1_USD) return;
    if (buySellRatio < MIN_BUY_SELL_RATIO) return;

    if (recentlySniped.has(token.mint)) return;
    recentlySniped.add(token.mint);
    setTimeout(() => recentlySniped.delete(token.mint), 60 * 60_000);

    relaxBackoff();

    callback?.({
      mint: token.mint,
      symbol: token.symbol || pair.baseToken?.symbol || token.mint.slice(0, 8),
      name: token.name || pair.baseToken?.name || '',
      source: 'pumpportal_launch',
      liquidityUsd,
      volumeH1Usd,
      buySellRatio,
      ageMinutes,
    });

    log(
      `PUMP LAUNCH QUALIFIED: ${token.symbol || token.mint.slice(0, 8)} | ` +
      `liq=$${Math.round(liquidityUsd).toLocaleString()} | ` +
      `vol1h=$${Math.round(volumeH1Usd).toLocaleString()} | ` +
      `b/s=${buySellRatio.toFixed(2)}`,
    );
  } catch (err) {
    increaseBackoff('request failure');
    if (err instanceof Error && err.name === 'AbortError') {
      requeue(item, 'DexScreener timeout');
    }
  }
}