import { Connection, VersionedTransaction, type Keypair } from '@solana/web3.js';

const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://quote-api.jup.ag/v6';
const DEFAULT_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || '300');
const TX_CONFIRM_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
  contextSlot?: number;
}

export interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface JupiterPriceData {
  id: string;
  mintSymbol: string;
  vsToken: string;
  vsTokenSymbol: string;
  price: number;
}

export interface SwapResult {
  signature: string;
  inputAmount: string;
  outputAmount: string;
  confirmed: boolean;
}

// ── RPC Connection (cached) ──
let rpcConnection: Connection | null = null;

function getRpcConnection(): Connection {
  if (rpcConnection) return rpcConnection;
  const rawRpc = process.env.SOLANA_RPC_CONSTANTK
    || process.env.SOLANA_RPC_HELIUS
    || process.env.SOLANA_RPC_QUICKNODE
    || 'https://api.mainnet-beta.solana.com';
  // Normalize: if user pasted a wss:// URL, convert to https:// for HTTP RPC
  let rpcUrl = rawRpc.trim();
  if (!rpcUrl.includes('://')) rpcUrl = `https://${rpcUrl}`;
  rpcUrl = rpcUrl.startsWith('wss://') ? rpcUrl.replace('wss://', 'https://') : rpcUrl.startsWith('ws://') ? rpcUrl.replace('ws://', 'http://') : rpcUrl;
  rpcConnection = new Connection(rpcUrl, { commitment: 'confirmed', fetch: global.fetch });
  console.log(`[jupiter] RPC connected: ${rpcUrl.slice(0, 40)}...`);
  return rpcConnection;
}

export async function getQuote(
  inputMint: string,
  outputMint: string,
  amount: string,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Promise<JupiterQuoteResponse> {
  const url = new URL(`${JUPITER_API_BASE}/quote`);
  url.searchParams.set('inputMint', inputMint);
  url.searchParams.set('outputMint', outputMint);
  url.searchParams.set('amount', amount);
  url.searchParams.set('slippageBps', String(slippageBps));

  console.log(`[jupiter] Quote: ${inputMint.slice(0, 8)} -> ${outputMint.slice(0, 8)}, amount=${amount}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[jupiter] Quote failed (${response.status}): ${body}`);
  }

  const quote = (await response.json()) as JupiterQuoteResponse;
  console.log(`[jupiter] Quote: out=${quote.outAmount}, impact=${quote.priceImpactPct}%`);
  return quote;
}

export async function executeSwap(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
): Promise<JupiterSwapResponse> {
  console.log(`[jupiter] Getting swap transaction for ${userPublicKey.slice(0, 8)}...`);

  const response = await fetch(`${JUPITER_API_BASE}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[jupiter] Swap API failed (${response.status}): ${body}`);
  }

  const swapResult = (await response.json()) as JupiterSwapResponse;
  console.log(`[jupiter] Swap tx received, blockHeight=${swapResult.lastValidBlockHeight}`);
  return swapResult;
}

/**
 * Sign, send, and confirm a Jupiter swap transaction on-chain.
 * This is the missing piece that makes live trading work.
 */
export async function signAndSendSwap(
  swapResponse: JupiterSwapResponse,
  keypair: Keypair,
): Promise<SwapResult> {
  const connection = getRpcConnection();

  // Deserialize the versioned transaction
  const txBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
  const transaction = VersionedTransaction.deserialize(txBuf);

  // Sign with wallet keypair
  transaction.sign([keypair]);
  const rawTx = transaction.serialize();

  console.log(`[jupiter] Sending signed transaction...`);

  let signature = '';
  let confirmed = false;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 2,
        preflightCommitment: 'confirmed',
      });

      console.log(`[jupiter] Tx sent: ${signature}`);

      // Wait for confirmation
      const latestBlockhash = await connection.getLatestBlockhash('confirmed');
      const confirmation = await connection.confirmTransaction(
        {
          signature,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: swapResponse.lastValidBlockHeight,
        },
        'confirmed',
      );

      if (confirmation.value.err) {
        console.log(`[jupiter] Tx confirmed with error: ${JSON.stringify(confirmation.value.err)}`);
        throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
      }

      confirmed = true;
      console.log(`[jupiter] Tx confirmed: ${signature}`);
      break;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.log(`[jupiter] Attempt ${attempt + 1} failed, retrying: ${String(err)}`);
        await new Promise(r => setTimeout(r, 2000));
      } else {
        console.log(`[jupiter] All attempts failed: ${String(err)}`);
        throw err;
      }
    }
  }

  return {
    signature,
    inputAmount: '',
    outputAmount: '',
    confirmed,
  };
}

/**
 * Full swap pipeline: quote → swap API → sign → send → confirm.
 * Returns the transaction signature and amounts.
 */
export async function executeFullSwap(
  inputMint: string,
  outputMint: string,
  amountLamports: string,
  keypair: Keypair,
): Promise<SwapResult> {
  const quote = await getQuote(inputMint, outputMint, amountLamports);
  const swapResponse = await executeSwap(quote, keypair.publicKey.toBase58());
  const result = await signAndSendSwap(swapResponse, keypair);

  result.inputAmount = quote.inAmount;
  result.outputAmount = quote.outAmount;

  return result;
}

export async function getPrice(
  mints: string[],
): Promise<Record<string, JupiterPriceData>> {
  if (mints.length === 0) return {};

  const ids = mints.join(',');
  const url = `https://price.jup.ag/v6/price?ids=${ids}`;

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[jupiter] Price fetch failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data: Record<string, JupiterPriceData> };
  return json.data;
}
