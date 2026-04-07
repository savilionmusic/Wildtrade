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

  // Phase 5: Health Heartbeat
  const heartbeatInterval = setInterval(() => {
    broadcast('agent:status', 'finder', { agent: 'finder', status: 'online' });
    broadcast('agent:status', 'trader', { agent: 'trader', status: 'online' });
    broadcast('agent:status', 'auditor', { agent: 'auditor', status: 'online' });
  }, 30_000);

  // Phase 6: CLI
  startCLI({ finder, trader, auditor, io });

  // Phase 7: Graceful Shutdown
  const shutdown = async () => {
    console.log('\n[shutdown] Graceful shutdown initiated...');
    clearInterval(heartbeatInterval);

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
