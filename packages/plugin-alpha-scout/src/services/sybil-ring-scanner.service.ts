import { Connection, PublicKey } from '@solana/web3.js';
import { selectPrimaryHttpRpcEndpoint } from '@wildtrade/shared';

const HTTP_RPC = selectPrimaryHttpRpcEndpoint();

const connection = new Connection(HTTP_RPC, { commitment: 'confirmed', fetch: global.fetch });
const RPC_DELAY_MS = 250; // Respect Constant-K 5/sec limit
const MAX_BUYERS_TO_CHECK = 10; // Keep it low to avoid massive RPC usage per token

// Cache for wallet -> funder
const funderCache = new Map<string, string>();

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SybilRingReport {
  mint: string;
  totalBuyersChecked: number;
  funderClusters: Record<string, string[]>;
  largestClusterSize: number;
  isInsiderCabal: boolean;
}

export async function scanForSybilRings(mint: string, logCb: (msg: string) => void): Promise<SybilRingReport | null> {
  try {
    logCb(`[sybil-scanner] Starting Sybil Scan on ${mint} using Constant-K (Safe Mode)`);
    
    // 1. Get earliest signatures for the token mint
    const mintPubkey = new PublicKey(mint);
    await sleep(RPC_DELAY_MS);
    const signatures = await connection.getSignaturesForAddress(mintPubkey, { limit: 50 });
    
    if (signatures.length === 0) return null;

    // Sort by blockTime ascending to get the earliest buyers
    signatures.sort((a, b) => (a.blockTime || 0) - (b.blockTime || 0));

    const earlyBuyers = new Set<string>();

    // 2. Extract buyers from the first few transactions
    logCb(`[sybil-scanner] Fetching earliest txs to find buyers...`);
    for (const sigInfo of signatures.slice(0, MAX_BUYERS_TO_CHECK * 2)) {
      if (earlyBuyers.size >= MAX_BUYERS_TO_CHECK) break;
      
      await sleep(RPC_DELAY_MS);
      const tx = await connection.getTransaction(sigInfo.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });

      if (!tx || !tx.transaction.message.staticAccountKeys) continue;

      // Simplistic buyer heuristic: the fee payer is usually the buyer in early DEX txs
      const feePayer = tx.transaction.message.staticAccountKeys[0].toBase58();
      
      // Basic filter to ignore known programs
      if (feePayer.includes('Pump') || feePayer.includes('Raydium')) continue;
      
      earlyBuyers.add(feePayer);
    }

    const buyers = Array.from(earlyBuyers);
    logCb(`[sybil-scanner] Identified ${buyers.length} early buyers for ${mint}. Tracing funders...`);

    const funderClusters: Record<string, string[]> = {};

    // 3. Trace the funder for each buyer
    for (const buyer of buyers) {
      let funder = funderCache.get(buyer);
      
      if (!funder) {
        try {
          const buyerPubkey = new PublicKey(buyer);
          await sleep(RPC_DELAY_MS);
          const buyerSigs = await connection.getSignaturesForAddress(buyerPubkey, { limit: 10 }); // Get earliest
          
          if (buyerSigs.length > 0) {
            // Get the earliest signature
            const oldestSig = buyerSigs[buyerSigs.length - 1];
            await sleep(RPC_DELAY_MS);
            const oldestTx = await connection.getTransaction(oldestSig.signature, {
              maxSupportedTransactionVersion: 0,
              commitment: 'confirmed'
            });

            if (oldestTx && oldestTx.meta && oldestTx.transaction.message.staticAccountKeys) {
              // Find who sent SOL to this wallet in its first transaction
              // This is a complex heuristic, but a simple approximation is looking for account index 0 or a known CEX
              // Here we just pick the first account that isn't the buyer itself
              const accounts = oldestTx.transaction.message.staticAccountKeys.map(k => k.toBase58());
              funder = accounts.find(a => a !== buyer && !a.includes('Sysvar')) || 'unknown';
            } else {
              funder = 'unknown';
            }
          } else {
            funder = 'unknown';
          }
          
          if (funder !== 'unknown') {
            funderCache.set(buyer, funder);
          }
        } catch (err) {
          funder = 'error';
        }
      }

      if (funder) {
        if (!funderClusters[funder]) funderClusters[funder] = [];
        funderClusters[funder].push(buyer);
      }
    }

    let largestClusterSize = 0;
    for (const funder in funderClusters) {
      if (funderClusters[funder].length > largestClusterSize) {
        largestClusterSize = funderClusters[funder].length;
      }
    }

    let isInsiderCabal = false;
    let reportLog = `\n📊 --- DEGEN-SCANNER REPORT FOR ${mint.slice(0,6)} --- 📊\n`;
    reportLog += `Total Buyers Checked: ${buyers.length}\n`;

    for (const funder in funderClusters) {
      const cluster = funderClusters[funder];
      if (cluster.length > largestClusterSize) {
        largestClusterSize = cluster.length;
      }
      if (cluster.length >= 3) {
        isInsiderCabal = true;
      }
      reportLog += `📍 Funder: ${funder.slice(0, 8)}... funded ${cluster.length} wallets: [${cluster.map(w => w.slice(0,4)).join(', ')}]\n`;
    }

    reportLog += `🚨 Cabal Detected: ${isInsiderCabal ? 'YES' : 'NO'} (Largest Cluster: ${largestClusterSize})\n`;
    logCb(reportLog);

    return {
      mint,
      totalBuyersChecked: buyers.length,
      funderClusters,
      largestClusterSize,
      isInsiderCabal
    };

  } catch (err) {
    logCb(`[sybil-scanner] Error scanning ${mint}: ${String(err)}`);
    return null;
  }
}
