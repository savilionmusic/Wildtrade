const JUPITER_API_BASE = process.env.JUPITER_API_BASE || 'https://quote-api.jup.ag/v6';
const DEFAULT_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || '300');

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

  console.log(`[smart-trader] Jupiter quote: ${inputMint} -> ${outputMint}, amount=${amount}`);

  const response = await fetch(url.toString());
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[smart-trader] Jupiter quote failed (${response.status}): ${body}`);
  }

  const quote = (await response.json()) as JupiterQuoteResponse;
  console.log(`[smart-trader] Quote received: outAmount=${quote.outAmount}, priceImpact=${quote.priceImpactPct}%`);
  return quote;
}

export async function executeSwap(
  quoteResponse: JupiterQuoteResponse,
  userPublicKey: string,
): Promise<JupiterSwapResponse> {
  console.log(`[smart-trader] Executing swap for ${userPublicKey}`);

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
    throw new Error(`[smart-trader] Jupiter swap failed (${response.status}): ${body}`);
  }

  const swapResult = (await response.json()) as JupiterSwapResponse;
  console.log(`[smart-trader] Swap transaction received, lastValidBlockHeight=${swapResult.lastValidBlockHeight}`);
  return swapResult;
}

export async function getPrice(
  mints: string[],
): Promise<Record<string, JupiterPriceData>> {
  if (mints.length === 0) return {};

  const ids = mints.join(',');
  const url = `https://price.jup.ag/v6/price?ids=${ids}`;

  console.log(`[smart-trader] Fetching prices for ${mints.length} token(s)`);

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`[smart-trader] Jupiter price fetch failed (${response.status}): ${body}`);
  }

  const json = (await response.json()) as { data: Record<string, JupiterPriceData> };
  return json.data;
}
