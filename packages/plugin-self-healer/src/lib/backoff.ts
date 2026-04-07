import type { BackoffConfig } from '@wildtrade/shared';

/**
 * Calculate exponential backoff delay for a given attempt number.
 * Uses the formula: min(initialDelay * multiplier^attempt + jitter, maxDelay)
 */
export function exponentialBackoff(config: BackoffConfig, attempt: number): number {
  const { initialDelayMs, maxDelayMs, multiplier, jitterMs } = config;

  const baseDelay = initialDelayMs * Math.pow(multiplier, attempt);
  const jitter = Math.random() * jitterMs;
  const delay = Math.min(baseDelay + jitter, maxDelayMs);

  return Math.floor(delay);
}

/**
 * Returns a promise that resolves after the specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
