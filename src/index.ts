import 'dotenv/config';
import { mkdirSync } from 'fs';
import { getDb, closeDb } from '@wildtrade/shared';
import { getElizaAdapter } from './db-adapter.js';
import { createFinderRuntime } from './agents/finder.js';
import { createTraderRuntime } from './agents/trader.js';
import { createAuditorRuntime } from './agents/auditor.js';
import { createSocketServer, broadcast } from './server.js';
import { initApprovalGate } from './approval-gate.js';
import { startCLI } from './cli.js';
import {
  startSmartMoneyMonitor,
  stopSmartMoneyMonitor,
  startScanner,
  stopScanner,
} from '@wildtrade/plugin-alpha-scout';

const requiredEnvVars = [
  'OPENROUTER_API_KEY',
];

function validateEnv(): void {
  // Set defaults for paper trading
  if (!process.env.WALLET_PUBLIC_KEY) {
    process.env.WALLET_PUBLIC_KEY = '11111111111111111111111111111111';
  }
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[boot] Missing required env vars: ${missing.join(', ')}`);
    console.error('[boot] Go to Settings in the app and add your OpenRouter API key.');
    process.exit(1);
  }
}

async function main(): Promise<void> {
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

  // Phase 5: Smart Money Monitor
  console.log('[boot] Starting smart money monitor...');
  const userWallets = (process.env.SMART_MONEY_WALLETS ?? '')
    .split(',')
    .map(w => w.trim())
    .filter(Boolean);

  await startSmartMoneyMonitor(
    (signal) => {
      // When a cluster is detected, log it and broadcast to UI
      console.log(`[smart-money] CLUSTER: ${signal.tokenSymbol || signal.tokenAddress.slice(0, 8)} — ${signal.smartWalletCount} wallets, ${signal.totalSolInvested.toFixed(2)} SOL, ${signal.confidence} confidence`);

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
  });
  console.log('[boot] Token scanner active — watching for new launches and trending tokens.');

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
    stopScanner();
    stopSmartMoneyMonitor();

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
