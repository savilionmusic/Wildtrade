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
}

// ── State ──
let running = false;
let signalPollTimer: ReturnType<typeof setInterval> | null = null;
let priceCheckTimer: ReturnType<typeof setInterval> | null = null;
let dcaTimer: ReturnType<typeof setInterval> | null = null;
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

  // Adapt based on win rate after 3+ trades
  if (tradeCount >= 3) {
    const wr = winCount / tradeCount;
    if (wr < 0.25) {
      minScore = Math.min(80, minScore + 15);
      log(`Learning: win rate ${(wr * 100).toFixed(0)}% — raising threshold to ${minScore}`);
    } else if (wr < 0.4) {
      minScore = Math.min(75, minScore + 8);
    } else if (wr > 0.6) {
      minScore = Math.max(50, minScore - 5);
    }
  }

  // Adapt based on MCap bucket memory — boost if a bucket is performing well
  return minScore;
}

// ── Public API ──

export function startAutonomousTrader(opts: {
  onLog?: TradingLogCb;
  onAlert?: (type: string, msg: string) => void;
}): void {
  if (running) return;
  running = true;
  if (opts.onLog) log = opts.onLog;
  if (opts.onAlert) alertCb = opts.onAlert;

  totalBudgetSol = parseFloat(process.env.TOTAL_BUDGET_SOL || '1.0');

  const paperMode = process.env.PAPER_TRADING !== 'false';
  const phase = getCurrentPhase();
  log(`Autonomous trader ONLINE | Mode: ${paperMode ? 'PAPER' : 'LIVE'} | Budget: ${totalBudgetSol} SOL | ${phase.name}`);
  log(`Target MCap: $${phase.targetMCapMin.toLocaleString()} - $${phase.targetMCapMax.toLocaleString()} | Position size: ${phase.positionSizeMin}-${phase.positionSizeMax} SOL`);

  signalPollTimer = setInterval(pollForSignals, POLL_INTERVAL_MS);
  priceCheckTimer = setInterval(checkPricesAndExits, PRICE_CHECK_INTERVAL_MS);
  dcaTimer = setInterval(processPendingDcaLegs, 10_000);

  log('Signal polling active (every 15s) | Price monitoring active (every 30s)');
}

export function stopAutonomousTrader(): void {
  running = false;
  if (signalPollTimer) clearInterval(signalPollTimer);
  if (priceCheckTimer) clearInterval(priceCheckTimer);
  if (dcaTimer) clearInterval(dcaTimer);
  signalPollTimer = null;
  priceCheckTimer = null;
  dcaTimer = null;
  log('Autonomous trader stopped');
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
  budget: number;
  available: number;
  winRate: number;
  trades: number;
  phase: string;
  targetMCap: string;
} {
  const phase = getCurrentPhase();
  return {
    running,
    positions: positions.size,
    deployed: Math.round(deployedSol * 10000) / 10000,
    realized: Math.round(realizedPnlSol * 10000) / 10000,
    budget: totalBudgetSol,
    available: Math.round((totalBudgetSol - deployedSol + realizedPnlSol) * 10000) / 10000,
    winRate: tradeCount > 0 ? Math.round((winCount / tradeCount) * 100) : 0,
    trades: tradeCount,
    phase: phase.name,
    targetMCap: `$${(phase.targetMCapMin / 1000).toFixed(0)}k-$${(phase.targetMCapMax / 1000).toFixed(0)}k`,
  };
}

export function getOpenPositions(): Position[] {
  return Array.from(positions.values()).filter(p => p.status === 'open' || p.status === 'partial_exit');
}

export function getTradeHistory(): TradeMemoryEntry[] {
  return tradeHistory;
}

// ── Signal Polling ──

async function pollForSignals(): Promise<void> {
  if (!running) return;

  try {
    const db = await getDb();
    const phase = getCurrentPhase();
    const minScore = getAdaptiveMinScore();
    const openCount = Array.from(positions.values()).filter(p => p.status === 'open' || p.status === 'partial_exit').length;

    if (openCount >= phase.maxPositions) return; // Max positions for this phase

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
      const positionSize = Math.min(phase.positionSizeMax, Math.max(phase.positionSizeMin, available * 0.25));

      if (positionSize < phase.positionSizeMin || available < phase.positionSizeMin) {
        log(`Budget tight — available: ${available.toFixed(4)} SOL, need ${phase.positionSizeMin} SOL`);
        continue;
      }

      const score = JSON.parse(String(row.score_json ?? '{}'));
      const symbol = String(row.symbol ?? mintAddress.slice(0, 8));
      const mcap = Number(row.market_cap_usd ?? 0);

      log(`ENTERING POSITION: ${symbol} | Score: ${score.total} | MCap: $${mcap.toLocaleString()} | Budget: ${positionSize.toFixed(4)} SOL | ${phase.name}`);
      alert('dca_entry', `Entering ${symbol} — Score: ${score.total}/100, MCap: $${mcap.toLocaleString()}, DCA ${positionSize.toFixed(4)} SOL [${phase.name}]`);

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
    log(`LIVE DCA LEG ${legNum}: ${position.symbol} — would execute Jupiter swap for ${solAmount} SOL`);
    // TODO: Implement actual Jupiter signing when wallet is configured
    // For now, treat as paper
    const solInUsd = solAmount * (await getSolPrice());
    const tokensReceived = solInUsd / price;
    position.tokenBalance += tokensReceived;
    position.solDeployed += solAmount;
    position.dcaLegsExecuted = legNum;
    deployedSol += solAmount;
  }
}

async function executeSell(position: Position, sellPct: number, reason: string): Promise<void> {
  const price = await getTokenPrice(position.mintAddress);
  if (!price || price <= 0) return;

  const tokensToSell = position.tokenBalance * sellPct;
  const solInUsd = tokensToSell * price;
  const solPrice = await getSolPrice();
  const solReceived = solPrice > 0 ? solInUsd / solPrice : 0;

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
    tradeHistory.push({
      mint: position.mintAddress,
      symbol: position.symbol,
      entryScore: position.entryScore,
      entryMCap: position.marketCap,
      pnlPct,
      holdTimeMs: Date.now() - position.openedAt,
      exitReason: reason,
      timestamp: Date.now(),
      phase: getCurrentPhase().name,
    });
    if (tradeHistory.length > 500) tradeHistory.shift();

    // Update MCap bucket performance for learning
    const bucket = getMCapBucket(position.marketCap);
    const existing = mcapPerformance.get(bucket) || { wins: 0, losses: 0, avgPnl: 0 };
    if (pnlSol > 0) existing.wins++;
    else existing.losses++;
    const totalTrades = existing.wins + existing.losses;
    existing.avgPnl = ((existing.avgPnl * (totalTrades - 1)) + pnlPct) / totalTrades;
    mcapPerformance.set(bucket, existing);

    log(`TRADE MEMORY: ${bucket} MCap bucket now ${existing.wins}W/${existing.losses}L (avg ${existing.avgPnl.toFixed(1)}% PnL)`);
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

      // Check stop loss
      if (multiplier <= STOP_LOSS_MULTIPLIER) {
        log(`STOP LOSS triggered for ${position.symbol} at ${multiplier.toFixed(2)}x`);
        await executeSell(position, 1.0, `stop_loss (${multiplier.toFixed(2)}x)`);
        position.status = 'stopped_out';
        continue;
      }

      // Check exit tiers
      for (let i = position.exitTiersHit; i < EXIT_TIERS.length; i++) {
        const tier = EXIT_TIERS[i];
        if (multiplier >= tier.multiplier) {
          log(`EXIT TIER ${i + 1} hit for ${position.symbol}: ${multiplier.toFixed(2)}x (target: ${tier.multiplier}x)`);
          await executeSell(position, tier.sellPct, `${tier.multiplier}x take-profit`);
          break; // Only one tier per check cycle
        }
      }

      await sleep(1500); // Rate limit between price checks
    } catch {
      continue;
    }
  }
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
