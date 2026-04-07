import { getDb } from '@wildtrade/shared';

export interface DenylistEntry {
  address: string;
  kind: 'creator' | 'mint';
  reason: string;
  addedAt: number;
}

/**
 * Check whether an address (mint or creator) is in the denylist.
 */
export async function isInDenylist(address: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.query<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt FROM denylist WHERE address = $1`,
    [address],
  );
  return (result.rows[0]?.cnt ?? 0) > 0;
}

/**
 * Add an address to the denylist. Uses INSERT ... ON CONFLICT to avoid duplicates.
 */
export async function addToDenylist(
  address: string,
  kind: 'creator' | 'mint',
  reason: string,
  source: string,
): Promise<void> {
  const db = await getDb();
  const now = Date.now();
  await db.query(
    `INSERT INTO denylist (address, kind, reason, added_at, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (address) DO UPDATE
       SET reason = EXCLUDED.reason,
           source = EXCLUDED.source,
           added_at = EXCLUDED.added_at`,
    [address, kind, reason, now, source],
  );
  console.log(`[self-healer] denylist: added ${kind} ${address} reason="${reason}" source="${source}"`);
}

/**
 * Retrieve the full denylist from the database.
 */
export async function getDenylist(): Promise<DenylistEntry[]> {
  const db = await getDb();
  const result = await db.query<{ address: string; kind: string; reason: string; added_at: number }>(
    `SELECT address, kind, reason, added_at FROM denylist ORDER BY added_at DESC`,
  );
  return result.rows.map((row) => ({
    address: row.address,
    kind: row.kind as 'creator' | 'mint',
    reason: row.reason,
    addedAt: row.added_at,
  }));
}
