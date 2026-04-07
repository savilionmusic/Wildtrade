import type { PGlite } from '@electric-sql/pglite';

export async function isInDenylist(db: PGlite, address: string): Promise<boolean> {
  const result = await db.query<{ cnt: number }>(
    'SELECT COUNT(*)::int AS cnt FROM denylist WHERE address = $1',
    [address],
  );
  return (result.rows[0]?.cnt ?? 0) > 0;
}

export async function addToDenylist(
  db: PGlite,
  address: string,
  kind: string,
  reason: string,
  source: string,
): Promise<void> {
  await db.query(
    `INSERT INTO denylist (address, kind, reason, added_at, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (address) DO NOTHING`,
    [address, kind, reason, Date.now(), source],
  );
  console.log(`[alpha-scout] Added ${address} to denylist: kind=${kind} reason=${reason}`);
}
