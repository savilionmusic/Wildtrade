import type { IAgentRuntime } from '@elizaos/core';
import { elizaLogger, Service, ServiceType } from '@elizaos/core';
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
  MintLayout,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackAccount,
} from '@solana/spl-token';
import type { AccountInfo, Context, ParsedAccountData } from '@solana/web3.js';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

import { PROVIDER_CONFIG, SOLANA_SERVICE_NAME, SOLANA_WALLET_DATA_CACHE_KEY } from './constants.js';
import { getWalletKey } from './keypair-utils.js';
import { schedule } from './rpc-scheduler.js';
import type {
  CacheWrapper,
  DexScreenerPair,
  DexScreenerTokenResponse,
  Item,
  JupiterPriceResponse,
  MintBalance,
  Prices,
  TokenAccountEntry,
  WalletPortfolio,
} from './types.js';

type KeyedParsedTokenAccount = {
  pubkey: PublicKey;
  account: AccountInfo<ParsedAccountData>;
};

type ParsedTokenAccountsResponse = Awaited<
  ReturnType<Connection['getParsedTokenAccountsByOwner']>
>;

const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export class SolanaService extends Service {
  private static _instance: SolanaService | null = null;

  static get serviceType(): ServiceType {
    return SOLANA_SERVICE_NAME as unknown as ServiceType;
  }

  get serviceType(): ServiceType {
    return SOLANA_SERVICE_NAME as unknown as ServiceType;
  }

  public readonly capabilityDescription =
    'Interact with the Solana blockchain via Constant-K RPC, DexScreener prices, wallet portfolio, Token-2022, batch RPC, WebSocket subscriptions';

  private runtime!: IAgentRuntime;
  private lastUpdate = 0;
  private readonly UPDATE_INTERVAL = 2 * 60_000;
  private connection!: Connection;

  private _publicKey: PublicKey | null = null;
  private _keypair: Keypair | null = null;
  private _publicKeyPromise: Promise<PublicKey | null> | null = null;
  private _keypairPromise: Promise<Keypair | null> | null = null;

  private subscriptions: Map<string, number> = new Map();
  private decimalsCache = new Map<string, number>([
    ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], // USDC
    ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 6], // USDT
    ['So11111111111111111111111111111111111111112', 9],     // SOL
  ]);

  static readonly LAMPORTS2SOL = 1 / LAMPORTS_PER_SOL;
  static readonly SOL2LAMPORTS = LAMPORTS_PER_SOL;

  static getInstance<T extends Service>(): T {
    if (!SolanaService._instance) {
      SolanaService._instance = new SolanaService();
    }
    return SolanaService._instance as unknown as T;
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    const rpcUrl = this.resolveRpcUrl();
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    elizaLogger.info(
      `[SolanaService] RPC: ${rpcUrl.substring(0, 50)}${rpcUrl.length > 50 ? '...' : ''} (Constant-K optimized, rate-limited)`,
    );
  }

  // ── RPC Resolution ──────────────────────────────────────────────────────
  // Priority: SOLANA_RPC_URL > SOLANA_RPC_HTTP > SOLANA_RPC_CONSTANTK > default

  private resolveRpcUrl(): string {
    const explicit = this.runtime.getSetting('SOLANA_RPC_URL');
    if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit;

    // Check env directly for Constant-K variants (set via .env, not character secrets)
    const constantK = process.env.SOLANA_RPC_HTTP || process.env.SOLANA_RPC_CONSTANTK;
    if (typeof constantK === 'string' && constantK.startsWith('http')) return constantK;

    return PROVIDER_CONFIG.DEFAULT_RPC;
  }

  /**
   * Reconnect to a different RPC endpoint (e.g., after RPC rotation).
   */
  public reconnect(rpcUrl: string): void {
    this.connection = new Connection(rpcUrl, { commitment: 'confirmed' });
    elizaLogger.info(`[SolanaService] Reconnected to ${rpcUrl.substring(0, 50)}...`);
  }

  public getConnection(): Connection {
    return this.connection;
  }

  // ── Key Management ──────────────────────────────────────────────────────

  private async ensurePublicKey(): Promise<PublicKey | null> {
    if (this._publicKey) return this._publicKey;
    if (this._publicKeyPromise) return this._publicKeyPromise;

    this._publicKeyPromise = (async () => {
      try {
        const result = await getWalletKey(this.runtime, false);
        this._publicKey = result.publicKey ?? null;
        return this._publicKey;
      } catch {
        return null;
      } finally {
        this._publicKeyPromise = null;
      }
    })();

    return this._publicKeyPromise;
  }

  private async ensureKeypair(): Promise<Keypair | null> {
    if (this._keypair) return this._keypair;
    if (this._keypairPromise) return this._keypairPromise;

    this._keypairPromise = (async () => {
      try {
        const result = await getWalletKey(this.runtime, true);
        this._keypair = result.keypair ?? null;
        if (result.publicKey) this._publicKey = result.publicKey;
        return this._keypair;
      } catch {
        return null;
      } finally {
        this._keypairPromise = null;
      }
    })();

    return this._keypairPromise;
  }

  public async getPublicKey(): Promise<PublicKey | null> {
    return this.ensurePublicKey();
  }

  public async getWalletKeypair(): Promise<Keypair> {
    const kp = await this.ensureKeypair();
    if (!kp) throw new Error('Failed to get wallet keypair');
    return kp;
  }

  public reloadKeys(): void {
    this._publicKey = null;
    this._keypair = null;
    this._publicKeyPromise = null;
    this._keypairPromise = null;
  }

  // ── Batch RPC (rate-limited for Constant-K) ─────────────────────────────

  async batchGetMultipleAccountsInfo(
    pubkeys: PublicKey[],
    _label = '',
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const CHUNK = 100;
    const results: (AccountInfo<Buffer> | null)[] = [];

    for (let i = 0; i < pubkeys.length; i += CHUNK) {
      const chunk = pubkeys.slice(i, i + CHUNK);
      await schedule('getMultipleAccounts');
      const infos = await this.connection.getMultipleAccountsInfo(chunk);
      results.push(...infos);
    }

    return results;
  }

  // ── Address Utilities ───────────────────────────────────────────────────

  public isValidAddress(address: string, onCurveOnly = false): boolean {
    try {
      const pk = new PublicKey(address);
      if (onCurveOnly) return PublicKey.isOnCurve(pk.toBytes());
      return true;
    } catch {
      return false;
    }
  }

  public validateAddress(address: string | undefined): boolean {
    if (!address) return false;
    return this.isValidAddress(address);
  }

  private static readonly TOKEN_ACCOUNT_DATA_LENGTH = 165;
  private static readonly TOKEN_MINT_DATA_LENGTH = 82;

  async getAddressType(address: string): Promise<string> {
    const types = await this.getAddressesTypes([address]);
    return types[address] ?? 'Unknown';
  }

  async getAddressesTypes(addresses: string[]): Promise<Record<string, string>> {
    const pubkeys = addresses.map((a) => new PublicKey(a));
    const infos = await this.batchGetMultipleAccountsInfo(pubkeys, 'getAddressesTypes');

    const out: Record<string, string> = {};
    for (let i = 0; i < addresses.length; i++) {
      const addr = addresses[i];
      if (!addr) continue;
      const info = infos[i];
      if (!info) { out[addr] = 'Account does not exist'; continue; }
      const len = info.data.length;
      if (len === 0) out[addr] = 'Wallet';
      else if (len === SolanaService.TOKEN_ACCOUNT_DATA_LENGTH) out[addr] = 'Token Account';
      else if (len === SolanaService.TOKEN_MINT_DATA_LENGTH) out[addr] = 'Token';
      else out[addr] = `Unknown (Data length: ${len})`;
    }
    return out;
  }

  // ── Signature Verification ──────────────────────────────────────────────

  verifySignature({
    publicKeyBase58,
    message,
    signatureBase64,
  }: {
    message: string;
    signatureBase64: string;
    publicKeyBase58: string;
  }): boolean {
    try {
      const publicKeyBytes = bs58.decode(publicKeyBase58);
      const messageBytes = new TextEncoder().encode(message);
      const signatureBytes = Buffer.from(signatureBase64, 'base64');
      return nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    } catch {
      return false;
    }
  }

  // ── Decimal Cache ───────────────────────────────────────────────────────

  async getDecimal(mint: PublicKey): Promise<number> {
    const cached = this.decimalsCache.get(mint.toBase58());
    if (cached !== undefined) return cached;

    await schedule('read');
    const info = await this.connection.getAccountInfo(mint);
    if (!info?.data) return 0;

    const mintData = MintLayout.decode(info.data);
    const decimals = mintData.decimals;
    this.decimalsCache.set(mint.toBase58(), decimals);
    return decimals;
  }

  // ── Circulating Supply ──────────────────────────────────────────────────

  async getCirculatingSupply(mint: string): Promise<number> {
    const pk = new PublicKey(mint);
    await schedule('read');
    const largestAccounts = await this.connection.getTokenLargestAccounts(pk, 'confirmed');

    let circulating = 0;
    for (const account of largestAccounts.value) {
      const info = account as { uiAmount: number | null; amount: string } & Record<string, unknown>;
      if (!info.uiAmount) continue;
      circulating += info.uiAmount;
    }

    return circulating;
  }

  async getCirculatingSupplies(mints: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const mint of mints) {
      try {
        out[mint] = await this.getCirculatingSupply(mint);
      } catch {
        out[mint] = 0;
      }
    }
    return out;
  }

  // ── DexScreener Price Fetching (no API key required) ──────────────────

  private priceFetchLock = false;
  private priceCache = new Map<string, { price: number; ts: number }>();

  /**
   * Fetch token price via DexScreener (free, no API key).
   * Falls back to Jupiter Price API v2 if DexScreener misses.
   */
  async fetchTokenPrice(mintAddress: string): Promise<number | null> {
    // Check in-memory price cache first (30s TTL)
    const cached = this.priceCache.get(mintAddress);
    if (cached && Date.now() - cached.ts < PROVIDER_CONFIG.PRICE_CACHE_TTL_MS) {
      return cached.price;
    }

    // Try DexScreener first
    try {
      const res = await fetch(
        `${PROVIDER_CONFIG.DEXSCREENER_API}/latest/dex/tokens/${mintAddress}`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.ok) {
        const data = (await res.json()) as DexScreenerTokenResponse;
        const solanaPairs = (data.pairs ?? []).filter((p: DexScreenerPair) => p.chainId === 'solana');
        if (solanaPairs.length > 0) {
          // Pick highest liquidity pair for most accurate price
          const bestPair = solanaPairs.reduce((a: DexScreenerPair, b: DexScreenerPair) =>
            (b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a, solanaPairs[0]!);
          const price = parseFloat(bestPair.priceUsd);
          if (!isNaN(price) && price > 0) {
            this.priceCache.set(mintAddress, { price, ts: Date.now() });
            return price;
          }
        }
      }
    } catch (e) {
      elizaLogger.warn(`[SolanaService] DexScreener price error for ${mintAddress}: ${e}`);
    }

    // Fallback: Jupiter Price API v2 (free, no key)
    try {
      const res = await fetch(
        `${PROVIDER_CONFIG.JUPITER_PRICE_API}?ids=${mintAddress}`,
        { headers: { Accept: 'application/json' } },
      );
      if (res.ok) {
        const data = (await res.json()) as JupiterPriceResponse;
        const entry = data.data?.[mintAddress];
        if (entry?.price) {
          const price = parseFloat(entry.price);
          if (!isNaN(price) && price > 0) {
            this.priceCache.set(mintAddress, { price, ts: Date.now() });
            return price;
          }
        }
      }
    } catch (e) {
      elizaLogger.warn(`[SolanaService] Jupiter price error for ${mintAddress}: ${e}`);
    }

    return null;
  }

  /**
   * Batch fetch prices for multiple mints via Jupiter Price API v2.
   * Much more efficient than individual DexScreener calls.
   */
  async fetchTokenPrices(mintAddresses: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const uncached: string[] = [];

    // Check cache first
    for (const mint of mintAddresses) {
      const cached = this.priceCache.get(mint);
      if (cached && Date.now() - cached.ts < PROVIDER_CONFIG.PRICE_CACHE_TTL_MS) {
        out[mint] = cached.price;
      } else {
        uncached.push(mint);
      }
    }

    if (uncached.length === 0) return out;

    // Jupiter supports batch: ?ids=mint1,mint2,mint3
    try {
      const batchSize = 50; // Jupiter batch limit
      for (let i = 0; i < uncached.length; i += batchSize) {
        const batch = uncached.slice(i, i + batchSize);
        const res = await fetch(
          `${PROVIDER_CONFIG.JUPITER_PRICE_API}?ids=${batch.join(',')}`,
          { headers: { Accept: 'application/json' } },
        );
        if (res.ok) {
          const data = (await res.json()) as JupiterPriceResponse;
          for (const mint of batch) {
            const entry = data.data?.[mint];
            if (entry?.price) {
              const price = parseFloat(entry.price);
              if (!isNaN(price) && price > 0) {
                out[mint] = price;
                this.priceCache.set(mint, { price, ts: Date.now() });
              }
            }
          }
        }
      }
    } catch (e) {
      elizaLogger.warn(`[SolanaService] Jupiter batch price error: ${e}`);
    }

    return out;
  }

  private async fetchPrices(): Promise<Prices> {
    const cacheKey = 'solana/prices';
    const cached = await this.runtime.cacheManager.get<Prices>(cacheKey);
    if (cached) return cached;

    const prices: Prices = {
      solana: { usd: '0' },
      bitcoin: { usd: '0' },
      ethereum: { usd: '0' },
    };

    const mints = [
      PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL,
      PROVIDER_CONFIG.TOKEN_ADDRESSES.BTC,
      PROVIDER_CONFIG.TOKEN_ADDRESSES.ETH,
    ];
    const keys: Array<keyof Prices> = ['solana', 'bitcoin', 'ethereum'];

    // Batch fetch all three at once via Jupiter
    const priceMap = await this.fetchTokenPrices(mints);
    for (let i = 0; i < mints.length; i++) {
      const price = priceMap[mints[i]!];
      if (price !== undefined) prices[keys[i]!].usd = price.toString();
    }

    await this.runtime.cacheManager.set<Prices>(cacheKey, prices);
    return prices;
  }

  // ── Token Accounts ──────────────────────────────────────────────────────

  public async getTokenAccountsByKeypair(
    walletAddress: PublicKey,
    options: { notOlderThan?: number; includeZeroBalances?: boolean } = {},
  ): Promise<KeyedParsedTokenAccount[]> {
    const key = `solana_${walletAddress.toString()}_tokens`;

    if (options.notOlderThan !== undefined && options.notOlderThan !== 0) {
      const check = await this.runtime.cacheManager.get<CacheWrapper<KeyedParsedTokenAccount[]>>(key);
      if (check) {
        const diff = Date.now() - check.exp;
        if (diff < (options.notOlderThan ?? 60_000)) return check.data;
      }
    }

    const [accounts, token2022s]: [ParsedTokenAccountsResponse, ParsedTokenAccountsResponse] =
      await Promise.all([
        schedule('read').then(() =>
          this.connection.getParsedTokenAccountsByOwner(walletAddress, { programId: TOKEN_PROGRAM_ID })),
        schedule('read').then(() =>
          this.connection.getParsedTokenAccountsByOwner(walletAddress, { programId: TOKEN_2022_PROGRAM_ID })),
      ]);

    const allTokens: KeyedParsedTokenAccount[] = [...token2022s.value, ...accounts.value];
    const filtered: KeyedParsedTokenAccount[] = [];
    for (const t of allTokens) {
      const { amount, decimals } = t.account.data.parsed.info.tokenAmount;
      this.decimalsCache.set(t.account.data.parsed.info.mint, decimals);
      if (options.includeZeroBalances || amount !== '0') filtered.push(t);
    }

    await this.runtime.cacheManager.set<CacheWrapper<KeyedParsedTokenAccount[]>>(key, {
      exp: Date.now(),
      data: filtered,
    });

    return filtered;
  }

  public async getTokenAccountsByKeypairs(
    walletAddresses: string[],
    options = {},
  ): Promise<Record<string, KeyedParsedTokenAccount[]>> {
    const out: Record<string, KeyedParsedTokenAccount[]> = {};
    for (const addr of walletAddresses) {
      try {
        out[addr] = await this.getTokenAccountsByKeypair(new PublicKey(addr), options);
      } catch {
        out[addr] = [];
      }
    }
    return out;
  }

  // ── SOL Balances ────────────────────────────────────────────────────────

  public async getBalancesByAddrs(walletAddressArr: string[]): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    const pubkeys = walletAddressArr.map((a) => new PublicKey(a));
    const infos = await this.batchGetMultipleAccountsInfo(pubkeys, 'getBalancesByAddrs');

    for (let i = 0; i < walletAddressArr.length; i++) {
      const addr = walletAddressArr[i];
      if (!addr) continue;
      const info = infos[i];
      out[addr] = info ? info.lamports * SolanaService.LAMPORTS2SOL : 0;
    }

    return out;
  }

  // ── Token Balances (Token + Token-2022) ─────────────────────────────────

  public async getWalletBalances(
    publicKeyStr: string,
    mintAddresses: string[],
  ): Promise<Record<string, MintBalance | null>> {
    const owner = new PublicKey(publicKeyStr);
    const mints = mintAddresses.map((m) => new PublicKey(m));

    const ataPairs = mints.map((mint) => ({
      mint,
      ataTokenV1: getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID),
      ata2022: getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID),
    }));

    const allAtaAddrs = ataPairs.flatMap((p) => [p.ataTokenV1, p.ata2022]);
    const ataInfos = await this.batchGetMultipleAccountsInfo(allAtaAddrs, 'getWalletBalances');

    const mintPubkeys = mints;
    const mintInfos = await this.batchGetMultipleAccountsInfo(mintPubkeys, 'getWalletBalances/mintDecimals');
    const mintDecimals = new Map<string, number>();
    for (let i = 0; i < mints.length; i++) {
      const info = mintInfos[i];
      if (info?.data) {
        try {
          const d = MintLayout.decode(info.data).decimals;
          mintDecimals.set(mints[i]!.toBase58(), d);
        } catch { /* skip */ }
      }
    }

    const byAddress = new Map<string, { amount: bigint }>();
    for (let i = 0; i < allAtaAddrs.length; i++) {
      const info = ataInfos[i];
      if (!info?.data) continue;
      try {
        const unpacked = unpackAccount(allAtaAddrs[i]!, info);
        byAddress.set(allAtaAddrs[i]!.toBase58(), { amount: unpacked.amount });
      } catch { /* skip */ }
    }

    const out: Record<string, MintBalance | null> = {};
    for (const { mint, ataTokenV1, ata2022 } of ataPairs) {
      const mintStr = mint.toBase58();
      const decimals = mintDecimals.get(mintStr);
      if (decimals === undefined) { out[mintStr] = null; continue; }

      const tokenV1 = byAddress.get(ataTokenV1.toBase58());
      const tok2022 = byAddress.get(ata2022.toBase58());
      const chosen = tokenV1 ?? tok2022;
      if (!chosen) { out[mintStr] = null; continue; }

      const rawAmount = chosen.amount;
      const amountStr = rawAmount.toString();
      const uiAmount = Number(rawAmount) / 10 ** decimals;
      out[mintStr] = { amount: amountStr, decimals, uiAmount };
    }

    return out;
  }

  // ── Token Balance for Multiple Wallets ──────────────────────────────────

  public async getTokenBalanceForWallets(
    mint: PublicKey,
    walletAddresses: string[],
  ): Promise<Record<string, number>> {
    const walletPubkeys = walletAddresses.map((a) => new PublicKey(a));
    const atas = walletPubkeys.map((w) => getAssociatedTokenAddressSync(mint, w));
    const balances: Record<string, number> = {};

    const decimals = await this.getDecimal(mint);
    const infos = await this.batchGetMultipleAccountsInfo(atas, 'getTokenBalanceForWallets');

    for (let i = 0; i < infos.length; i++) {
      const walletPubkey = walletPubkeys[i];
      const ata = atas[i];
      if (!walletPubkey || !ata) continue;
      const walletKey = walletPubkey.toBase58();
      let uiAmount = 0;

      const info = infos[i];
      if (info?.data) {
        try {
          const account = unpackAccount(ata, info);
          uiAmount = Number(account.amount) / 10 ** decimals;
        } catch { /* skip */ }
      }

      balances[walletKey] = uiAmount;
    }

    return balances;
  }

  // ── Portfolio ───────────────────────────────────────────────────────────

  private async getTokenAccounts(): Promise<KeyedParsedTokenAccount[] | null> {
    const publicKey = await this.ensurePublicKey();
    if (!publicKey) return null;
    return this.getTokenAccountsByKeypair(publicKey);
  }

  public async getCachedData(): Promise<WalletPortfolio | null> {
    return await this.runtime.cacheManager.get<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY) ?? null;
  }

  public async forceUpdate(): Promise<WalletPortfolio> {
    return this.updateWalletData(true);
  }

  public async updateWalletData(force = false): Promise<WalletPortfolio> {
    const now = Date.now();
    const publicKey = await this.ensurePublicKey();
    if (!publicKey) {
      elizaLogger.info('solana::updateWalletData - no Public Key yet');
      return { totalUsd: '0', items: [] };
    }

    if (!force && now - this.lastUpdate < this.UPDATE_INTERVAL) {
      const cached = await this.getCachedData();
      if (cached) return cached;
    }

    try {
      // Pure RPC + DexScreener/Jupiter approach (no Birdeye/Helius needed)
      const accounts = await this.getTokenAccounts();
      if (!accounts || accounts.length === 0) {
        // Still get SOL balance
        await schedule('read');
        const solBalance = await this.connection.getBalance(publicKey);
        const solUi = solBalance / LAMPORTS_PER_SOL;
        const solPrice = await this.fetchTokenPrice(PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL);
        const solValueUsd = solPrice ? new BigNumber(solUi).times(solPrice).toFixed(2) : '0';

        const portfolio: WalletPortfolio = {
          totalUsd: solValueUsd,
          totalSol: solUi.toFixed(6),
          items: [{
            name: 'SOL',
            address: PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL,
            symbol: 'SOL',
            decimals: 9,
            balance: solBalance.toString(),
            uiAmount: solUi.toFixed(6),
            priceUsd: solPrice?.toString() ?? '0',
            valueUsd: solValueUsd,
            valueSol: solUi.toFixed(6),
          }],
        };
        await this.runtime.cacheManager.set<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
        this.lastUpdate = now;
        return portfolio;
      }

      // Collect all mints for batch price fetch
      const mintAddresses = accounts.map((acc) => acc.account.data.parsed.info.mint);
      mintAddresses.push(PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL);

      // Batch price fetch via Jupiter (1 request for all tokens!)
      const priceMap = await this.fetchTokenPrices(mintAddresses);
      const solPrice = priceMap[PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL] ?? 0;

      // Get SOL balance
      await schedule('read');
      const solBalance = await this.connection.getBalance(publicKey);
      const solUi = solBalance / LAMPORTS_PER_SOL;
      const solValueUsd = new BigNumber(solUi).times(solPrice);

      // Get token symbols for better display
      const symbols = await this.getTokensSymbols(mintAddresses.filter(m => m !== PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL));

      let totalUsd = solValueUsd;
      const items: Item[] = [{
        name: 'SOL',
        address: PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL,
        symbol: 'SOL',
        decimals: 9,
        balance: solBalance.toString(),
        uiAmount: solUi.toFixed(6),
        priceUsd: solPrice.toString(),
        valueUsd: solValueUsd.toFixed(2),
        valueSol: solUi.toFixed(6),
      }];

      for (const acc of accounts) {
        const info = acc.account.data.parsed.info;
        const mint = info.mint;
        const uiAmount = info.tokenAmount.uiAmount ?? 0;
        const price = priceMap[mint] ?? 0;
        const valueUsd = new BigNumber(uiAmount).times(price);
        totalUsd = totalUsd.plus(valueUsd);

        items.push({
          name: symbols[mint] || '',
          address: mint,
          symbol: symbols[mint] || '',
          decimals: info.tokenAmount.decimals,
          balance: info.tokenAmount.amount,
          uiAmount: (uiAmount).toString(),
          priceUsd: price.toString(),
          valueUsd: valueUsd.toFixed(2),
          valueSol: solPrice > 0 ? valueUsd.div(solPrice).toFixed(6) : '0',
        });
      }

      const portfolio: WalletPortfolio = {
        totalUsd: totalUsd.toFixed(2),
        totalSol: solPrice > 0 ? totalUsd.div(solPrice).toFixed(6) : solUi.toFixed(6),
        items,
      };

      await this.runtime.cacheManager.set<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
      this.lastUpdate = now;
      return portfolio;
    } catch (error) {
      elizaLogger.error(`Error updating wallet data: ${error}`);
      throw error;
    }
  }

  // ── Wallet Helpers ──────────────────────────────────────────────────────

  public async createWallet(): Promise<{ publicKey: string; privateKey: string }> {
    const newKeypair = Keypair.generate();
    const publicKey = newKeypair.publicKey.toBase58();
    const privateKey = bs58.encode(newKeypair.secretKey);
    newKeypair.secretKey.fill(0);
    return { publicKey, privateKey };
  }

  async walletAddressToLLMString(pubKey: string): Promise<string> {
    const pubKeyObj = new PublicKey(pubKey);
    const [balances, heldTokens] = await Promise.all([
      this.getBalancesByAddrs([pubKey]),
      this.getTokenAccountsByKeypair(pubKeyObj),
    ]);
    const solBal = balances[pubKey];
    let out = `Wallet Address: ${pubKey}\n`;
    out += 'Current wallet contents in csv format:\n';
    out += 'Token Address,Symbol,Balance\n';
    out += `So11111111111111111111111111111111111111111,sol,${solBal ?? '0'}\n`;
    for (const t of heldTokens) {
      const info = t.account.data.parsed.info;
      out += `${info.mint},${info.tokenAmount.uiAmount},${info.tokenAmount.amount}\n`;
    }
    return out;
  }

  // ── WebSocket Subscriptions ─────────────────────────────────────────────

  public async subscribeToAccount(
    accountAddress: string,
    handler: (address: string, accountInfo: AccountInfo<Buffer>, context: Context) => void,
  ): Promise<number> {
    try {
      const existing = this.subscriptions.get(accountAddress);
      if (existing !== undefined) return existing;

      const pk = new PublicKey(accountAddress);
      const subId = this.connection.onAccountChange(pk, (accountInfo, context) => {
        handler(accountAddress, accountInfo, context);
      });

      this.subscriptions.set(accountAddress, subId);
      elizaLogger.info(`[SolanaService] Subscribed to ${accountAddress}, subId=${subId}`);
      return subId;
    } catch (error) {
      elizaLogger.error(`Error subscribing to account: ${error}`);
      throw error;
    }
  }

  public async unsubscribeFromAccount(accountAddress: string): Promise<boolean> {
    const subId = this.subscriptions.get(accountAddress);
    if (subId === undefined) return false;

    try {
      await this.connection.removeAccountChangeListener(subId);
      this.subscriptions.delete(accountAddress);
      elizaLogger.info(`[SolanaService] Unsubscribed from ${accountAddress}`);
      return true;
    } catch (error) {
      elizaLogger.error(`Error unsubscribing from ${accountAddress}:`, error);
      return false;
    }
  }

  // ── Token Symbol Lookup ─────────────────────────────────────────────────

  public async getTokensSymbols(mints: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    const pubkeys = mints.map((m) => new PublicKey(m));

    // Try Metaplex metadata PDA lookups
    const metadataPDAs = pubkeys.map((mint) => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METADATA_PROGRAM_ID.toBytes(), mint.toBytes()],
        METADATA_PROGRAM_ID,
      );
      return pda;
    });

    const metadataInfos = await this.batchGetMultipleAccountsInfo(metadataPDAs, 'getTokensSymbols');

    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i];
      if (!mint) continue;
      const info = metadataInfos[i];
      if (!info?.data || info.data.length < 100) {
        out[mint] = null;
        continue;
      }

      try {
        // Metaplex metadata layout: skip first 1+32+32 bytes (key+updateAuth+mint)
        // then read symbol from Borsh-encoded name/symbol/uri
        const data = info.data;
        let offset = 1 + 32 + 32; // key + update_authority + mint

        // Read name (length-prefixed)
        const nameLen = data.readUInt32LE(offset);
        offset += 4 + nameLen;

        // Read symbol (length-prefixed)
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        const symbol = data.subarray(offset, offset + symbolLen).toString('utf8').replace(/\0+$/g, '').trim();
        out[mint] = symbol || null;
      } catch {
        out[mint] = null;
      }
    }

    return out;
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    elizaLogger.info('[SolanaService] Stopping...');
    for (const [address] of this.subscriptions) {
      await this.unsubscribeFromAccount(address).catch((e) =>
        elizaLogger.error(`Error unsubscribing from ${address} during stop:`, e instanceof Error ? e.message : String(e)),
      );
    }
    this.subscriptions.clear();
  }
}
