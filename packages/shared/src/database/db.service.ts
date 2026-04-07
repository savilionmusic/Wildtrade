import { PGlite } from '@electric-sql/pglite';
import { SCHEMA_SQL } from './schema.sql.js';

let instance: PGlite | null = null;

export async function getDb(): Promise<PGlite> {
  if (instance) return instance;
  const dataDir = process.env.PGLITE_DATA_DIR || './.wildtrade-db';
  instance = new PGlite(dataDir);
  await instance.exec(SCHEMA_SQL);
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
