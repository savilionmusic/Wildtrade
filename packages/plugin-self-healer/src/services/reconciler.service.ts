import { Connection, PublicKey } from '@solana/web3.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb, RECONCILE_INTERVAL_MS } from '@wildtrade/shared';
import type { ReconcileDiscrepancy } from '@wildtrade/shared';
import { getHealthyEndpoint } from './rpc-rotator.service.js';

interface PositionRow {
  id: string;
  mint: string;
  token_balance: string;
  status: string;
}

let reconcileInterval: ReturnType<typeof setInterval> | null = null;
let lastReconcileAt: number | null = null;

/**
 * Get the timestamp of the last reconciliation run.
 */
export function getLastReconcileAt(): number | null {
  return lastReconcileAt;
}

/**
 * Run a full reconciliation pass:
 * 1. Load open/dca_filling/partial_exit positions from DB
 * 2. For each, fetch on-chain token balance
 * 3. Compare and log discrepancies
 */
export async function runReconciliation(): Promise<ReconcileDiscrepancy[]> {
  console.log('[self-healer] reconciler: starting reconciliation run');
  const db = await getDb();
  const rpcUrl = await getHealthyEndpoint();

  if (!rpcUrl) {
    console.log('[self-healer] reconciler: no healthy RPC endpoint, skipping');
    return [];
  }

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  const walletPubkey = new PublicKey(process.env.SOLANA_WALLET_PUBLIC_KEY || '');

  const positionsResult = await db.query<PositionRow>(
    `SELECT id, mint, token_balance, status FROM positions
     WHERE status IN ('open', 'dca_filling', 'partial_exit')`,
  );

  const discrepancies: ReconcileDiscrepancy[] = [];

  for (const pos of positionsResult.rows) {
    try {
      const mintPubkey = new PublicKey(pos.mint);

      const tokenAccounts = await connection.getTokenAccountsByOwner(walletPubkey, {
        mint: mintPubkey,
      });

      let onChainBalance = '0';
      if (tokenAccounts.value.length > 0) {
        // Sum balances across all token accounts for this mint
        let totalBalance = BigInt(0);
        for (const account of tokenAccounts.value) {
          // Token account data: first 64 bytes are mint (32) + owner (32), then 8 bytes amount (little-endian u64)
          const data = account.account.data;
          const amountBytes = data.subarray(64, 72);
          const amount = BigInt(
            amountBytes[0] |
            (amountBytes[1] << 8) |
            (amountBytes[2] << 16) |
            (amountBytes[3] << 24) |
            (amountBytes[4] << 32) |
            (amountBytes[5] << 40) |
            (amountBytes[6] << 48) |
            (amountBytes[7] << 56)
          );
          totalBalance += amount;
        }
        onChainBalance = totalBalance.toString();
      }

      const dbBalance = pos.token_balance || '0';
      const onChainBigInt = BigInt(onChainBalance);
      const dbBigInt = BigInt(dbBalance);
      const delta = onChainBigInt - dbBigInt;

      // Only flag if there is a meaningful difference
      if (delta !== BigInt(0)) {
        let discrepancyType: ReconcileDiscrepancy['type'];

        if (tokenAccounts.value.length === 0) {
          discrepancyType = 'missing_token_account';
        } else if (onChainBigInt === BigInt(0) && dbBigInt > BigInt(0)) {
          discrepancyType = 'orphaned_position';
        } else {
          discrepancyType = 'balance_mismatch';
        }

        const discrepancy: ReconcileDiscrepancy = {
          positionId: pos.id,
          mintAddress: pos.mint,
          type: discrepancyType,
          onChainBalance: onChainBalance,
          dbBalance: dbBalance,
          deltaLamports: delta.toString(),
          detectedAt: Date.now(),
        };

        discrepancies.push(discrepancy);

        // Log to reconcile_log table
        await db.query(
          `INSERT INTO reconcile_log (id, position_id, mint, discrepancy_type, on_chain_balance, db_balance, delta_lamports, detected_at, resolved)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0)`,
          [
            uuidv4(),
            pos.id,
            pos.mint,
            discrepancyType,
            onChainBalance,
            dbBalance,
            delta.toString(),
            Date.now(),
          ],
        );

        console.log(
          `[self-healer] reconciler: discrepancy for position ${pos.id}: ` +
          `type=${discrepancyType} onChain=${onChainBalance} db=${dbBalance} delta=${delta.toString()}`
        );
      }

      // Update last reconciled timestamp on the position
      await db.query(
        `UPDATE positions SET last_reconciled_at = $1 WHERE id = $2`,
        [Date.now(), pos.id],
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`[self-healer] reconciler: error checking position ${pos.id}: ${errMsg}`);
    }
  }

  lastReconcileAt = Date.now();
  console.log(
    `[self-healer] reconciler: completed. ${discrepancies.length} discrepancies found ` +
    `across ${positionsResult.rows.length} positions`
  );

  return discrepancies;
}

/**
 * Start the reconciliation interval.
 */
export function startInterval(): void {
  if (reconcileInterval) return;
  console.log(`[self-healer] reconciler: starting interval every ${RECONCILE_INTERVAL_MS}ms`);
  reconcileInterval = setInterval(() => {
    runReconciliation().catch((err) => {
      console.log(`[self-healer] reconciler: interval error: ${err}`);
    });
  }, RECONCILE_INTERVAL_MS);
}

/**
 * Stop the reconciliation interval.
 */
export function stopInterval(): void {
  if (reconcileInterval) {
    clearInterval(reconcileInterval);
    reconcileInterval = null;
    console.log('[self-healer] reconciler: stopped interval');
  }
}
