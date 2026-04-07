import type { ExitTier } from '@wildtrade/shared';
import { EXIT_TIERS } from '@wildtrade/shared';

export function buildExitTiers(): ExitTier[] {
  return EXIT_TIERS.map((tier, index) => ({
    tierIndex: index as 0 | 1 | 2,
    targetMultiple: tier.multiple as 2 | 5 | 10,
    sellPercent: tier.sellPct as 50 | 25 | 25,
    status: 'watching' as const,
  }));
}
