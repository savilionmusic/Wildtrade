import 'dotenv/config';
import { mkdirSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getDb, closeDb, SCORE_THRESHOLDS, SIGNAL_DEFAULT_TTL_MS } from '@wildtrade/shared';
import { getElizaAdapter } from './db-adapter.js';
import { createFinderRuntime } from './agents/finder.js';
import { createTraderRuntime } from './agents/trader.js';
import { createAuditorRuntime } from './agents/auditor.js';
import { createSocketServer, broadcast } from './server.js';
import { initApprovalGate } from './approval-gate.js';
import { startCLI } from './cli.js';
import { handleChatMessage, addProactiveAlert } from './chat-handler.js';
import {
  startSmartMoneyMonitor,
  stopSmartMoneyMonitor,
  getTrackedWalletAddresses,
  getRecentSmartBuys,
  startScanner,
  stopScanner,
  startWalletIntelligence,
  stopWalletIntelligence,
  startKolIntelligence,
  stopKolIntelligence,
  setTokenMentionCallback,
  getWalletIntelStats,
  getKolStats,
  configureTelegram,
  sendTelegramAlert,
  startConvergenceDetector,
  stopConvergenceDetector,
  getTrackedWallets,
  onTelegramMessage,
  stopTelegramPolling,
  enqueueToken,
} from '@wildtrade/plugin-alpha-scout';
import {
  startAutonomousTrader,
  stopAutonomousTrader,
  getTraderStats,
  getOpenPositions,
  getTradeHistory,
  setMaxPositions,
  setMaxTradesPerDay,
  resetPaperPortfolio,
  getLessons,
} from '@wildtrade/plugin-smart-trader';
import {
  seedEndpoints,
  startHealthChecks,
  stopHealthChecks,
  startInterval as startReconciler,
  stopInterval as stopReconciler,
  startPerformanceAuditor,
  stopPerformanceAuditor,
  onAuditReport,
  startLogWatcher,
  stopLogWatcher,
} from '@wildtrade/plugin-self-healer';

const requiredEnvVars = [
  'OPENROUTER_API_KEY',
];

function isPlaceholderValue(value: string | undefined): boolean {
  const normalized = value?.trim() ?? '';
  if (!normalized) return false;

  return normalized.startsWith('YOUR_')
    || normalized.includes('YOUR_KEY')
    || normalized.includes('your-endpoint')
    || normalized.includes('your-server.example.com')
    || normalized.includes('wallet1pubkey')
    || normalized.includes('wallet2pubkey')
    || normalized === '12345678,87654321';
}

function clearPlaceholderEnv(key: string): void {
  if (!isPlaceholderValue(process.env[key])) return;

  console.log(`[boot] Ignoring placeholder value for ${key}`);
  delete process.env[key];
}

function validateEnv(): void {
  clearPlaceholderEnv('SOLANA_RPC_HELIUS');
  clearPlaceholderEnv('SOLANA_RPC_QUICKNODE');
  clearPlaceholderEnv('HELIUS_API_KEY');
  clearPlaceholderEnv('HELIUS_WEBHOOK_URL');
  clearPlaceholderEnv('HELIUS_WEBHOOK_SECRET');
  clearPlaceholderEnv('TWITTER_BEARER_TOKEN');
  clearPlaceholderEnv('TWITTER_KOL_USER_IDS');
  clearPlaceholderEnv('SMART_MONEY_WALLETS');
  clearPlaceholderEnv('TELEGRAM_BOT_TOKEN');
  clearPlaceholderEnv('TELEGRAM_CHAT_ID');

  // Set defaults for paper trading
  if (!process.env.WALLET_PUBLIC_KEY || isPlaceholderValue(process.env.WALLET_PUBLIC_KEY)) {
    process.env.WALLET_PUBLIC_KEY = '11111111111111111111111111111111';
  }

  const missing = requiredEnvVars.filter((v) => {
    const value = process.env[v];
    return !value || isPlaceholderValue(value);
  });

  if (missing.length > 0) {
    console.error(`[boot] Missing required env vars: ${missing.join(', ')}`);
    console.error('[boot] Go to Settings in the app and add a real OpenRouter API key, not the placeholder from .env.example.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Helper to send IPC messages to Electron parent process
  const sendToParent = (msg: unknown) => {
    if (process.send) process.send(msg);
  };

  console.log('╔═══════════════════════════════════════════╗');
  console.log('║   WILDTRADE - Tri-Squad Trading Bot       ║');
  console.log('║   1-to-10 SOL Challenge                   ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');

  // Phase 1: Environment
  validateEnv();
  const paperMode = process.env.PAPER_TRADING !== 'false';
  const autonomousMode = process.env.AUTONOMOUS_MODE === 'true';
  console.log(`[boot] Mode: ${paperMode ? 'PAPER TRADING' : '⚠️  LIVE TRADING'}`);
  console.log(`[boot] Autonomous: ${autonomousMode ? 'ON' : 'OFF (approval required for large trades)'}`);

  // Phase 2: Database (ensure dir exists)
  const dbDir = process.env.PGLITE_DATA_DIR || './.wildtrade-db';
  mkdirSync(dbDir, { recursive: true });

  console.log('[boot] Initializing databases...');
  await getDb();                          // PGLite for trading domain tables
  const elizaAdapter = await getElizaAdapter(); // SQLite for ElizaOS memory tables
  console.log('[boot] Databases ready.');

  // Phase 3: Socket.IO Server
  console.log('[boot] Starting Socket.IO server...');
  const { io } = createSocketServer();
  initApprovalGate(io);

  // Phase 4: Agent Runtimes (shared SQLite adapter)
  const token = process.env.OPENROUTER_API_KEY!;

  console.log('[boot] Creating Auditor agent (Fixer)...');
  const auditor = createAuditorRuntime(token, elizaAdapter);
  await auditor.initialize();

  console.log('[boot] Creating Finder agent (Scout)...');
  const finder = createFinderRuntime(token, elizaAdapter);
  await finder.initialize();

  console.log('[boot] Creating Trader agent (Executioner)...');
  const trader = createTraderRuntime(token, elizaAdapter);
  await trader.initialize();

  console.log('[boot] All agents initialized.');

  // Phase 4b: Auditor services — wire up the self-healer so it actually runs
  console.log('[boot] Starting auditor services...');
  await seedEndpoints();                // Populate rpc_endpoints table from env vars
  startHealthChecks();                   // Periodic RPC health pings + auto-rotation
  startReconciler();                     // Reconcile on-chain balances vs DB every 5 min
  startLogWatcher(auditor);             // Feed error log lines into auditor evaluator
  startPerformanceAuditor();            // Generate trade performance reports every 20 min
  onAuditReport((report) => {
    const msg = report.summary;
    sendToParent({ type: 'proactive-alert', alertType: 'audit_report', message: msg });
    addProactiveAlert('audit_report', msg);
    sendTelegramAlert('audit_report', msg);
    broadcast('auditor:report', 'auditor', {
      winRate: report.winRate,
      avgPnlPct: report.avgPnlPct,
      totalTrades: report.totalTrades,
      catastrophicLoss: report.catastrophicLoss,
      summary: report.summary,
      timestamp: report.timestamp,
    });
    // If catastrophic loss, request graceful restart via Electron IPC
    if (report.catastrophicLoss) {
      console.log('[auditor] Catastrophic loss detected — requesting bot restart via IPC.');
      sendToParent({ type: 'bot:restart-request', reason: 'catastrophic_loss' });
    }
  });
  console.log('[boot] Auditor services active.');

  // Phase 4b: Telegram Notifications
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    configureTelegram(process.env.TELEGRAM_BOT_TOKEN, process.env.TELEGRAM_CHAT_ID);
    console.log('[boot] Telegram notifications configured.');

    // Two-way Telegram: user can send commands back to bot
    onTelegramMessage(async (text: string) => {
      console.log(`[telegram] User command: "${text}"`);
      const response = await handleChatMessage(finder, text);
      return response.text;
    });
    console.log('[boot] Two-way Telegram active — user can send commands via Telegram.');
  } else {
    console.log('[boot] Telegram not configured — set bot token + chat ID in Settings for push alerts.');
  }

  // Phase 5: Smart Money Monitor
  console.log('[boot] Starting smart money monitor...');
  const userWallets = (process.env.SMART_MONEY_WALLETS ?? '')
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);

  const recentClusters: object[] = [];

  await startSmartMoneyMonitor(
    (signal) => {
      // When a cluster is detected, log it and broadcast to UI
      const clusterMsg = `CLUSTER: ${signal.tokenSymbol || signal.tokenAddress.slice(0, 8)} — ${signal.smartWalletCount} wallets, ${signal.totalSolInvested.toFixed(2)} SOL, ${signal.confidence} confidence | https://dexscreener.com/solana/${signal.tokenAddress}`;
      console.log(`[smart-money] ${clusterMsg}`);
      
      const cEvent = {
        tokenAddress: signal.tokenAddress,
        tokenSymbol: signal.tokenSymbol,
        smartWalletCount: signal.smartWalletCount,
        totalSolInvested: signal.totalSolInvested,
        confidence: signal.confidence,
        detectedAt: signal.detectedAt,
      };
      recentClusters.unshift(cEvent);
      if (recentClusters.length > 50) recentClusters.pop();

      addProactiveAlert('smart_money_cluster', clusterMsg);
      sendToParent({ type: 'proactive-alert', alertType: 'smart_money_cluster', message: clusterMsg });
      sendTelegramAlert('smart_money_cluster', clusterMsg);

      broadcast('smart-money:cluster', 'finder', {
        tokenAddress: signal.tokenAddress,
        tokenSymbol: signal.tokenSymbol,
        tokenName: signal.tokenName,
        smartWalletCount: signal.smartWalletCount,
        totalSolInvested: signal.totalSolInvested,
        confidence: signal.confidence,
        detectedAt: signal.detectedAt,
      });

      // Feed the cluster signal into the Finder agent as a message
      // so it can run through SMART_MONEY_SCAN action
      const clusterPayload = JSON.stringify({
        tokenAddress: signal.tokenAddress,
        tokenSymbol: signal.tokenSymbol,
        tokenName: signal.tokenName,
        smartWalletCount: signal.smartWalletCount,
        totalSolInvested: signal.totalSolInvested,
        avgMarketCap: signal.avgMarketCap,
        confidence: signal.confidence,
        tokenInfo: signal.tokenInfo,
      });

      console.log(`[smart-money] Feeding cluster to Finder agent for scoring...`);
      // Create a memory in the finder's runtime that triggers SMART_MONEY_SCAN
      finder.messageManager.createMemory({
        id: crypto.randomUUID() as any,
        userId: '00000000-0000-0000-0000-000000000001' as any,
        agentId: finder.agentId,
        roomId: '00000000-0000-0000-0000-000000000099' as any,
        content: {
          text: `SMART_MONEY_CLUSTER ${clusterPayload}`,
        },
        createdAt: Date.now(),
      }).catch(err => {
        console.log(`[smart-money] Error feeding to Finder: ${String(err)}`);
      });
    },
    userWallets.length > 0 ? userWallets : undefined,
  );
  console.log('[boot] Smart money monitor started.');

  // Phase 6: Token Scanner (PumpFun + DexScreener)
  console.log('[boot] Starting token scanner (PumpPortal + DexScreener)...');
  startScanner(finder, (level, msg) => {
    console.log(`[scanner] ${msg}`);
    // Only forward actual signals to UI (not every scanned token)
    if (msg.includes('SIGNAL FORWARDED')) {
      addProactiveAlert('signal_forwarded', msg);
      sendToParent({ type: 'proactive-alert', alertType: 'signal_forwarded', message: msg });
      sendTelegramAlert('signal_forwarded', msg);
    }
  });
  console.log('[boot] Token scanner active — watching for new launches and trending tokens.');

  // Phase 6b: Wallet Intelligence (leaderboard + top trader discovery)
  console.log('[boot] Starting wallet intelligence...');
  startWalletIntelligence((msg) => {
    console.log(`[wallet-intel] ${msg}`);
    // Only alert on significant discoveries (not routine updates)
    if (msg.includes('Discovered') && msg.includes('new wallets')) {
      addProactiveAlert('wallet_intel', msg);
      sendToParent({ type: 'proactive-alert', alertType: 'wallet_intel', message: msg });
    }
  });
  console.log('[boot] Wallet intelligence active — tracking smart money leaderboard.');

  // Phase 6c: KOL Intelligence (DexScreener social + CTOs + ads)
  console.log('[boot] Starting KOL intelligence...');
  startKolIntelligence((msg) => {
    console.log(`[kol-intel] ${msg}`);
    if (msg.includes('Found') || msg.includes('takeover')) {
      addProactiveAlert('kol_intel', msg);
      sendToParent({ type: 'proactive-alert', alertType: 'kol_intel', message: msg });
    }
  });

  // Wire KOL signals into the scanner queue
  setTokenMentionCallback((signal) => {
    addProactiveAlert('kol_signal', `${signal.source}: ${signal.context}`);
    sendToParent({ type: 'proactive-alert', alertType: 'kol_signal', message: `${signal.source}: ${signal.context}` });
    
    // Actually push this token into the deep-analysis scanner queue!
    enqueueToken(signal.tokenMint, signal.tokenSymbol, signal.context, 'twitter_kol');
  });
  console.log('[boot] KOL intelligence active — monitoring social signals, CTOs, and ads.');

  // Phase 6d: Wallet Convergence Detector
  console.log('[boot] Starting wallet convergence detector...');
  const trackedWallets = getTrackedWallets().map(w => w.address);
  const convergenceWallets = trackedWallets.length > 0 ? trackedWallets : userWallets;
  if (convergenceWallets.length >= 2) {
    startConvergenceDetector(
      convergenceWallets,
      async (signal) => {
        const convMsg = `CONVERGENCE: ${signal.tokenSymbol || signal.tokenMint.slice(0, 8)} — ${signal.walletCount} wallets converge | MCap: $${signal.marketCap.toLocaleString()} | ${signal.confidence} | https://dexscreener.com/solana/${signal.tokenMint}`;
        console.log(`[convergence] ${convMsg}`);
        addProactiveAlert('smart_money_cluster', convMsg);
        sendToParent({ type: 'proactive-alert', alertType: 'smart_money_cluster', message: convMsg });
        sendTelegramAlert('smart_money_cluster', convMsg);

        // Score based on wallet convergence count
        const baseScore = signal.walletCount >= 5 ? 85
          : signal.walletCount >= 4 ? 80
          : signal.walletCount >= 3 ? 75
          : 70;

        // Write a high-priority signal directly to DB so autonomous trader picks it up immediately
        try {
          const db = await getDb();
          const now = Date.now();
          await db.query(
            `INSERT INTO signals (id, mint, symbol, name, market_cap_usd, liquidity_usd,
               sources, score_json, discovered_at, expires_at, tweet_urls, whale_wallets,
               rugcheck_passed, rugcheck_score, creator_addr, in_denylist, expired)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0)
             ON CONFLICT (id) DO NOTHING`,
            [
              uuidv4(),
              signal.tokenMint,
              signal.tokenSymbol || signal.tokenMint.slice(0, 8),
              signal.tokenName || '',
              signal.marketCap || 0,
              signal.liquidity || 0,
              JSON.stringify(['convergence']),
              JSON.stringify({ total: baseScore, conviction: signal.walletCount >= 4 ? 'high' : 'medium', signals: {} }),
              now,
              now + SIGNAL_DEFAULT_TTL_MS,
              JSON.stringify([]),
              JSON.stringify([]),
              1, 85, '', 0,
            ],
          );
          console.log(`[convergence] Injected ${signal.tokenSymbol || signal.tokenMint.slice(0, 8)} into signals DB (score=${baseScore}) — autonomous trader will pick up.`);
        } catch (err) {
          console.log(`[convergence] DB inject error: ${err}`);
        }
      },
      (msg) => console.log(`[convergence] ${msg}`),
    );
    console.log(`[boot] Convergence detector active — scanning ${convergenceWallets.length} wallets for token overlap.`);
  } else {
    console.log('[boot] Convergence detector skipped — need 2+ wallets. Add SMART_MONEY_WALLETS in Settings.');
  }

  // Phase 6e: Autonomous Trader
  console.log('[boot] Starting autonomous trader...');
  startAutonomousTrader({
    onLog: (msg) => {
      console.log(`[trader] ${msg}`);
      // Feed trade events to proactive alerts + parent + telegram
      if (msg.includes('ENTERING') || msg.includes('DCA LEG') || msg.includes('EXIT') || msg.includes('STOP LOSS')) {
        addProactiveAlert('dca_entry', msg);
        sendToParent({ type: 'proactive-alert', alertType: 'dca_entry', message: msg });
        sendTelegramAlert('dca_entry', msg);
      }
    },
    onAlert: (type, alertMsg) => {
      addProactiveAlert(type, alertMsg);
      sendToParent({ type: 'proactive-alert', alertType: type, message: alertMsg });
      sendTelegramAlert(type, alertMsg);
    },
  });
  const traderStats = getTraderStats();
  console.log(`[boot] Autonomous trader ${traderStats.running ? 'ONLINE' : 'FAILED TO START'} | Mode: ${paperMode ? 'PAPER' : 'LIVE'} | Budget: ${process.env.TOTAL_BUDGET_SOL || '1.0'} SOL`);

  // Phase 6f: Periodic status report
  setInterval(() => {
    const walletStats = getWalletIntelStats();
    const kolStats = getKolStats();
    const tStats = getTraderStats();
    console.log(
      `[status] Wallets tracked: ${walletStats.tracked} | ` +
      `Recent buys: ${walletStats.recentBuys} | ` +
      `KOL signals: ${kolStats.totalSignals} (${kolStats.recentSignals} recent) | ` +
      `Trader: ${tStats.positions} positions, ${tStats.deployed} SOL deployed, PnL: ${tStats.realized} SOL, Win: ${tStats.winRate}%`,
    );
  }, 120_000); // every 2 min

  // Phase 7: IPC Chat Handler (Electron ↔ ElizaOS)
  // When running as a child process of Electron, listen for chat messages
  if (process.send) {
    console.log('[boot] IPC bridge active — chat routes through Scout agent.');

    process.on('message', async (msg: any) => {
      if (msg?.type === 'chat:message') {
        try {
          const response = await handleChatMessage(finder, msg.text);
          process.send!({
            type: 'chat:response',
            id: msg.id,
            text: response.text,
            action: response.action,
          });
        } catch (err) {
          process.send!({
            type: 'chat:response',
            id: msg.id,
            text: `got an error processing that: ${String(err)}`,
            error: true,
          });
        }
      }

      if (msg?.type === 'portfolio:get') {
        const tStats = getTraderStats();
        const openPos = getOpenPositions();
        const history = getTradeHistory();
        process.send!({
          type: 'portfolio:response',
          id: msg.id,
          data: {
            paper: process.env.PAPER_TRADING !== 'false',
            budget: tStats.budget,
            deployed: tStats.deployed,
            available: tStats.available,
            realized: tStats.realized,
            unrealized: tStats.unrealized,
            totalPnl: tStats.totalPnl,
            totalPnlPct: tStats.totalPnlPct,
            portfolioValue: tStats.portfolioValue,
            winRate: tStats.winRate,
            trades: tStats.trades,
            phase: tStats.phase,
            targetMCap: tStats.targetMCap,
            tradesToday: tStats.tradesToday,
            maxTradesToday: tStats.maxTradesToday,
            maxPositions: tStats.maxPositions,
            positions: openPos,
            history,
            lessons: getLessons(),
          },
        });
      }

      if (msg?.type === 'smartmoney:get') {
        const wallets = getTrackedWalletAddresses();
        const recentBuys = getRecentSmartBuys();
        
        // Count whales discovered today
        // For simplicity right now, simulate from tracked list if we don't have a direct DB count
        const whalesFound = wallets.length > (userWallets?.length || 0) ? wallets.length - (userWallets?.length || 0) : 0;

        process.send!({
          type: 'smartmoney:response',
          id: msg.id,
          data: {
            wallets,
            whalesFound,
            recentBuys: recentBuys.slice(0, 50),
            clusters: recentClusters
          }
        });
      }

      if (msg?.type === 'config:set') {
        if (msg.key === 'MAX_POSITIONS') {
          setMaxPositions(Number(msg.value));
          console.log(`[config] Max positions set to ${msg.value}`);
        }
        if (msg.key === 'MAX_TRADES_PER_DAY') {
          setMaxTradesPerDay(Number(msg.value));
          console.log(`[config] Max trades per day set to ${msg.value}`);
        }
      }

      if (msg?.type === 'portfolio:reset') {
        const result = await resetPaperPortfolio();
        process.send!({ type: 'portfolio:reset-response', id: msg.id, data: result });
      }
    });
  }

  // Phase 7: Health Heartbeat
  const heartbeatInterval = setInterval(() => {
    broadcast('agent:status', 'finder', { agent: 'finder', status: 'online' });
    broadcast('agent:status', 'trader', { agent: 'trader', status: 'online' });
    broadcast('agent:status', 'auditor', { agent: 'auditor', status: 'online' });
  }, 30_000);

  // Phase 8: CLI
  startCLI({ finder, trader, auditor, io });

  // Phase 9: Graceful Shutdown
  const shutdown = async () => {
    console.log('\n[shutdown] Graceful shutdown initiated...');
    clearInterval(heartbeatInterval);
    stopLogWatcher();
    stopPerformanceAuditor();
    stopReconciler();
    stopHealthChecks();
    stopScanner();
    stopWalletIntelligence();
    stopKolIntelligence();
    stopSmartMoneyMonitor();
    stopConvergenceDetector();
    stopAutonomousTrader();
    stopTelegramPolling();

    broadcast('agent:status', 'finder', { agent: 'finder', status: 'offline' });
    broadcast('agent:status', 'trader', { agent: 'trader', status: 'offline' });
    broadcast('agent:status', 'auditor', { agent: 'auditor', status: 'offline' });

    try {
      await closeDb();
      console.log('[shutdown] Database closed.');
    } catch (err) {
      console.error('[shutdown] DB close error:', err);
    }

    io.close();
    console.log('[shutdown] Socket.IO closed.');
    console.log('[shutdown] Goodbye.');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});

// Prevent unhandled promise rejections from crashing the bot process
// (e.g. from third-party scrapers like agent-twitter-client)
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Caught to prevent crash:', String(reason));
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException] Caught to prevent crash:', String(err));
});
