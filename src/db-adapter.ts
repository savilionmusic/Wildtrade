import { SqlJsDatabaseAdapter } from '@elizaos/adapter-sqljs';
import initSqlJs from 'sql.js';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

let adapter: SqlJsDatabaseAdapter | null = null;

export async function getElizaAdapter(): Promise<SqlJsDatabaseAdapter> {
  if (adapter) return adapter;

  const dbDir = process.env.PGLITE_DATA_DIR || './.wildtrade-db';
  mkdirSync(dbDir, { recursive: true });
  const dbPath = path.resolve(dbDir, 'eliza.db');

  const SQL = await initSqlJs();

  let db;
  if (existsSync(dbPath)) {
    try {
      const buffer = readFileSync(dbPath);
      db = new SQL.Database(buffer);
    } catch {
      db = new SQL.Database();
    }
  } else {
    db = new SQL.Database();
  }

  adapter = new SqlJsDatabaseAdapter(db as any);
  await adapter.init();

  // Periodically save to disk
  setInterval(() => {
    try {
      if (adapter) {
        const data = (adapter as any).db.export();
        writeFileSync(dbPath, Buffer.from(data));
      }
    } catch { /* ignore save errors */ }
  }, 60_000);

  return adapter;
}
