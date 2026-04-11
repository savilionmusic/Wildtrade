import { SqlJsDatabaseAdapter } from '@elizaos/adapter-sqljs';
import initSqlJs from 'sql.js';
import path from 'path';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';

let adapter: SqlJsDatabaseAdapter | null = null;

type SqlJsStatement = {
  bind?: (params: unknown[]) => void;
  step?: () => boolean;
  getAsObject: () => Record<string, unknown>;
  run: (params?: unknown[]) => void;
  free: () => void;
};

type SqlJsBackedAdapter = SqlJsDatabaseAdapter & {
  db: {
    export: () => Uint8Array;
    prepare: (sql: string) => SqlJsStatement;
  };
  createRoom: (roomId?: string) => Promise<string>;
  getRoom: (roomId: string) => Promise<string | null>;
};

function patchRoomHelpers(sqlAdapter: SqlJsBackedAdapter): void {
  const ensureRoomsTable = async (): Promise<void> => {
    const stmt = sqlAdapter.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rooms'"
    );

    try {
      if (stmt.step?.()) return;
      await sqlAdapter.init();
    } finally {
      stmt.free();
    }
  };

  sqlAdapter.getRoom = async (roomId: string): Promise<string | null> => {
    const stmt = sqlAdapter.db.prepare('SELECT id FROM rooms WHERE id = ? LIMIT 1');

    try {
      stmt.bind?.([roomId]);
      if (!stmt.step?.()) return null;
      const room = stmt.getAsObject();
      return typeof room.id === 'string' ? room.id : null;
    } finally {
      stmt.free();
    }
  };

  sqlAdapter.createRoom = async (roomId?: string): Promise<string> => {
    const resolvedRoomId = roomId ?? uuidv4();
    await ensureRoomsTable();

    const stmt = sqlAdapter.db.prepare('INSERT OR IGNORE INTO rooms (id) VALUES (?)');

    try {
      stmt.run([resolvedRoomId]);
    } finally {
      stmt.free();
    }

    return resolvedRoomId;
  };
}

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
  patchRoomHelpers(adapter as SqlJsBackedAdapter);

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
