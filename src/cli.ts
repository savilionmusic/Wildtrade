import { createInterface } from 'readline';
import type { AgentRuntime } from '@elizaos/core';
import type { Server as SocketIOServer } from 'socket.io';
import { getDb } from '@wildtrade/shared';

interface CLIContext {
  finder: AgentRuntime;
  trader: AgentRuntime;
  auditor: AgentRuntime;
  io: SocketIOServer;
}

export function startCLI(ctx: CLIContext): void {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n[cli] Wildtrade Tri-Squad Bot ready. Commands:');
  console.log('  status     - Show agent status');
  console.log('  positions  - List open positions');
  console.log('  signals    - List active signals');
  console.log('  portfolio  - Show portfolio summary');
  console.log('  denylist   - Show denylisted addresses');
  console.log('  quit       - Shutdown gracefully');
  console.log('');

  rl.on('line', async (line) => {
    const cmd = line.trim().toLowerCase();

    try {
      switch (cmd) {
        case 'status': {
          const paper = process.env.PAPER_TRADING === 'true';
          const auto = process.env.AUTONOMOUS_MODE === 'true';
          console.log(`[status] Mode: ${paper ? 'PAPER' : 'LIVE'} | Autonomous: ${auto}`);
          console.log(`[status] Finder:  ${ctx.finder.character.name} (online)`);
          console.log(`[status] Trader:  ${ctx.trader.character.name} (online)`);
          console.log(`[status] Auditor: ${ctx.auditor.character.name} (online)`);
          console.log(`[status] Socket.IO clients: ${ctx.io.engine.clientsCount}`);
          break;
        }

        case 'positions': {
          const db = await getDb();
          const result = await db.query(
            `SELECT id, mint, status, entry_price_sol, current_price_sol, token_balance, is_paper_trade
             FROM positions WHERE status NOT IN ('closed', 'failed', 'cancelled')
             ORDER BY created_at DESC LIMIT 20`
          );
          if (result.rows.length === 0) {
            console.log('[positions] No open positions.');
          } else {
            for (const row of result.rows) {
              const r = row as any;
              const pnl = r.current_price_sol && r.entry_price_sol
                ? (((r.current_price_sol - r.entry_price_sol) / r.entry_price_sol) * 100).toFixed(1)
                : 'N/A';
              console.log(`  ${r.id.slice(0, 8)}... | ${r.mint.slice(0, 8)}... | ${r.status} | PnL: ${pnl}% | ${r.is_paper_trade ? 'PAPER' : 'LIVE'}`);
            }
          }
          break;
        }

        case 'signals': {
          const db = await getDb();
          const result = await db.query(
            `SELECT id, mint, symbol, score_json, discovered_at, expired
             FROM signals WHERE expired = 0
             ORDER BY discovered_at DESC LIMIT 20`
          );
          if (result.rows.length === 0) {
            console.log('[signals] No active signals.');
          } else {
            for (const row of result.rows) {
              const r = row as any;
              const score = JSON.parse(r.score_json || '{}');
              const ago = Math.round((Date.now() - Number(r.discovered_at)) / 60000);
              console.log(`  ${r.symbol || r.mint.slice(0, 8)} | Score: ${score.total || '?'}/100 (${score.conviction || '?'}) | ${ago}m ago`);
            }
          }
          break;
        }

        case 'portfolio': {
          const db = await getDb();
          const open = await db.query(`SELECT COUNT(*) as cnt FROM positions WHERE status NOT IN ('closed', 'failed', 'cancelled')`);
          const closed = await db.query(`SELECT COUNT(*) as cnt, SUM(realized_pnl_sol) as pnl FROM positions WHERE status = 'closed'`);
          const o = open.rows[0] as any;
          const c = closed.rows[0] as any;
          console.log(`[portfolio] Open: ${o.cnt} | Closed: ${c.cnt} | Realized PnL: ${(c.pnl || 0).toFixed(4)} SOL`);
          break;
        }

        case 'denylist': {
          const db = await getDb();
          const result = await db.query(`SELECT address, kind, reason, source FROM denylist ORDER BY added_at DESC LIMIT 20`);
          if (result.rows.length === 0) {
            console.log('[denylist] Empty.');
          } else {
            for (const row of result.rows) {
              const r = row as any;
              console.log(`  ${r.address.slice(0, 12)}... | ${r.kind} | ${r.reason} | via ${r.source}`);
            }
          }
          break;
        }

        case 'quit':
        case 'exit':
          console.log('[cli] Shutting down...');
          rl.close();
          process.emit('SIGINT', 'SIGINT' as any);
          break;

        default:
          if (cmd) console.log(`[cli] Unknown command: ${cmd}. Try: status, positions, signals, portfolio, denylist, quit`);
      }
    } catch (err) {
      console.error(`[cli] Error: ${err}`);
    }
  });
}
