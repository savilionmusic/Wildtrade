import 'dotenv/config';
import { getDb, closeDb } from '@wildtrade/shared';
import { createFinderRuntime } from './agents/finder.js';
import { createTraderRuntime } from './agents/trader.js';
import { createAuditorRuntime } from './agents/auditor.js';
import { createSocketServer, broadcast } from './server.js';
import { initApprovalGate } from './approval-gate.js';
import { startCLI } from './cli.js';

const requiredEnvVars = [
  'OPENROUTER_API_KEY',
  'WALLET_PUBLIC_KEY',
];

function validateEnv(): void {
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[boot] Missing required env vars: ${missing.join(', ')}`);
    console.error('[boot] Copy .env.example to .env and fill in your values.');
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

  // Phase 2: Database
  console.log('[boot] Initializing database...');
  await getDb();
  console.log('[boot] Database ready.');

  // Phase 3: Socket.IO Server
  console.log('[boot] Starting Socket.IO server...');
  const { io } = createSocketServer();
  initApprovalGate(io);

  // Phase 4: Agent Runtimes
  const token = process.env.OPENROUTER_API_KEY!;

  console.log('[boot] Creating Auditor agent (Fixer)...');
  const auditor = createAuditorRuntime(token);
  await auditor.initialize();

  console.log('[boot] Creating Finder agent (Scout)...');
  const finder = createFinderRuntime(token);
  await finder.initialize();

  console.log('[boot] Creating Trader agent (Executioner)...');
  const trader = createTraderRuntime(token);
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
