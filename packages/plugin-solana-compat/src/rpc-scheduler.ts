/**
 * Rate-limited RPC Scheduler for Constant-K Operator plan.
 *
 * Constant-K limits:
 *   Global:               50 req/sec
 *   sendTransaction:       5 req/sec
 *   simulateTransaction:   1 req/sec
 *   getMultipleAccounts:   5 req/sec
 *   simulateBundle (Jito):5 req/sec
 *   WebSocket subs:       10
 *
 * This scheduler enforces both global and per-method limits using
 * a sliding-window token bucket. Callers await schedule(category)
 * before making an RPC call — it resolves only when a slot is available.
 */

import { elizaLogger } from '@elizaos/core';

// ── Method categories mapped to per-second caps ──

export type RpcCategory =
  | 'sendTransaction'
  | 'simulateTransaction'
  | 'getMultipleAccounts'
  | 'simulateBundle'
  | 'read';      // all other read methods share the global cap

const METHOD_LIMITS: Record<RpcCategory, number> = {
  sendTransaction: 5,
  simulateTransaction: 1,
  getMultipleAccounts: 5,
  simulateBundle: 5,
  read: 50,  // reads only limited by global cap
};

const GLOBAL_LIMIT = 50;
const WINDOW_MS = 1_000;

// ── Sliding window tracker ──

class SlidingWindow {
  private timestamps: number[] = [];

  constructor(private readonly maxPerWindow: number) {}

  /** Returns true if a slot is available right now. */
  canAcquire(now: number): boolean {
    this.prune(now);
    return this.timestamps.length < this.maxPerWindow;
  }

  /** Record a usage. Call only after canAcquire() returns true. */
  acquire(now: number): void {
    this.timestamps.push(now);
  }

  /** Time in ms until the next slot opens. 0 if available now. */
  msUntilSlot(now: number): number {
    this.prune(now);
    if (this.timestamps.length < this.maxPerWindow) return 0;
    const oldest = this.timestamps[0]!;
    return Math.max(0, oldest + WINDOW_MS - now);
  }

  private prune(now: number): void {
    const cutoff = now - WINDOW_MS;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
  }
}

// ── Singleton scheduler ──

const globalWindow = new SlidingWindow(GLOBAL_LIMIT);
const methodWindows = new Map<RpcCategory, SlidingWindow>();

for (const [cat, limit] of Object.entries(METHOD_LIMITS)) {
  methodWindows.set(cat as RpcCategory, new SlidingWindow(limit));
}

let totalScheduled = 0;
let totalThrottled = 0;

/**
 * Await this before making an RPC call. Resolves when both global
 * and method-specific rate limits allow the request through.
 */
export async function schedule(category: RpcCategory = 'read'): Promise<void> {
  const methodWindow = methodWindows.get(category);
  if (!methodWindow) return; // unknown category, let it through

  let waited = false;

  // Spin until both windows have capacity
  for (let attempts = 0; attempts < 200; attempts++) {
    const now = Date.now();

    if (globalWindow.canAcquire(now) && methodWindow.canAcquire(now)) {
      globalWindow.acquire(now);
      methodWindow.acquire(now);
      totalScheduled++;
      if (waited) totalThrottled++;
      return;
    }

    // Wait for the longest of the two windows
    const globalWait = globalWindow.msUntilSlot(now);
    const methodWait = methodWindow.msUntilSlot(now);
    const waitMs = Math.max(globalWait, methodWait, 5); // min 5ms to avoid tight spin

    if (!waited) {
      waited = true;
    }

    await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  }

  // Safety fallback — should never hit this with 200 attempts (~200 sec worst case)
  elizaLogger.warn(`[rpc-scheduler] ${category}: gave up after 200 attempts, allowing through`);
  totalScheduled++;
  totalThrottled++;
}

/**
 * Get scheduler stats for health monitoring.
 */
export function getSchedulerStats(): { totalScheduled: number; totalThrottled: number } {
  return { totalScheduled, totalThrottled };
}

/**
 * Classify an RPC method name into a scheduler category.
 */
export function classifyMethod(method: string): RpcCategory {
  if (method === 'sendTransaction') return 'sendTransaction';
  if (method === 'simulateTransaction') return 'simulateTransaction';
  if (method === 'getMultipleAccounts') return 'getMultipleAccounts';
  if (method === 'simulateBundle') return 'simulateBundle';
  return 'read';
}
