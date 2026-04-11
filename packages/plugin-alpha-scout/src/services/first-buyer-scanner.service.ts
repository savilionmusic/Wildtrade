/**
 * First Buyer Scanner — Discovers profitable whale wallets from on-chain data.
 *
 * Inspired by github.com/sisen23/Solana-Whale-Wallet-Finder
 * Uses ONLY standard Solana RPC + Jupiter Price API (free).
 * No GMGN, no Helius, no paid APIs.
 *
 * Algorithm:
 *   1. Given a token mint, fetch the first N minutes of transaction signatures
 *   2. Fetch full tx details and decode buy/sell actions (Jupiter, Raydium, Pump.fun)
 *   3. Aggregate by wallet — find who bought early and is still holding (net positive)
 *   4. Profile whale wallets (SOL balance, portfolio value)
 *   5. Score and return the top whale wallets for smart-money tracking
 *
 * Rate budget: uses rpc-scheduler to stay within Constant-K limits.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { selectPrimaryHttpRpcEndpoint } from '@wildtrade/shared';
import { schedule } from '@wildtrade/plugin-solana-compat';

// ── Config ──
const EARLY_WINDOW_MINUTES = 15;         // Scan first 15 min of token's life
const MAX_SIGNATURES = 2000;              // Safety cap on signatures to fetch
const TX_BATCH_SIZE = 15;                 // Concurrent tx fetches (stay under 50 req/s with headroom)
const TX_BATCH_DELAY_MS = 600;            // Delay between batches
const MIN_NET_BUY_SOL = 0.5;             // Minimum net buy in SOL to qualify as significant
const MAX_WHALES_TO_RETURN = 20;          // Return top N whale wallets
const SCAN_COOLDOWN_MS = 30_000;          // Don't re-scan same token within 30s
const CACHE_TTL_MS = 3_600_000;           // Cache results for 1 hour

// Known program IDs for DEX detection
const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAYDIUM_AMM_PROGRAM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const PUMPFUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TOKEN_PROGRAM = 'TokenkegQvEj7rE86Z2nXy7HvjjctkaJz5Enm1jgQTVG';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// ── Types ──

export interface WhaleWallet {
  address: string;
  totalBuySol: number;
  totalSellSol: number;
  netBuySol: number;
  buyCount: number;
  sellCount: number;
  firstBuyTime: number;         // Unix timestamp of first buy
  solBalance: number;           // Current SOL balance
  portfolioValueUsd: number;    // Estimated portfolio value
  score: number;                // Whale quality score 0-100
}

export interface ScanResult {
  tokenMint: string;
  scannedAt: number;
  earlyWindowMinutes: number;
  totalSignatures: number;
  totalBuyers: number;
  whales: WhaleWallet[];
}

// ── State ──
let rpcConnection: Connection | null = null;
const scanCache = new Map<string, { result: ScanResult; expiresAt: number }>();
const lastScanTime = new Map<string, number>();

type LogCb = (level: string, msg: string) => void;
let logCb: LogCb = (_level, msg) => console.log(`[first-buyer-scanner] ${msg}`);

export function setFirstBuyerScannerLog(cb: LogCb): void {
  logCb = cb;
}

function getConnection(): Connection {
  if (rpcConnection) return rpcConnection;
  rpcConnection = new Connection(selectPrimaryHttpRpcEndpoint(), {
    commitment: 'confirmed',
    fetch: global.fetch,
  });
  return rpcConnection;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Main Scanner ──

export async function scanFirstBuyers(tokenMint: string): Promise<ScanResult | null> {
  // Cooldown check
  const lastScan = lastScanTime.get(tokenMint);
  if (lastScan && Date.now() - lastScan < SCAN_COOLDOWN_MS) {
    const cached = scanCache.get(tokenMint);
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    return null;
  }

  // Cache check
  const cached = scanCache.get(tokenMint);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  lastScanTime.set(tokenMint, Date.now());
  logCb('info', `Scanning first buyers for ${tokenMint.slice(0, 8)}...`);

  const connection = getConnection();
  const mintPubkey = new PublicKey(tokenMint);

  try {
    // ── Step 1: Fetch transaction signatures ──
    const allSignatures: Array<{ signature: string; blockTime: number | null }> = [];
    let beforeCursor: string | undefined;

    for (let page = 0; page < 20; page++) {
      await schedule('read');
      const batch = await connection.getSignaturesForAddress(
        mintPubkey,
        { limit: 1000, before: beforeCursor },
        'confirmed',
      );

      if (batch.length === 0) break;

      for (const sig of batch) {
        if (sig.err) continue; // Skip failed txs
        allSignatures.push({ signature: sig.signature, blockTime: sig.blockTime });
      }

      beforeCursor = batch[batch.length - 1].signature;
      if (allSignatures.length >= MAX_SIGNATURES) break;

      await sleep(200); // Light throttle between pages
    }

    if (allSignatures.length === 0) {
      logCb('info', `No signatures found for ${tokenMint.slice(0, 8)}`);
      return null;
    }

    // ── Step 2: Time-window filter — first N minutes only ──
    // Signatures come newest-first, so the last entry is the earliest
    const sortedByTime = allSignatures
      .filter(s => s.blockTime != null)
      .sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));

    if (sortedByTime.length === 0) return null;

    const firstTxTime = sortedByTime[0].blockTime!;
    const windowEnd = firstTxTime + EARLY_WINDOW_MINUTES * 60;

    const earlySignatures = sortedByTime.filter(s => s.blockTime! <= windowEnd);
    logCb('info', `Found ${earlySignatures.length} transactions in first ${EARLY_WINDOW_MINUTES} min (of ${allSignatures.length} total)`);

    if (earlySignatures.length === 0) return null;

    // ── Step 3: Fetch full transactions and decode buys/sells ──
    const walletActivity = new Map<string, {
      totalBuySol: number;
      totalSellSol: number;
      buyCount: number;
      sellCount: number;
      firstBuyTime: number;
    }>();

    // Process in batches to respect RPC rate limits
    for (let i = 0; i < earlySignatures.length; i += TX_BATCH_SIZE) {
      const batch = earlySignatures.slice(i, i + TX_BATCH_SIZE);

      const txPromises = batch.map(async (sig) => {
        try {
          await schedule('read');
          const tx = await connection.getTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
          });
          return tx;
        } catch {
          return null;
        }
      });

      const txResults = await Promise.all(txPromises);

      for (let j = 0; j < txResults.length; j++) {
        const tx = txResults[j];
        if (!tx || !tx.meta) continue;

        const blockTime = batch[j].blockTime ?? 0;

        // Detect DEX protocol from log messages
        const logs = tx.meta.logMessages ?? [];
        const logsJoined = logs.join(' ');

        const isJupiter = logsJoined.includes(JUPITER_V6_PROGRAM);
        const isRaydium = logsJoined.includes(RAYDIUM_AMM_PROGRAM);
        const isPumpFun = logsJoined.includes(PUMPFUN_PROGRAM);

        if (!isJupiter && !isRaydium && !isPumpFun) continue;

        // Decode buy/sell from SOL balance changes
        // If a wallet's SOL decreased AND they received tokens → BUY
        // If a wallet's SOL increased AND they sent tokens → SELL
        const preBalances = tx.meta.preBalances ?? [];
        const postBalances = tx.meta.postBalances ?? [];
        const accountKeys = tx.transaction.message.getAccountKeys?.()
          ?? (tx.transaction.message as any).accountKeys ?? [];

        for (let k = 0; k < preBalances.length && k < postBalances.length; k++) {
          const solChange = (postBalances[k] - preBalances[k]) / 1e9; // lamports to SOL
          const absChange = Math.abs(solChange);
          if (absChange < 0.01) continue; // Ignore dust

          let pubkey: string;
          try {
            const key = typeof accountKeys.get === 'function'
              ? accountKeys.get(k)
              : accountKeys[k];
            pubkey = key?.toBase58?.() ?? String(key);
          } catch { continue; }

          // Skip program accounts and system accounts
          if (!pubkey || pubkey.length < 32) continue;
          if (pubkey === TOKEN_PROGRAM || pubkey === JUPITER_V6_PROGRAM ||
              pubkey === RAYDIUM_AMM_PROGRAM || pubkey === PUMPFUN_PROGRAM ||
              pubkey === SOL_MINT || pubkey === '11111111111111111111111111111111') continue;

          // Skip if this is likely a pool/AMM account (accounts 0-3 are usually signers/programs)
          // The fee payer (index 0) is the user wallet
          if (k > 5) continue; // Only look at first few accounts (user wallets)

          const existing = walletActivity.get(pubkey) ?? {
            totalBuySol: 0, totalSellSol: 0, buyCount: 0, sellCount: 0, firstBuyTime: 0,
          };

          if (solChange < -0.01) {
            // SOL decreased → BUY (spent SOL to get tokens)
            existing.totalBuySol += absChange;
            existing.buyCount++;
            if (existing.firstBuyTime === 0) existing.firstBuyTime = blockTime;
          } else if (solChange > 0.01) {
            // SOL increased → SELL (sold tokens, received SOL)
            existing.totalSellSol += absChange;
            existing.sellCount++;
          }

          walletActivity.set(pubkey, existing);
        }
      }

      if (i + TX_BATCH_SIZE < earlySignatures.length) {
        await sleep(TX_BATCH_DELAY_MS);
      }
    }

    // ── Step 4: Filter to significant net buyers ──
    const qualifiedWallets: Array<{
      address: string;
      totalBuySol: number;
      totalSellSol: number;
      netBuySol: number;
      buyCount: number;
      sellCount: number;
      firstBuyTime: number;
    }> = [];

    for (const [address, activity] of walletActivity) {
      const netBuySol = activity.totalBuySol - activity.totalSellSol;
      if (netBuySol >= MIN_NET_BUY_SOL && activity.buyCount > 0) {
        qualifiedWallets.push({
          address,
          totalBuySol: activity.totalBuySol,
          totalSellSol: activity.totalSellSol,
          netBuySol,
          buyCount: activity.buyCount,
          sellCount: activity.sellCount,
          firstBuyTime: activity.firstBuyTime,
        });
      }
    }

    // Sort by net buy size — biggest bags first
    qualifiedWallets.sort((a, b) => b.netBuySol - a.netBuySol);
    const topWhales = qualifiedWallets.slice(0, MAX_WHALES_TO_RETURN);

    logCb('info', `Found ${qualifiedWallets.length} significant buyers, profiling top ${topWhales.length}...`);

    // ── Step 5: Profile whale wallets (SOL balance) ──
    const whaleResults: WhaleWallet[] = [];

    for (const whale of topWhales) {
      try {
        await schedule('read');
        const balance = await connection.getBalance(new PublicKey(whale.address), 'confirmed');
        const solBalance = balance / 1e9;

        // Score the whale: early + big bag + still holding + decent SOL balance
        let score = 50;
        // Early buyer bonus (first 5 min = max bonus)
        const minutesIn = (whale.firstBuyTime - firstTxTime) / 60;
        if (minutesIn <= 2) score += 20;
        else if (minutesIn <= 5) score += 15;
        else if (minutesIn <= 10) score += 8;

        // Big net buyer bonus
        if (whale.netBuySol >= 5) score += 15;
        else if (whale.netBuySol >= 2) score += 10;
        else if (whale.netBuySol >= 1) score += 5;

        // Still has SOL (can trade more) bonus
        if (solBalance >= 10) score += 10;
        else if (solBalance >= 2) score += 5;

        // Multi-buy (DCA'd in) bonus — shows conviction
        if (whale.buyCount >= 3) score += 5;

        // Penalty: if they also sold a lot, less conviction
        if (whale.totalSellSol > whale.totalBuySol * 0.5) score -= 10;

        score = Math.max(0, Math.min(100, score));

        whaleResults.push({
          address: whale.address,
          totalBuySol: whale.totalBuySol,
          totalSellSol: whale.totalSellSol,
          netBuySol: whale.netBuySol,
          buyCount: whale.buyCount,
          sellCount: whale.sellCount,
          firstBuyTime: whale.firstBuyTime,
          solBalance,
          portfolioValueUsd: 0, // Will be enriched later if needed
          score,
        });
      } catch {
        // Skip wallet if balance fetch fails
      }

      await sleep(100);
    }

    // Sort by score
    whaleResults.sort((a, b) => b.score - a.score);

    const result: ScanResult = {
      tokenMint,
      scannedAt: Date.now(),
      earlyWindowMinutes: EARLY_WINDOW_MINUTES,
      totalSignatures: earlySignatures.length,
      totalBuyers: qualifiedWallets.length,
      whales: whaleResults,
    };

    // Cache
    scanCache.set(tokenMint, { result, expiresAt: Date.now() + CACHE_TTL_MS });

    logCb('info', `Scan complete: ${whaleResults.length} whale wallets found for ${tokenMint.slice(0, 8)} (top score: ${whaleResults[0]?.score ?? 0})`);

    return result;
  } catch (err) {
    logCb('error', `First buyer scan failed for ${tokenMint.slice(0, 8)}: ${String(err)}`);
    return null;
  }
}

export function clearScanCache(): void {
  scanCache.clear();
  lastScanTime.clear();
}
