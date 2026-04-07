/**
 * Autonomous Trading Engine — The brain that actually trades.
 *
 * 1-to-10 SOL Challenge Strategy:
 *   Phase 1 (< 2 SOL): Hunt 10k-50k MCap micro gems, small positions
 *   Phase 2 (2-5 SOL): Scale to 30k-200k MCap, medium positions
 *   Phase 3 (5-10 SOL): Graduate to 100k-1M MCap, larger positions
 *
 * Features:
 *   - Polls for new signals from the Finder / Convergence / Scanner
 *   - Progressive MCap targeting based on portfolio size
 *   - DCA entries (paper or live) with 3-leg averaging
 *   - Price monitoring with tiered exits and trailing stop
 *   - Deep trade memory — learns what MCap ranges, scores, and hold times produce wins
 *   - Adaptive scoring thresholds based on historical win rate
 */

import { getDb } from '@wildtrade/shared';
import type { AlphaSignal, InterAgentMessage } from '@wildtrade/shared';
import { v4 as uuidv4 } from 'uuid';
import { executeFullSwap } from './jupiter.service.js';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

// ── Config ──
const POLL_INTERVAL_MS = 15_000;
const PRICE_CHECK_INTERVAL_MS = 30_000;
const DCA_LEG2_DELAY_MS = 60_000;
const DCA_LEG3_DELAY_MS = 180_000;
const DCA_LEGS = [0.2, 0.3, 0.5];

const EXIT_TIERS = [
  { multiplier: 2.0, sellPct: 0.50 },
  { multiplier: 5.0, sellPct: 0.25 },
  { multiplier: 10.0, sellPct: 0.25 },
];

const STOP_LOSS_MULTIPLIER = 0.5;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Trade Limits ──
let maxTradesPerDay = 20;
const MAX_TRADES_PER_HOUR = 5;
const MAX_DAILY_LOSS_PCT = 30;  // Stop trading if down 30% of budget in a day
// Track unique coins traded (mint + timestamp), not individual DCA legs
const coinEntries: Array<{ mint: string; timestamp: number }> = [];
let userMaxPositions: number | null = null; // User override from portfolio UI

// ── Progressive Strategy Phases ──
interface TradingPhase {
  name: string;
  minPortfolio: number;
  maxPortfolio: number;
  targetMCapMin: number;     // Minimum MCap to consider
  targetMCapMax: number;     // Maximum MCap to consider
  positionSizeMin: number;   // Min SOL per position
  positionSizeMax: number;   // Max SOL per position
  maxPositions: number;      // Max concurrent positions
  minScore: number;          // Minimum score to trade
}

const PHASES: TradingPhase[] = [
  {
    name: 'Phase 1: Micro Gems',
    minPortfolio: 0, maxPortfolio: 2,
    targetMCapMin: 5_000, targetMCapMax: 100_000,
    positionSizeMin: 0.03, positionSizeMax: 0.15,
    maxPositions: 5, minScore: 55,
  },
  {
    name: 'Phase 2: Small Caps',
    minPortfolio: 2, maxPortfolio: 5,
    targetMCapMin: 20_000, targetMCapMax: 500_000,
    positionSizeMin: 0.08, positionSizeMax: 0.3,
    maxPositions: 4, minScore: 60,
  },
  {
    name: 'Phase 3: Scaling Up',
    minPortfolio: 5, maxPortfolio: 10,
    targetMCapMin: 50_000, targetMCapMax: 2_000_000,
    positionSizeMin: 0.15, positionSizeMax: 0.5,
    maxPositions: 3, minScore: 65,
  },
  {
    name: 'Phase 4: Mission Complete',
    minPortfolio: 10, maxPortfolio: Infinity,
    targetMCapMin: 100_000, targetMCapMax: 10_000_000,
    positionSizeMin: 0.3, positionSizeMax: 1.0,
    maxPositions: 3, minScore: 70,
  },
];

// ── Types ──

interface Position {
  id: string;
  signalId: string;
  mintAddress: string;
  symbol: string;
  name: string;
  status: 'open' | 'partial_exit' | 'closed' | 'stopped_out';
  budgetSol: number;
  entryPrice: number;
  currentPrice: number;
  tokenBalance: number;
  solDeployed: number;
  solReturned: number;
  dcaLegsExecuted: number;
  exitTiersHit: number;
  openedAt: number;
  closedAt: number | null;
  pnlSol: number;
  pnlPct: number;
  paper: boolean;
  marketCap: number;        // MCap at time of entry
  entryScore: number;       // Score at time of entry
}

// ── Deep Trade Memory ──
interface TradeMemoryEntry {
  mint: string;
  symbol: string;
  entryScore: number;
  entryMCap: number;
  pnlPct: number;
  holdTimeMs: number;
  exitReason: string;
  timestamp: number;
  phase: string;
  // New learning fields
  hour: number;          // Hour of day (0-23) when trade was opened
  dcaLegs: number;       // How many DCA legs were executed
  positionSizeSol: number; // How much SOL was deployed
}

// ── Adaptive Learning Engine ──
interface Lesson {
  dimension: string;      // What was analyzed (mcap, score, hold_time, hour, dca, etc)
  insight: string;        // Human-readable lesson
  action: string;         // What parameter to adjust
  value: number;          // The adjustment value
  confidence: number;     // 0-1 based on sample size
  updatedAt: number;
}

interface DimensionStats {
  wins: number;
  losses: number;
  avgPnl: number;
  totalTrades: number;
  bestPnl: number;
  worstPnl: number;
}

// Learning state
const lessons: Lesson[] = [];
const scorePerformance = new Map<string, DimensionStats>();    // score ranges: "50-60", "60-70", etc
const holdTimePerformance = new Map<string, DimensionStats>(); // "<15m", "15-30m", "30-60m", "1-2h", ">2h"
const hourPerformance = new Map<string, DimensionStats>();     // "0"-"23"
const dcaPerformance = new Map<string, DimensionStats>();      // "1leg", "2legs", "3legs"
const exitReasonStats = new Map<string, DimensionStats>();     // stop_loss, take-profit, time_exit, etc

// Dynamic strategy adjustments (learned overrides)
let learnedMinScore = 0;          // Additive adjustment to min score
let learnedPositionSizeMult = 1;  // Multiplier on position size (0.5-1.5)
let learnedMaxHoldMs = 0;         // 0 = use defaults, otherwise learned optimal
let preferredMCapBuckets: string[] = [];  // Buckets to prefer
let avoidMCapBuckets: string[] = [];      // Buckets to avoid
let learnedDcaAggression = 1;     // Multiplier on DCA amount (0.5-2.0)

// ── State ──
let running = false;
let signalPollTimer: ReturnType<typeof setInterval> | null = null;
let priceCheckTimer: ReturnType<typeof setInterval> | null = null;
let dcaTimer: ReturnType<typeof setInterval> | null = null;
let stateTimer: ReturnType<typeof setInterval> | null = null;
let pendingDcaLegs: Array<{ positionId: string; leg: number; solAmount: number; mint: string; executeAt: number }> = [];

const positions = new Map<string, Position>();
let totalBudgetSol = parseFloat(process.env.TOTAL_BUDGET_SOL || '1.0');
let deployedSol = 0;
let realizedPnlSol = 0;
let tradeCount = 0;
let winCount = 0;

// Deep trade memory
const tradeHistory: TradeMemoryEntry[] = [];
// Track MCap performance: which MCap ranges produce better returns
const mcapPerformance = new Map<string, { wins: number; losses: number; avgPnl: number }>();

type TradingLogCb = (msg: string) => void;
let log: TradingLogCb = (msg) => console.log(`[trader] ${msg}`);
let alertCb: ((type: string, msg: string) => void) | null = null;

// ── Wallet Keypair (for live trading) ──
let walletKeypair: Keypair | null = null;

function getWalletKeypair(): Keypair | null {
  if (walletKeypair) return walletKeypair;
  const privKey = process.env.WALLET_PRIVATE_KEY;
  if (!privKey) return null;
  try {
    const decoded = bs58.decode(privKey);
    walletKeypair = Keypair.fromSecretKey(decoded);
    log(`Wallet loaded: ${walletKeypair.publicKey.toBase58().slice(0, 8)}...`);
    return walletKeypair;
  } catch (err) {
    log(`Failed to load wallet keypair: ${String(err)}`);
    return null;
  }
}

// ── Portfolio Helpers ──

function getPortfolioValue(): number {
  return totalBudgetSol - deployedSol + realizedPnlSol + deployedSol; // budget + unrealized
}

function getCurrentPhase(): TradingPhase {
  const portfolio = getPortfolioValue();
  return PHASES.find(p => portfolio >= p.minPortfolio && portfolio < p.maxPortfolio) ?? PHASES[0];
}

function getMCapBucket(mcap: number): string {
  if (mcap < 10_000) return '<10k';
  if (mcap < 50_000) return '10k-50k';
  if (mcap < 200_000) return '50k-200k';
  if (mcap < 1_000_000) return '200k-1M';
  return '>1M';
}

function getAdaptiveMinScore(): number {
  const phase = getCurrentPhase();
  let minScore = phase.minScore;

  // Apply learned adjustment
  minScore += learnedMinScore;

  // Adapt based on win rate after 3+ trades
  if (tradeCount >= 3) {
    const wr = winCount / tradeCount;
    if (wr < 0.25) {
      minScore += 15;
    } else if (wr < 0.4) {
      minScore += 8;
    } else if (wr > 0.6) {
      minScore -= 5;
    }
  }

  // Adapt based on recent performance (last 10 trades) — more reactive
  const recent = tradeHistory.slice(-10);
  if (recent.length >= 5) {
    const recentWR = recent.filter(t => t.pnlPct > 0).length / recent.length;
    if (recentWR < 0.2) {
      minScore += 10; // Recent cold streak — be pickier
    } else if (recentWR > 0.7) {
      minScore -= 3;  // Recent hot streak — slightly more aggressive
    }
  }

  return Math.max(45, Math.min(85, minScore));
}

// ── Learning Analysis Helpers ──

function getScoreBucket(score: number): string {
  if (score < 55) return '<55';
  if (score < 65) return '55-65';
  if (score < 75) return '65-75';
  return '75+';
}

function getHoldTimeBucket(ms: number): string {
  const mins = ms / 60_000;
  if (mins < 15) return '<15m';
  if (mins < 30) return '15-30m';
  if (mins < 60) return '30-60m';
  if (mins < 120) return '1-2h';
  return '>2h';
}

function updateDimensionStats(
  map: Map<string, DimensionStats>,
  bucket: string,
  pnlPct: number,
): void {
  const existing = map.get(bucket) || { wins: 0, losses: 0, avgPnl: 0, totalTrades: 0, bestPnl: -Infinity, worstPnl: Infinity };
  if (pnlPct > 0) existing.wins++;
  else existing.losses++;
  existing.totalTrades++;
  existing.avgPnl = ((existing.avgPnl * (existing.totalTrades - 1)) + pnlPct) / existing.totalTrades;
  existing.bestPnl = Math.max(existing.bestPnl, pnlPct);
  existing.worstPnl = Math.min(existing.worstPnl, pnlPct);
  map.set(bucket, existing);
}

/**
 * Analyze a closed trade across every dimension and generate lessons.
 * Called after every trade close — the core of the learning engine.
 */
function analyzeTradeAndLearn(entry: TradeMemoryEntry): void {
  // Update all dimension trackers
  const mcapBucket = getMCapBucket(entry.entryMCap);
  const scoreBucket = getScoreBucket(entry.entryScore);
  const holdBucket = getHoldTimeBucket(entry.holdTimeMs);
  const hourBucket = String(entry.hour);
  const dcaBucket = `${entry.dcaLegs}legs`;

  updateDimensionStats(mcapPerformance, mcapBucket, entry.pnlPct);
  updateDimensionStats(scorePerformance, scoreBucket, entry.pnlPct);
  updateDimensionStats(holdTimePerformance, holdBucket, entry.pnlPct);
  updateDimensionStats(hourPerformance, hourBucket, entry.pnlPct);
  updateDimensionStats(dcaPerformance, dcaBucket, entry.pnlPct);

  // Extract exit category
  const exitCat = entry.exitReason.includes('stop_loss') ? 'stop_loss'
    : entry.exitReason.includes('take-profit') ? 'take_profit'
    : entry.exitReason.includes('trailing') ? 'trailing_stop'
    : entry.exitReason.includes('time_exit') ? 'time_exit'
    : entry.exitReason.includes('momentum') ? 'momentum_exit'
    : 'other';
  updateDimensionStats(exitReasonStats, exitCat, entry.pnlPct);

  // Generate lessons (only after enough data)
  if (tradeHistory.length >= 5) {
    generateLessons();
  }

  // Log the learning event
  const pSign = entry.pnlPct >= 0 ? '+' : '';
  log(`LEARNING: ${entry.symbol} ${pSign}${entry.pnlPct.toFixed(1)}% | MCap:${mcapBucket} Score:${scoreBucket} Hold:${holdBucket} Hour:${hourBucket} DCA:${dcaBucket} Exit:${exitCat}`);
}

/**
 * Analyze all tracked dimensions and produce actionable lessons.
 * Adjusts live trading parameters based on patterns.
 */
function generateLessons(): void {
  lessons.length = 0;
  const now = Date.now();

  // ── 1. MCap Bucket Analysis ──
  const bestMCapBucket = findBestBucket(mcapPerformance);
  const worstMCapBucket = findWorstBucket(mcapPerformance);

  preferredMCapBuckets = [];
  avoidMCapBuckets = [];

  if (bestMCapBucket) {
    const stats = mcapPerformance.get(bestMCapBucket)!;
    if (stats.totalTrades >= 3 && stats.avgPnl > 5) {
      preferredMCapBuckets.push(bestMCapBucket);
      lessons.push({
        dimension: 'mcap', insight: `${bestMCapBucket} MCap is our sweet spot (${stats.avgPnl.toFixed(1)}% avg, ${wr(stats)} WR)`,
        action: 'prefer_mcap', value: 0, confidence: Math.min(1, stats.totalTrades / 10), updatedAt: now,
      });
    }
  }
  if (worstMCapBucket) {
    const stats = mcapPerformance.get(worstMCapBucket)!;
    if (stats.totalTrades >= 3 && stats.avgPnl < -10) {
      avoidMCapBuckets.push(worstMCapBucket);
      lessons.push({
        dimension: 'mcap', insight: `Avoid ${worstMCapBucket} MCap (${stats.avgPnl.toFixed(1)}% avg, ${wr(stats)} WR) — bleeding money`,
        action: 'avoid_mcap', value: 0, confidence: Math.min(1, stats.totalTrades / 10), updatedAt: now,
      });
    }
  }

  // ── 2. Score Analysis ──
  const bestScoreBucket = findBestBucket(scorePerformance);
  const worstScoreBucket = findWorstBucket(scorePerformance);

  if (bestScoreBucket && worstScoreBucket && bestScoreBucket !== worstScoreBucket) {
    const bestStats = scorePerformance.get(bestScoreBucket)!;
    const worstStats = scorePerformance.get(worstScoreBucket)!;

    if (bestStats.totalTrades >= 3 && worstStats.totalTrades >= 3) {
      // If low-score tokens are losing money, raise the bar
      if (worstScoreBucket === '<55' || worstScoreBucket === '55-65') {
        if (worstStats.avgPnl < -5) {
          learnedMinScore = Math.min(15, Math.max(learnedMinScore, Math.abs(worstStats.avgPnl) * 0.5));
          lessons.push({
            dimension: 'score', insight: `Low-score tokens (${worstScoreBucket}) lose ${Math.abs(worstStats.avgPnl).toFixed(1)}% avg — raising bar by ${learnedMinScore.toFixed(0)} pts`,
            action: 'raise_min_score', value: learnedMinScore, confidence: Math.min(1, worstStats.totalTrades / 8), updatedAt: now,
          });
        }
      }
      // If high-score tokens are crushing it, note that
      if (bestStats.avgPnl > 10) {
        lessons.push({
          dimension: 'score', insight: `High-score tokens (${bestScoreBucket}) avg +${bestStats.avgPnl.toFixed(1)}% — these are our bread & butter`,
          action: 'note', value: 0, confidence: Math.min(1, bestStats.totalTrades / 8), updatedAt: now,
        });
      }
    }
  }

  // ── 3. Hold Time Analysis ──
  const bestHold = findBestBucket(holdTimePerformance);
  const worstHold = findWorstBucket(holdTimePerformance);

  if (bestHold) {
    const stats = holdTimePerformance.get(bestHold)!;
    if (stats.totalTrades >= 3) {
      // Convert bucket name to max hold time
      const holdMs = bestHold === '<15m' ? 15 * 60_000 : bestHold === '15-30m' ? 30 * 60_000
        : bestHold === '30-60m' ? 60 * 60_000 : bestHold === '1-2h' ? 120 * 60_000 : 0;
      if (holdMs > 0) learnedMaxHoldMs = holdMs;
      lessons.push({
        dimension: 'hold_time', insight: `Best hold time: ${bestHold} (${stats.avgPnl.toFixed(1)}% avg) — quick flips ${bestHold.includes('m') ? 'work best' : 'vs longer holds'}`,
        action: 'optimal_hold', value: holdMs, confidence: Math.min(1, stats.totalTrades / 8), updatedAt: now,
      });
    }
  }
  if (worstHold) {
    const stats = holdTimePerformance.get(worstHold)!;
    if (stats.totalTrades >= 3 && stats.avgPnl < -5) {
      lessons.push({
        dimension: 'hold_time', insight: `Holding ${worstHold} loses ${Math.abs(stats.avgPnl).toFixed(1)}% avg — exit faster`,
        action: 'avoid_hold', value: 0, confidence: Math.min(1, stats.totalTrades / 8), updatedAt: now,
      });
    }
  }

  // ── 4. DCA Analysis ──
  const bestDca = findBestBucket(dcaPerformance);
  if (bestDca) {
    const stats = dcaPerformance.get(bestDca)!;
    const worstDca = findWorstBucket(dcaPerformance);
    const worstStats = worstDca ? dcaPerformance.get(worstDca) : null;

    if (stats.totalTrades >= 3) {
      const legs = parseInt(bestDca);
      if (legs <= 1 && stats.avgPnl > (worstStats?.avgPnl ?? 0) + 5) {
        learnedDcaAggression = Math.max(0.5, learnedDcaAggression - 0.1);
        lessons.push({
          dimension: 'dca', insight: `Single-leg entries outperform DCA (${stats.avgPnl.toFixed(1)}% vs ${worstStats?.avgPnl.toFixed(1)}%) — reducing DCA aggression`,
          action: 'reduce_dca', value: learnedDcaAggression, confidence: Math.min(1, stats.totalTrades / 8), updatedAt: now,
        });
      } else if (legs >= 3) {
        learnedDcaAggression = Math.min(2.0, learnedDcaAggression + 0.1);
        lessons.push({
          dimension: 'dca', insight: `Full DCA (3 legs) has +${stats.avgPnl.toFixed(1)}% avg — DCA is working, staying aggressive`,
          action: 'increase_dca', value: learnedDcaAggression, confidence: Math.min(1, stats.totalTrades / 8), updatedAt: now,
        });
      }
    }
  }

  // ── 5. Position Size Analysis ──
  if (tradeHistory.length >= 8) {
    const sorted = [...tradeHistory].sort((a, b) => a.positionSizeSol - b.positionSizeSol);
    const smallHalf = sorted.slice(0, Math.floor(sorted.length / 2));
    const bigHalf = sorted.slice(Math.floor(sorted.length / 2));

    const smallAvgPnl = smallHalf.reduce((s, t) => s + t.pnlPct, 0) / smallHalf.length;
    const bigAvgPnl = bigHalf.reduce((s, t) => s + t.pnlPct, 0) / bigHalf.length;

    if (smallAvgPnl > bigAvgPnl + 5) {
      learnedPositionSizeMult = Math.max(0.5, learnedPositionSizeMult - 0.05);
      lessons.push({
        dimension: 'size', insight: `Smaller positions avg +${smallAvgPnl.toFixed(1)}% vs +${bigAvgPnl.toFixed(1)}% for larger — scaling down`,
        action: 'reduce_size', value: learnedPositionSizeMult, confidence: 0.5, updatedAt: now,
      });
    } else if (bigAvgPnl > smallAvgPnl + 10) {
      learnedPositionSizeMult = Math.min(1.5, learnedPositionSizeMult + 0.05);
      lessons.push({
        dimension: 'size', insight: `Larger positions avg +${bigAvgPnl.toFixed(1)}% vs +${smallAvgPnl.toFixed(1)}% for smaller — scaling up`,
        action: 'increase_size', value: learnedPositionSizeMult, confidence: 0.5, updatedAt: now,
      });
    }
  }

  // ── 6. Exit Reason Analysis ──
  const stopLossStats = exitReasonStats.get('stop_loss');
  if (stopLossStats && stopLossStats.totalTrades >= 3) {
    const stopLossRate = stopLossStats.totalTrades / tradeCount;
    if (stopLossRate > 0.4) {
      lessons.push({
        dimension: 'exits', insight: `${(stopLossRate * 100).toFixed(0)}% of trades hit stop loss — entries are too aggressive or stop too tight`,
        action: 'widen_stop_or_raise_score', value: stopLossRate, confidence: 0.7, updatedAt: now,
      });
      learnedMinScore = Math.min(20, learnedMinScore + 3);
    }
  }

  // Log lessons
  if (lessons.length > 0) {
    log(`=== LEARNING ENGINE: ${lessons.length} lessons generated ===`);
    for (const l of lessons) {
      log(`  [${l.dimension}] ${l.insight} (confidence: ${(l.confidence * 100).toFixed(0)}%)`);
    }
    log(`  Adjustments: minScore${learnedMinScore >= 0 ? '+' : ''}${learnedMinScore.toFixed(0)} | sizeMult:${learnedPositionSizeMult.toFixed(2)} | dcaAggression:${learnedDcaAggression.toFixed(2)}`);
    log(`  Prefer: [${preferredMCapBuckets.join(',')}] | Avoid: [${avoidMCapBuckets.join(',')}]`);
  }
}

function findBestBucket(map: Map<string, DimensionStats>): string | null {
  let best: string | null = null;
  let bestPnl = -Infinity;
  for (const [k, v] of map.entries()) {
    if (v.totalTrades >= 2 && v.avgPnl > bestPnl) {
      bestPnl = v.avgPnl;
      best = k;
    }
  }
  return best;
}

function findWorstBucket(map: Map<string, DimensionStats>): string | null {
  let worst: string | null = null;
  let worstPnl = Infinity;
  for (const [k, v] of map.entries()) {
    if (v.totalTrades >= 2 && v.avgPnl < worstPnl) {
      worstPnl = v.avgPnl;
      worst = k;
    }
  }
  return worst;
}

function wr(stats: DimensionStats): string {
  return `${((stats.wins / Math.max(1, stats.totalTrades)) * 100).toFixed(0)}%`;
}

export function getLessons(): Lesson[] {
  return lessons;
}

function getTradesToday(): number {
  const dayAgo = Date.now() - 86_400_000;
  // Count unique mints entered today
  const todayEntries = coinEntries.filter(e => e.timestamp > dayAgo);
  const uniqueMints = new Set(todayEntries.map(e => e.mint));
  return uniqueMints.size;
}

function getTradesThisHour(): number {
  const hourAgo = Date.now() - 3_600_000;
  const hourEntries = coinEntries.filter(e => e.timestamp > hourAgo);
  const uniqueMints = new Set(hourEntries.map(e => e.mint));
  return uniqueMints.size;
}

function recordCoinEntry(mint: string): void {
  coinEntries.push({ mint, timestamp: Date.now() });
  // Clean up old entries
  const weekAgo = Date.now() - 7 * 86_400_000;
  while (coinEntries.length > 0 && coinEntries[0].timestamp < weekAgo) coinEntries.shift();
}

function canTrade(): { allowed: boolean; reason?: string } {
  if (getTradesToday() >= maxTradesPerDay) {
    return { allowed: false, reason: `Daily trade limit reached (${maxTradesPerDay})` };
  }
  if (getTradesThisHour() >= MAX_TRADES_PER_HOUR) {
    return { allowed: false, reason: `Hourly trade limit reached (${MAX_TRADES_PER_HOUR})` };
  }
  // Check daily loss limit
  const dailyLossLimit = totalBudgetSol * (MAX_DAILY_LOSS_PCT / 100);
  if (realizedPnlSol < -dailyLossLimit) {
    return { allowed: false, reason: `Daily loss limit hit (${MAX_DAILY_LOSS_PCT}% = ${dailyLossLimit.toFixed(4)} SOL)` };
  }
  return { allowed: true };
}

// ── Public API ──

export async function startAutonomousTrader(opts: {
  onLog?: TradingLogCb;
  onAlert?: (type: string, msg: string) => void;
}): Promise<void> {
  if (running) return;
  running = true;
  if (opts.onLog) log = opts.onLog;
  if (opts.onAlert) alertCb = opts.onAlert;

  totalBudgetSol = parseFloat(process.env.TOTAL_BUDGET_SOL || '1.0');

  // Restore saved state from DB
  await restoreState();

  const paperMode = process.env.PAPER_TRADING !== 'false';
  const phase = getCurrentPhase();
  const openCount = Array.from(positions.values()).filter(p => p.status === 'open' || p.status === 'partial_exit').length;
  log(`Autonomous trader ONLINE | Mode: ${paperMode ? 'PAPER' : 'LIVE'} | Budget: ${totalBudgetSol} SOL | ${phase.name}`);
  log(`Restored: ${openCount} open positions, ${tradeHistory.length} history, ${realizedPnlSol.toFixed(4)} realized PnL`);
  log(`Target MCap: $${phase.targetMCapMin.toLocaleString()} - $${phase.targetMCapMax.toLocaleString()} | Position size: ${phase.positionSizeMin}-${phase.positionSizeMax} SOL`);

  signalPollTimer = setInterval(pollForSignals, POLL_INTERVAL_MS);
  priceCheckTimer = setInterval(checkPricesAndExits, PRICE_CHECK_INTERVAL_MS);
  dcaTimer = setInterval(processPendingDcaLegs, 10_000);
  stateTimer = setInterval(saveState, 30_000); // Persist state every 30s

  log('Signal polling active (every 15s) | Price monitoring active (every 30s) | State save every 30s');
}

export async function stopAutonomousTrader(): Promise<void> {
  running = false;
  await saveState(); // Save before stopping
  if (signalPollTimer) clearInterval(signalPollTimer);
  if (priceCheckTimer) clearInterval(priceCheckTimer);
  if (dcaTimer) clearInterval(dcaTimer);
  if (stateTimer) clearInterval(stateTimer);
  signalPollTimer = null;
  priceCheckTimer = null;
  dcaTimer = null;
  stateTimer = null;
  log('Autonomous trader stopped (state saved)');
}

export async function manualBuy(mintAddress: string, symbol: string, solAmount: number): Promise<string> {
  if (!running) return 'Trader is not running — start the bot first.';

  const available = totalBudgetSol - deployedSol + realizedPnlSol;
  const phase = getCurrentPhase();
  const buyAmount = Math.min(solAmount, phase.positionSizeMax, available * 0.5);

  if (buyAmount < 0.01) return `Not enough budget. Available: ${available.toFixed(4)} SOL`;

  const existing = Array.from(positions.values()).find(
    p => p.mintAddress === mintAddress && p.status !== 'closed' && p.status !== 'stopped_out'
  );
  if (existing) return `Already in ${existing.symbol} — ${existing.solDeployed.toFixed(4)} SOL deployed`;

  log(`MANUAL BUY: ${symbol || mintAddress.slice(0, 8)} — ${buyAmount.toFixed(4)} SOL (from chat command)`);
  recordCoinEntry(mintAddress);
  await openPosition(`manual-${Date.now()}`, mintAddress, symbol || mintAddress.slice(0, 8), '', buyAmount, 70, 0);

  const pos = Array.from(positions.values()).find(p => p.mintAddress === mintAddress && p.status !== 'closed');
  if (pos) {
    return `Bought ${symbol || mintAddress.slice(0, 8)} — ${buyAmount.toFixed(4)} SOL DCA entry at $${pos.entryPrice.toFixed(8)}. https://dexscreener.com/solana/${mintAddress}`;
  }
  return `Buy order sent for ${symbol || mintAddress.slice(0, 8)} (${buyAmount.toFixed(4)} SOL)`;
}

export async function manualSell(mintAddress: string, sellPct: number = 1.0): Promise<string> {
  const position = Array.from(positions.values()).find(
    p => p.mintAddress === mintAddress && (p.status === 'open' || p.status === 'partial_exit')
  );
  if (!position) return `No open position found for ${mintAddress.slice(0, 8)}`;

  log(`MANUAL SELL: ${position.symbol} — ${(sellPct * 100).toFixed(0)}% (from chat command)`);
  await executeSell(position, sellPct, 'manual_sell');

  const pnlSign = position.pnlPct >= 0 ? '+' : '';
  return `Sold ${(sellPct * 100).toFixed(0)}% of ${position.symbol} — PnL: ${pnlSign}${position.pnlPct.toFixed(1)}% (${pnlSign}${position.pnlSol.toFixed(4)} SOL)`;
}

export function getTraderStats(): {
  running: boolean;
  positions: number;
  deployed: number;
  realized: number;
  unrealized: number;
  totalPnl: number;
  totalPnlPct: number;
  portfolioValue: number;
  budget: number;
  available: number;
  winRate: number;
  trades: number;
  phase: string;
  targetMCap: string;
  tradesToday: number;
  maxTradesToday: number;
} {
  const phase = getCurrentPhase();

  // Compute live unrealized PnL across all open positions
  let unrealizedPnlSol = 0;
  for (const p of positions.values()) {
    if (p.status === 'open' || p.status === 'partial_exit') {
      if (p.currentPrice > 0 && p.entryPrice > 0 && p.solDeployed > 0) {
        const currentValue = p.tokenBalance * p.currentPrice / (cachedSolPrice || 150);
        unrealizedPnlSol += currentValue - p.solDeployed + p.solReturned;
      }
    }
  }

  const totalPnl = realizedPnlSol + unrealizedPnlSol;
  const portfolioValue = totalBudgetSol + totalPnl;
  const totalPnlPct = totalBudgetSol > 0 ? (totalPnl / totalBudgetSol) * 100 : 0;

  return {
    running,
    positions: positions.size,
    deployed: Math.round(deployedSol * 10000) / 10000,
    realized: Math.round(realizedPnlSol * 10000) / 10000,
    unrealized: Math.round(unrealizedPnlSol * 10000) / 10000,
    totalPnl: Math.round(totalPnl * 10000) / 10000,
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    portfolioValue: Math.round(portfolioValue * 10000) / 10000,
    budget: totalBudgetSol,
    available: Math.round((totalBudgetSol - deployedSol + realizedPnlSol) * 10000) / 10000,
    winRate: tradeCount > 0 ? Math.round((winCount / tradeCount) * 100) : 0,
    trades: tradeCount,
    phase: phase.name,
    targetMCap: `$${(phase.targetMCapMin / 1000).toFixed(0)}k-$${(phase.targetMCapMax / 1000).toFixed(0)}k`,
    tradesToday: getTradesToday(),
    maxTradesToday: maxTradesPerDay,
    maxPositions: userMaxPositions ?? phase.maxPositions,
  };
}

export function getOpenPositions(): Position[] {
  // Return positions with live-computed PnL
  const open = Array.from(positions.values()).filter(p => p.status === 'open' || p.status === 'partial_exit');
  const solPrice = cachedSolPrice || 150;

  for (const p of open) {
    if (p.currentPrice > 0 && p.entryPrice > 0 && p.solDeployed > 0) {
      const currentValueSol = p.tokenBalance * p.currentPrice / solPrice;
      p.pnlSol = currentValueSol - p.solDeployed + p.solReturned;
      p.pnlPct = ((currentValueSol + p.solReturned) / p.solDeployed - 1) * 100;
    }
  }

  return open;
}

export function getTradeHistory(): TradeMemoryEntry[] {
  return tradeHistory;
}

export function setMaxPositions(n: number): void {
  userMaxPositions = Math.max(1, Math.min(5, n));
  log(`Max positions set to ${userMaxPositions}`);
}

export function setMaxTradesPerDay(n: number): void {
  maxTradesPerDay = Math.max(1, Math.min(100, n));
  log(`Max trades per day set to ${maxTradesPerDay}`);
}

// ── Signal Polling ──

async function pollForSignals(): Promise<void> {
  if (!running) return;

  // Check trade limits before looking for signals
  const limitCheck = canTrade();
  if (!limitCheck.allowed) {
    log(`Trade limit: ${limitCheck.reason}`);
    return;
  }

  try {
    const db = await getDb();
    const phase = getCurrentPhase();
    const minScore = getAdaptiveMinScore();
    const openCount = Array.from(positions.values()).filter(p => p.status === 'open' || p.status === 'partial_exit').length;

    const maxPos = userMaxPositions ?? phase.maxPositions;
    if (openCount >= maxPos) return; // Max positions limit

    // Get qualifying signals — filter by MCap range for current phase
    const result = await db.query(
      `SELECT * FROM signals
       WHERE expired = 0
       AND rugcheck_passed = 1
       AND (score_json::jsonb->>'total')::integer >= ${minScore}
       AND market_cap_usd >= $1
       AND market_cap_usd <= $2
       AND discovered_at > $3
       ORDER BY (score_json::jsonb->>'total')::integer DESC
       LIMIT 3`,
      [phase.targetMCapMin, phase.targetMCapMax, Date.now() - 1_800_000],
    );

    const signals = (result?.rows ?? []) as Array<Record<string, unknown>>;

    for (const row of signals) {
      const mintAddress = String(row.mint ?? '');
      if (!mintAddress) continue;

      // Skip if we already have a position on this token
      if (Array.from(positions.values()).some(p => p.mintAddress === mintAddress && p.status !== 'closed' && p.status !== 'stopped_out')) {
        continue;
      }

      const available = totalBudgetSol - deployedSol + realizedPnlSol;
      const baseSize = Math.min(phase.positionSizeMax, Math.max(phase.positionSizeMin, available * 0.25));
      const positionSize = Math.max(phase.positionSizeMin, baseSize * learnedPositionSizeMult); // Apply learned size adjustment

      if (positionSize < phase.positionSizeMin || available < phase.positionSizeMin) {
        log(`Budget tight — available: ${available.toFixed(4)} SOL, need ${phase.positionSizeMin} SOL`);
        continue;
      }

      const score = JSON.parse(String(row.score_json ?? '{}'));
      const symbol = String(row.symbol ?? mintAddress.slice(0, 8));
      const mcap = Number(row.market_cap_usd ?? 0);

      // Learning: skip MCap buckets we've learned to avoid
      const mcapBucket = getMCapBucket(mcap);
      if (avoidMCapBuckets.includes(mcapBucket)) {
        log(`LEARNING SKIP: ${symbol} in avoided MCap bucket ${mcapBucket}`);
        continue;
      }

      log(`ENTERING POSITION: ${symbol} | Score: ${score.total} | MCap: $${mcap.toLocaleString()} | Size: ${positionSize.toFixed(4)} SOL (x${learnedPositionSizeMult.toFixed(2)}) | ${phase.name}`);
      alert('dca_entry', `Entering ${symbol} — Score: ${score.total}/100, MCap: $${mcap.toLocaleString()}, DCA ${positionSize.toFixed(4)} SOL [${phase.name}]`);

      recordCoinEntry(mintAddress);
      await openPosition(
        String(row.id ?? uuidv4()),
        mintAddress, symbol,
        String(row.name ?? ''),
        positionSize, score.total ?? 0, mcap,
      );

      // Mark signal as traded
      try {
        await db.query(`UPDATE signals SET expired = 1 WHERE id = $1`, [row.id]);
      } catch { /* not fatal */ }
    }
  } catch (err) {
    log(`Signal poll error: ${String(err)}`);
  }
}

// ── Position Management ──

async function openPosition(
  signalId: string,
  mintAddress: string,
  symbol: string,
  name: string,
  budgetSol: number,
  score: number,
  marketCap: number = 0,
): Promise<void> {
  // Get current price from DexScreener
  const price = await getTokenPrice(mintAddress);
  if (!price || price <= 0) {
    log(`Cannot get price for ${symbol} — skipping`);
    return;
  }

  const position: Position = {
    id: uuidv4(),
    signalId,
    mintAddress,
    symbol,
    name,
    status: 'open',
    budgetSol,
    entryPrice: price,
    currentPrice: price,
    tokenBalance: 0,
    solDeployed: 0,
    solReturned: 0,
    dcaLegsExecuted: 0,
    exitTiersHit: 0,
    openedAt: Date.now(),
    closedAt: null,
    pnlSol: 0,
    pnlPct: 0,
    paper: process.env.PAPER_TRADING !== 'false',
    marketCap,
    entryScore: score,
  };

  positions.set(position.id, position);

  // Execute first DCA leg immediately (20%)
  const leg1Sol = budgetSol * DCA_LEGS[0];
  await executeBuy(position, leg1Sol, 1);

  // Schedule remaining legs
  pendingDcaLegs.push({
    positionId: position.id,
    leg: 2,
    solAmount: budgetSol * DCA_LEGS[1],
    mint: mintAddress,
    executeAt: Date.now() + DCA_LEG2_DELAY_MS,
  });

  pendingDcaLegs.push({
    positionId: position.id,
    leg: 3,
    solAmount: budgetSol * DCA_LEGS[2],
    mint: mintAddress,
    executeAt: Date.now() + DCA_LEG3_DELAY_MS,
  });

  // Save to DB
  try {
    const db = await getDb();
    await db.query(
      `INSERT INTO positions (id, signal_id, mint, symbol, name, status, budget_sol, entry_price_usd,
        token_balance, sol_deployed, sol_returned, pnl_sol, pnl_pct, dca_legs, exit_tiers, paper, opened_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        position.id, signalId, mintAddress, symbol, name, 'open',
        budgetSol, price, 0, 0, 0, 0, 0,
        JSON.stringify(DCA_LEGS), JSON.stringify(EXIT_TIERS),
        position.paper ? 1 : 0, position.openedAt,
      ],
    );
  } catch { /* DB write not fatal */ }
}

async function executeBuy(position: Position, solAmount: number, legNum: number): Promise<void> {
  const price = await getTokenPrice(position.mintAddress);
  if (!price || price <= 0) return;

  if (position.paper) {
    // Paper trade: simulate buy
    const solInUsd = solAmount * (await getSolPrice());
    const tokensReceived = solInUsd / price;

    position.tokenBalance += tokensReceived;
    position.solDeployed += solAmount;
    position.dcaLegsExecuted = legNum;
    position.entryPrice = (position.entryPrice * (legNum - 1) + price) / legNum; // weighted avg
    deployedSol += solAmount;

    log(
      `DCA LEG ${legNum}: ${position.symbol} | Bought ${tokensReceived.toFixed(2)} tokens for ${solAmount.toFixed(4)} SOL | ` +
      `Entry: $${position.entryPrice.toFixed(8)} | Total deployed: ${position.solDeployed.toFixed(4)} SOL`,
    );
    alert('dca_entry', `Leg ${legNum} filled: ${position.symbol} — ${solAmount.toFixed(4)} SOL at $${price.toFixed(8)}`);
  } else {
    // Live trade: use Jupiter
    const kp = getWalletKeypair();
    if (!kp) {
      log(`LIVE DCA LEG ${legNum}: No wallet keypair — falling back to paper`);
      const solInUsd = solAmount * (await getSolPrice());
      const tokensReceived = solInUsd / price;
      position.tokenBalance += tokensReceived;
      position.solDeployed += solAmount;
      position.dcaLegsExecuted = legNum;
      position.entryPrice = (position.entryPrice * (legNum - 1) + price) / legNum;
      deployedSol += solAmount;
      return;
    }

    try {
      const lamports = Math.floor(solAmount * 1_000_000_000).toString();
      log(`LIVE DCA LEG ${legNum}: ${position.symbol} — swapping ${solAmount} SOL via Jupiter`);
      const result = await executeFullSwap(SOL_MINT, position.mintAddress, lamports, kp);

      if (result.confirmed) {
        const tokensReceived = Number(result.outputAmount) / 1_000_000; // assume 6 decimals
        position.tokenBalance += tokensReceived;
        position.solDeployed += solAmount;
        position.dcaLegsExecuted = legNum;
        position.entryPrice = (position.entryPrice * (legNum - 1) + price) / legNum;
        deployedSol += solAmount;

        log(`LIVE BUY CONFIRMED: ${position.symbol} | tx: ${result.signature.slice(0, 16)}... | ${tokensReceived.toFixed(2)} tokens`);
        alert('dca_entry', `LIVE Leg ${legNum}: ${position.symbol} — ${solAmount.toFixed(4)} SOL | tx: ${result.signature.slice(0, 16)}...`);
      } else {
        log(`LIVE BUY FAILED: ${position.symbol} — tx not confirmed`);
        alert('safety', `Buy failed for ${position.symbol} — tx not confirmed`);
      }
    } catch (err) {
      log(`LIVE BUY ERROR: ${position.symbol} — ${String(err)}`);
      alert('safety', `Buy error for ${position.symbol}: ${String(err)}`);
    }
  }
}

async function executeSell(position: Position, sellPct: number, reason: string): Promise<void> {
  const price = await getTokenPrice(position.mintAddress);
  if (!price || price <= 0) return;

  const tokensToSell = position.tokenBalance * sellPct;
  let solReceived: number;

  if (!position.paper) {
    // Live trade: sell via Jupiter
    const kp = getWalletKeypair();
    if (kp) {
      try {
        // Token amount in smallest unit (assume 6 decimals for most SPL tokens)
        const tokenLamports = Math.floor(tokensToSell * 1_000_000).toString();
        log(`LIVE SELL: ${position.symbol} — selling ${(sellPct * 100).toFixed(0)}% (${tokensToSell.toFixed(2)} tokens) via Jupiter`);
        const result = await executeFullSwap(position.mintAddress, SOL_MINT, tokenLamports, kp);

        if (result.confirmed) {
          solReceived = Number(result.outputAmount) / 1_000_000_000; // lamports to SOL
          log(`LIVE SELL CONFIRMED: ${position.symbol} | tx: ${result.signature.slice(0, 16)}... | ${solReceived.toFixed(4)} SOL`);
        } else {
          log(`LIVE SELL FAILED: ${position.symbol} — tx not confirmed, recording paper value`);
          const solPrice = await getSolPrice();
          solReceived = solPrice > 0 ? (tokensToSell * price) / solPrice : 0;
        }
      } catch (err) {
        log(`LIVE SELL ERROR: ${position.symbol} — ${String(err)}, recording paper value`);
        const solPrice = await getSolPrice();
        solReceived = solPrice > 0 ? (tokensToSell * price) / solPrice : 0;
      }
    } else {
      // No keypair — fallback to paper calc
      const solPrice = await getSolPrice();
      solReceived = solPrice > 0 ? (tokensToSell * price) / solPrice : 0;
    }
  } else {
    // Paper trade
    const solPrice = await getSolPrice();
    solReceived = solPrice > 0 ? (tokensToSell * price) / solPrice : 0;
  }

  position.tokenBalance -= tokensToSell;
  position.solReturned += solReceived;
  position.currentPrice = price;
  position.exitTiersHit++;
  deployedSol -= position.solDeployed * sellPct;

  const pnlSol = position.solReturned - position.solDeployed;
  const pnlPct = position.solDeployed > 0 ? ((position.solReturned / position.solDeployed) - 1) * 100 : 0;
  position.pnlSol = pnlSol;
  position.pnlPct = pnlPct;

  if (position.tokenBalance <= 0.001 || sellPct >= 0.99) {
    position.status = 'closed';
    position.closedAt = Date.now();
    realizedPnlSol += pnlSol;
    tradeCount++;
    if (pnlSol > 0) winCount++;

    // Record in trade history for learning
    const entry: TradeMemoryEntry = {
      mint: position.mintAddress,
      symbol: position.symbol,
      entryScore: position.entryScore,
      entryMCap: position.marketCap,
      pnlPct,
      holdTimeMs: Date.now() - position.openedAt,
      exitReason: reason,
      timestamp: Date.now(),
      phase: getCurrentPhase().name,
      hour: new Date(position.openedAt).getHours(),
      dcaLegs: position.dcaLegsExecuted,
      positionSizeSol: position.solDeployed,
    };
    tradeHistory.push(entry);
    if (tradeHistory.length > 500) tradeHistory.shift();

    // Run the learning engine on this trade
    analyzeTradeAndLearn(entry);

    log(`TRADE MEMORY: ${getMCapBucket(position.marketCap)} MCap | Score:${getScoreBucket(position.entryScore)} | Hold:${getHoldTimeBucket(entry.holdTimeMs)}`);
  } else {
    position.status = 'partial_exit';
  }

  const pnlSign = pnlPct >= 0 ? '+' : '';
  log(
    `${reason.toUpperCase()}: ${position.symbol} | Sold ${(sellPct * 100).toFixed(0)}% | ` +
    `${solReceived.toFixed(4)} SOL returned | PnL: ${pnlSign}${pnlPct.toFixed(1)}% (${pnlSign}${pnlSol.toFixed(4)} SOL) | ` +
    `${position.status === 'closed' ? 'POSITION CLOSED' : `${((1 - sellPct) * 100).toFixed(0)}% remaining`}`,
  );

  const emoji = pnlSol >= 0 ? '🟢' : '🔴';
  alert('exit', `${emoji} ${position.symbol} — ${reason}: ${pnlSign}${pnlPct.toFixed(1)}% (${pnlSign}${pnlSol.toFixed(4)} SOL)`);

  // Update DB
  try {
    const db = await getDb();
    await db.query(
      `UPDATE positions SET status=$1, token_balance=$2, sol_returned=$3, pnl_sol=$4, pnl_pct=$5 WHERE id=$6`,
      [position.status, position.tokenBalance, position.solReturned, pnlSol, pnlPct, position.id],
    );
  } catch { /* not fatal */ }
}

// ── DCA Leg Processing ──

async function processPendingDcaLegs(): Promise<void> {
  if (!running) return;
  const now = Date.now();
  const ready = pendingDcaLegs.filter(l => l.executeAt <= now);

  for (const leg of ready) {
    const position = positions.get(leg.positionId);
    if (!position || position.status === 'closed' || position.status === 'stopped_out') {
      pendingDcaLegs = pendingDcaLegs.filter(l => l !== leg);
      continue;
    }

    await executeBuy(position, leg.solAmount, leg.leg);
    pendingDcaLegs = pendingDcaLegs.filter(l => l !== leg);
  }
}

// ── Price Monitoring & Exit Logic ──

async function checkPricesAndExits(): Promise<void> {
  if (!running) return;

  const openPositions = Array.from(positions.values()).filter(
    p => p.status === 'open' || p.status === 'partial_exit',
  );

  if (openPositions.length === 0) return;

  for (const position of openPositions) {
    try {
      const price = await getTokenPrice(position.mintAddress);
      if (!price || price <= 0) continue;

      position.currentPrice = price;
      const multiplier = price / position.entryPrice;
      const holdTimeMs = Date.now() - position.openedAt;
      const holdMins = holdTimeMs / 60_000;

      // ── Trailing stop: once we hit 1.5x, move stop to breakeven ──
      const trailingStop = multiplier > 1.5 ? 1.0 : STOP_LOSS_MULTIPLIER;

      // ── Stop loss (or trailing stop) ──
      if (multiplier <= trailingStop) {
        const reason = trailingStop > STOP_LOSS_MULTIPLIER
          ? `trailing_stop (${multiplier.toFixed(2)}x, breakeven protected)`
          : `stop_loss (${multiplier.toFixed(2)}x)`;
        log(`${reason.toUpperCase()} triggered for ${position.symbol}`);
        await executeSell(position, 1.0, reason);
        position.status = 'stopped_out';
        continue;
      }

      // ── Time-based exit: use learned optimal hold time, or default 2h ──
      const maxHoldMins = learnedMaxHoldMs > 0 ? learnedMaxHoldMs / 60_000 : 120;
      if (holdMins >= maxHoldMins && multiplier >= 0.8 && multiplier <= 1.2) {
        log(`TIME EXIT: ${position.symbol} flat at ${multiplier.toFixed(2)}x for ${Math.round(holdMins)}m (learned max: ${Math.round(maxHoldMins)}m) — freeing capital`);
        await executeSell(position, 1.0, `time_exit (flat ${multiplier.toFixed(2)}x, ${Math.round(holdMins)}m)`);
        continue;
      }

      // ── Smart DCA: if dipped 20-40% from entry, apply learned DCA aggression ──
      if (multiplier >= 0.6 && multiplier <= 0.8 && holdMins <= 30 && position.dcaLegsExecuted < 3) {
        const phase = getCurrentPhase();
        const available = totalBudgetSol - deployedSol + realizedPnlSol;
        const baseDca = Math.min(phase.positionSizeMin, available * 0.15);
        const dcaAmount = baseDca * learnedDcaAggression; // Apply learned DCA multiplier
        if (dcaAmount >= 0.01) {
          log(`SMART DCA: ${position.symbol} dipped to ${multiplier.toFixed(2)}x — adding ${dcaAmount.toFixed(4)} SOL (aggression: ${learnedDcaAggression.toFixed(2)}x)`);
          alert('dca_entry', `Smart DCA: ${position.symbol} dipped ${((1 - multiplier) * 100).toFixed(0)}% — adding ${dcaAmount.toFixed(4)} SOL`);
          await executeBuy(position, dcaAmount, position.dcaLegsExecuted + 1);
        }
      }

      // ── Momentum exit: if lost 30%+ after 1 hour, cut losses early ──
      if (multiplier <= 0.7 && holdMins >= 60) {
        log(`MOMENTUM EXIT: ${position.symbol} at ${multiplier.toFixed(2)}x after ${Math.round(holdMins)}m — cutting losses`);
        await executeSell(position, 1.0, `momentum_exit (${multiplier.toFixed(2)}x, ${Math.round(holdMins)}m)`);
        continue;
      }

      // ── Exit tiers (take profit) ──
      for (let i = position.exitTiersHit; i < EXIT_TIERS.length; i++) {
        const tier = EXIT_TIERS[i];
        if (multiplier >= tier.multiplier) {
          log(`EXIT TIER ${i + 1} hit for ${position.symbol}: ${multiplier.toFixed(2)}x (target: ${tier.multiplier}x)`);
          await executeSell(position, tier.sellPct, `${tier.multiplier}x take-profit`);
          break;
        }
      }

      await sleep(1500);
    } catch {
      continue;
    }
  }

  // Save state after each price check cycle
  await saveState();
}

// ── Price Helpers ──

let cachedSolPrice = 0;
let solPriceCachedAt = 0;

async function getSolPrice(): Promise<number> {
  if (Date.now() - solPriceCachedAt < 60_000 && cachedSolPrice > 0) {
    return cachedSolPrice;
  }

  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`,
      { headers: { 'Accept': 'application/json' } },
    );

    if (res.ok) {
      const data = await res.json() as { pairs?: Array<{ priceUsd?: string }> };
      const price = parseFloat(data.pairs?.[0]?.priceUsd ?? '0');
      if (price > 0) {
        cachedSolPrice = price;
        solPriceCachedAt = Date.now();
        return price;
      }
    }
  } catch { /* fallback */ }

  return cachedSolPrice || 150; // Fallback estimate
}

async function getTokenPrice(mintAddress: string): Promise<number> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
      { headers: { 'Accept': 'application/json' } },
    );

    if (!res.ok) return 0;

    const data = await res.json() as { pairs?: Array<{ priceUsd?: string }> };
    return parseFloat(data.pairs?.[0]?.priceUsd ?? '0');
  } catch {
    return 0;
  }
}

function alert(type: string, message: string): void {
  if (alertCb) alertCb(type, message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── State Persistence ──

async function saveState(): Promise<void> {
  try {
    const db = await getDb();

    // Save trader-level state
    const state = {
      totalBudgetSol,
      deployedSol,
      realizedPnlSol,
      tradeCount,
      winCount,
    };
    await db.query(
      `INSERT INTO trader_state (key, value) VALUES ('portfolio', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(state)],
    );

    // Save MCap performance
    const mcapData = Object.fromEntries(mcapPerformance.entries());
    await db.query(
      `INSERT INTO trader_state (key, value) VALUES ('mcap_performance', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(mcapData)],
    );

    // Save all learning dimension data
    const learningState = {
      scorePerformance: Object.fromEntries(scorePerformance.entries()),
      holdTimePerformance: Object.fromEntries(holdTimePerformance.entries()),
      hourPerformance: Object.fromEntries(hourPerformance.entries()),
      dcaPerformance: Object.fromEntries(dcaPerformance.entries()),
      exitReasonStats: Object.fromEntries(exitReasonStats.entries()),
      learnedMinScore,
      learnedPositionSizeMult,
      learnedMaxHoldMs,
      learnedDcaAggression,
      preferredMCapBuckets,
      avoidMCapBuckets,
      lessons,
    };
    await db.query(
      `INSERT INTO trader_state (key, value) VALUES ('learning', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [JSON.stringify(learningState)],
    );

    // Save open positions to DB
    for (const p of positions.values()) {
      await db.query(
        `INSERT INTO positions (id, signal_id, mint, symbol, name, status, budget_sol, entry_price_usd,
          token_balance, sol_deployed, sol_returned, pnl_sol, pnl_pct, dca_legs, exit_tiers, paper, opened_at, closed_at, current_price_usd, entry_mcap)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO UPDATE SET
           status=$6, token_balance=$9, sol_deployed=$10, sol_returned=$11,
           pnl_sol=$12, pnl_pct=$13, current_price_usd=$19, closed_at=$18`,
        [
          p.id, p.signalId || '', p.mintAddress, p.symbol, p.name || '',
          p.status, p.budgetSol, p.entryPrice,
          p.tokenBalance, p.solDeployed, p.solReturned, p.pnlSol, p.pnlPct,
          JSON.stringify(DCA_LEGS), JSON.stringify(EXIT_TIERS),
          p.paper ? 1 : 0, p.openedAt, p.closedAt, p.currentPrice, p.marketCap,
        ],
      );
    }

    // Save trade history
    for (const t of tradeHistory) {
      await db.query(
        `INSERT INTO trade_history (id, mint, symbol, entry_score, entry_mcap, pnl_pct, hold_time_ms, exit_reason, phase, closed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO NOTHING`,
        [
          `${t.mint}-${t.timestamp}`, t.mint, t.symbol, t.entryScore, t.entryMCap,
          t.pnlPct, t.holdTimeMs, t.exitReason, t.phase, t.timestamp,
        ],
      );
    }
  } catch (err) {
    // State save is not fatal
    log(`State save warning: ${String(err)}`);
  }
}

async function restoreState(): Promise<void> {
  try {
    const db = await getDb();

    // Restore portfolio state
    const stateResult = await db.query(`SELECT value FROM trader_state WHERE key = 'portfolio'`);
    const stateRows = stateResult?.rows ?? [];
    if (stateRows.length > 0) {
      const saved = JSON.parse(String((stateRows[0] as { value: string }).value));
      totalBudgetSol = saved.totalBudgetSol ?? totalBudgetSol;
      deployedSol = saved.deployedSol ?? 0;
      realizedPnlSol = saved.realizedPnlSol ?? 0;
      tradeCount = saved.tradeCount ?? 0;
      winCount = saved.winCount ?? 0;
    }

    // Restore MCap performance
    const mcapResult = await db.query(`SELECT value FROM trader_state WHERE key = 'mcap_performance'`);
    const mcapRows = mcapResult?.rows ?? [];
    if (mcapRows.length > 0) {
      const saved = JSON.parse(String((mcapRows[0] as { value: string }).value));
      mcapPerformance.clear();
      for (const [k, v] of Object.entries(saved)) {
        mcapPerformance.set(k, v as { wins: number; losses: number; avgPnl: number });
      }
    }

    // Restore learning state
    const learnResult = await db.query(`SELECT value FROM trader_state WHERE key = 'learning'`);
    const learnRows = learnResult?.rows ?? [];
    if (learnRows.length > 0) {
      const saved = JSON.parse(String((learnRows[0] as { value: string }).value));
      // Restore dimension maps
      const restoreMap = (map: Map<string, DimensionStats>, data: Record<string, DimensionStats>) => {
        map.clear();
        for (const [k, v] of Object.entries(data || {})) map.set(k, v);
      };
      restoreMap(scorePerformance, saved.scorePerformance);
      restoreMap(holdTimePerformance, saved.holdTimePerformance);
      restoreMap(hourPerformance, saved.hourPerformance);
      restoreMap(dcaPerformance, saved.dcaPerformance);
      restoreMap(exitReasonStats, saved.exitReasonStats);

      // Restore learned parameters
      learnedMinScore = saved.learnedMinScore ?? 0;
      learnedPositionSizeMult = saved.learnedPositionSizeMult ?? 1;
      learnedMaxHoldMs = saved.learnedMaxHoldMs ?? 0;
      learnedDcaAggression = saved.learnedDcaAggression ?? 1;
      preferredMCapBuckets = saved.preferredMCapBuckets ?? [];
      avoidMCapBuckets = saved.avoidMCapBuckets ?? [];

      // Restore lessons
      lessons.length = 0;
      for (const l of (saved.lessons ?? [])) lessons.push(l);

      log(`Learning restored: ${lessons.length} lessons, minScore adj: ${learnedMinScore >= 0 ? '+' : ''}${learnedMinScore}, sizeMult: ${learnedPositionSizeMult.toFixed(2)}, avoid: [${avoidMCapBuckets.join(',')}]`);
    }

    // Restore open positions
    const posResult = await db.query(
      `SELECT * FROM positions WHERE status IN ('open', 'partial_exit')`,
    );
    const posRows = (posResult?.rows ?? []) as Array<Record<string, unknown>>;
    for (const row of posRows) {
      const p: Position = {
        id: String(row.id),
        signalId: String(row.signal_id ?? ''),
        mintAddress: String(row.mint),
        symbol: String(row.symbol ?? ''),
        name: String(row.name ?? ''),
        status: String(row.status) as Position['status'],
        budgetSol: Number(row.budget_sol ?? 0),
        entryPrice: Number(row.entry_price_usd ?? 0),
        currentPrice: Number(row.current_price_usd ?? 0),
        tokenBalance: Number(row.token_balance ?? 0),
        solDeployed: Number(row.sol_deployed ?? 0),
        solReturned: Number(row.sol_returned ?? 0),
        dcaLegsExecuted: 3, // Assume completed on restore
        exitTiersHit: 0,
        openedAt: Number(row.opened_at ?? Date.now()),
        closedAt: row.closed_at ? Number(row.closed_at) : null,
        pnlSol: Number(row.pnl_sol ?? 0),
        pnlPct: Number(row.pnl_pct ?? 0),
        paper: Number(row.paper ?? 1) === 1,
        marketCap: Number(row.entry_mcap ?? 0),
        entryScore: 0,
      };
      positions.set(p.id, p);
    }

    // Restore trade history
    const histResult = await db.query(
      `SELECT * FROM trade_history ORDER BY closed_at DESC LIMIT 200`,
    );
    const histRows = (histResult?.rows ?? []) as Array<Record<string, unknown>>;
    tradeHistory.length = 0;
    for (const row of histRows.reverse()) {
      tradeHistory.push({
        mint: String(row.mint),
        symbol: String(row.symbol ?? ''),
        entryScore: Number(row.entry_score ?? 0),
        entryMCap: Number(row.entry_mcap ?? 0),
        pnlPct: Number(row.pnl_pct ?? 0),
        holdTimeMs: Number(row.hold_time_ms ?? 0),
        exitReason: String(row.exit_reason ?? ''),
        phase: String(row.phase ?? ''),
        timestamp: Number(row.closed_at ?? Date.now()),
      });
    }
  } catch (err) {
    log(`State restore warning: ${String(err)} — starting fresh`);
  }
}

export async function resetPaperPortfolio(): Promise<string> {
  try {
    const db = await getDb();

    // Clear all positions and state
    positions.clear();
    tradeHistory.length = 0;
    mcapPerformance.clear();
    scorePerformance.clear();
    holdTimePerformance.clear();
    hourPerformance.clear();
    dcaPerformance.clear();
    exitReasonStats.clear();
    lessons.length = 0;
    pendingDcaLegs = [];
    coinEntries.length = 0;
    deployedSol = 0;
    realizedPnlSol = 0;
    tradeCount = 0;
    winCount = 0;
    learnedMinScore = 0;
    learnedPositionSizeMult = 1;
    learnedMaxHoldMs = 0;
    learnedDcaAggression = 1;
    preferredMCapBuckets = [];
    avoidMCapBuckets = [];
    totalBudgetSol = parseFloat(process.env.TOTAL_BUDGET_SOL || '1.0');

    // Clear DB
    await db.query(`DELETE FROM positions`);
    await db.query(`DELETE FROM trade_history`);
    await db.query(`DELETE FROM trader_state`);

    log(`PORTFOLIO RESET: Back to ${totalBudgetSol} SOL, all trades cleared`);
    alert('safety', `Portfolio reset to ${totalBudgetSol} SOL — clean slate`);

    return `Portfolio reset to ${totalBudgetSol} SOL. All positions and trade history cleared.`;
  } catch (err) {
    return `Reset failed: ${String(err)}`;
  }
}
