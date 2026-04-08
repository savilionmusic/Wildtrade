import { getDb } from '@wildtrade/shared';

export interface AuditReport {
  totalTrades: number;
  winRate: number;
  avgPnlPct: number;
  bestMCapBucket: string | null;
  worstMCapBucket: string | null;
  catastrophicLoss: boolean;
  summary: string;
  timestamp: number;
}

type AuditCallback = (report: AuditReport) => void;

const AUDIT_INTERVAL_MS = 20 * 60_000; // every 20 minutes
const FIRST_RUN_DELAY_MS = 5 * 60_000; // first report after 5 min warmup

let auditInterval: ReturnType<typeof setInterval> | null = null;
let firstRunTimeout: ReturnType<typeof setTimeout> | null = null;
const callbacks: AuditCallback[] = [];

export function onAuditReport(cb: AuditCallback): void {
  callbacks.push(cb);
}

function getMCapBucket(mcap: number): string {
  if (mcap < 10_000) return '<10k';
  if (mcap < 50_000) return '10k-50k';
  if (mcap < 200_000) return '50k-200k';
  if (mcap < 1_000_000) return '200k-1M';
  return '>1M';
}

interface PositionRow {
  pnl_pct: number;
  entry_mcap: number | null;
  status: string;
  symbol: string;
}

export async function runAudit(): Promise<AuditReport | null> {
  try {
    const db = await getDb();
    const dayAgo = Date.now() - 86_400_000;

    const result = await db.query<PositionRow>(
      `SELECT pnl_pct, entry_mcap, status, symbol FROM positions
       WHERE status IN ('closed', 'stopped_out') AND closed_at >= $1
       ORDER BY closed_at DESC`,
      [dayAgo],
    );

    const trades = result.rows;
    if (trades.length === 0) {
      console.log('[auditor] No closed trades in last 24h — nothing to audit yet.');
      return null;
    }

    const wins = trades.filter(t => (t.pnl_pct ?? 0) > 0);
    const winRate = wins.length / trades.length;
    const avgPnl = trades.reduce((sum, t) => sum + (t.pnl_pct ?? 0), 0) / trades.length;

    // MCap bucket analysis
    const mcapBuckets = new Map<string, { wins: number; total: number; avgPnl: number }>();
    for (const t of trades) {
      const bucket = getMCapBucket(t.entry_mcap ?? 0);
      const b = mcapBuckets.get(bucket) ?? { wins: 0, total: 0, avgPnl: 0 };
      b.total++;
      if ((t.pnl_pct ?? 0) > 0) b.wins++;
      b.avgPnl = ((b.avgPnl * (b.total - 1)) + (t.pnl_pct ?? 0)) / b.total;
      mcapBuckets.set(bucket, b);
    }

    let bestMCapBucket: string | null = null;
    let worstMCapBucket: string | null = null;
    let bestAvg = -Infinity;
    let worstAvg = Infinity;
    for (const [bucket, stats] of mcapBuckets.entries()) {
      if (stats.total >= 2) {
        if (stats.avgPnl > bestAvg) { bestAvg = stats.avgPnl; bestMCapBucket = bucket; }
        if (stats.avgPnl < worstAvg) { worstAvg = stats.avgPnl; worstMCapBucket = bucket; }
      }
    }

    const stopOuts = trades.filter(t => t.status === 'stopped_out').length;
    const catastrophicLoss = avgPnl < -20 && winRate < 0.2 && trades.length >= 5;

    const pSign = avgPnl >= 0 ? '+' : '';
    const lines: string[] = [
      `═══ AUDITOR REPORT (last 24h) ═══`,
      `Trades: ${trades.length} | Wins: ${wins.length} | Win Rate: ${(winRate * 100).toFixed(0)}% | Avg PnL: ${pSign}${avgPnl.toFixed(1)}%`,
      `Stop-outs: ${stopOuts}/${trades.length} | Best MCap range: ${bestMCapBucket ?? 'N/A'} | Worst: ${worstMCapBucket ?? 'N/A'}`,
    ];

    if (catastrophicLoss) {
      lines.push(`⚠ CATASTROPHIC LOSS PATTERN — bot is suspending new entries until parameters are reviewed.`);
    } else if (winRate < 0.3 && trades.length >= 5) {
      lines.push(`⚠ Win rate below 30% — adaptive engine raising score floor automatically.`);
    } else if (winRate > 0.6) {
      lines.push(`✓ Performing well — adaptive engine holding current parameters.`);
    }

    const report: AuditReport = {
      totalTrades: trades.length,
      winRate,
      avgPnlPct: avgPnl,
      bestMCapBucket,
      worstMCapBucket,
      catastrophicLoss,
      summary: lines.join('\n'),
      timestamp: Date.now(),
    };

    console.log(lines.map(l => `[auditor] ${l}`).join('\n'));
    for (const cb of callbacks) cb(report);
    return report;
  } catch (err) {
    console.log(`[auditor] Performance audit error: ${String(err)}`);
    return null;
  }
}

export function startPerformanceAuditor(): void {
  if (auditInterval) return;
  console.log(`[auditor] Performance auditor starting — first report in 5 min, then every 20 min.`);

  firstRunTimeout = setTimeout(() => {
    runAudit().catch(console.error);
  }, FIRST_RUN_DELAY_MS);

  auditInterval = setInterval(() => {
    runAudit().catch(console.error);
  }, AUDIT_INTERVAL_MS);
}

export function stopPerformanceAuditor(): void {
  if (firstRunTimeout) { clearTimeout(firstRunTimeout); firstRunTimeout = null; }
  if (auditInterval) { clearInterval(auditInterval); auditInterval = null; }
}
