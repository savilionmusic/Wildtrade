import type { DCALeg } from '@wildtrade/shared';
import { DCA_ALLOCATION } from '@wildtrade/shared';

const DCA_DELAY_LEG1_MS = 60_000;   // 1 minute after initial entry
const DCA_DELAY_LEG2_MS = 180_000;  // 3 minutes after initial entry

export function calculateDCALegs(
  totalBudgetLamports: string,
  startTime: number,
): DCALeg[] {
  const total = BigInt(totalBudgetLamports);
  const delays = [0, DCA_DELAY_LEG1_MS, DCA_DELAY_LEG2_MS];

  return DCA_ALLOCATION.map((allocPercent, index) => {
    const inputAmount = (total * BigInt(allocPercent)) / 100n;
    return {
      legIndex: index as 0 | 1 | 2,
      allocPercent,
      scheduledAt: startTime + delays[index],
      inputAmountLamports: inputAmount.toString(),
      status: 'pending' as const,
    };
  });
}
