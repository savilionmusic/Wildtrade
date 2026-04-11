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
import type {
  BirdeyePriceResponse,
  BirdeyeWalletTokenListResponse,
  CacheWrapper,
  Item,
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
    'Interact with the Solana blockchain, access wallet data, Birdeye prices, portfolio tracking';

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
      `[SolanaService] RPC: ${rpcUrl.substring(0, 50)}${rpcUrl.length > 50 ? '...' : ''}`,
    );
  }

  // ── RPC Resolution ──────────────────────────────────────────────────────

  private resolveRpcUrl(): string {
    const explicit = this.runtime.getSetting('SOLANA_RPC_URL');
    if (typeof explicit === 'string' && explicit.startsWith('http')) return explicit;

    const heliusKey = this.runtime.getSetting('HELIUS_API_KEY');
    if (typeof heliusKey === 'string' && heliusKey.length > 8) {
      return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    }

    return PROVIDER_CONFIG.DEFAULT_RPC;
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

  // ── Batch RPC ───────────────────────────────────────────────────────────

  async batchGetMultipleAccountsInfo(
    pubkeys: PublicKey[],
    _label = '',
  ): Promise<(AccountInfo<Buffer> | null)[]> {
    const CHUNK = 100;
    const results: (AccountInfo<Buffer> | null)[] = [];

    for (let i = 0; i < pubkeys.length; i += CHUNK) {
      const chunk = pubkeys.slice(i, i + CHUNK);
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

  // ── Birdeye ─────────────────────────────────────────────────────────────

  private getBirdeyeConfig(): { baseUrl: string; headers: Record<string, string> } {
    const apiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
    return {
      baseUrl: PROVIDER_CONFIG.BIRDEYE_API,
      headers: {
        Accept: 'application/json',
        'x-chain': 'solana',
        ...(typeof apiKey === 'string' && apiKey.length > 0 ? { 'X-API-KEY': apiKey } : {}),
      },
    };
  }

  private async birdeyeFetchWithRetry(
    url: string,
    options: RequestInit = {},
  ): Promise<BirdeyeWalletTokenListResponse | BirdeyePriceResponse> {
    let lastError: Error | undefined;
    const birdeyeConfig = this.getBirdeyeConfig();

    for (let i = 0; i < PROVIDER_CONFIG.MAX_RETRIES; i++) {
      try {
        const response = await fetch(url, {
          ...options,
          headers: { ...birdeyeConfig.headers, ...(options.headers as Record<string, string> || {}) },
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        return await response.json();
      } catch (error) {
        elizaLogger.error(`Birdeye attempt ${i + 1} failed:`, error);
        lastError = error instanceof Error ? error : new Error(String(error));
        if (i < PROVIDER_CONFIG.MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, PROVIDER_CONFIG.RETRY_DELAY * 2 ** i));
        }
      }
    }

    throw lastError ?? new Error(`Failed to fetch ${url} after ${PROVIDER_CONFIG.MAX_RETRIES} retries`);
  }

  async fetchBirdeyePrice(mintAddress: string): Promise<number | null> {
    const apiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
    if (typeof apiKey !== 'string' || apiKey.length === 0) return null;

    try {
      const data = (await this.birdeyeFetchWithRetry(
        `${PROVIDER_CONFIG.BIRDEYE_API}/defi/price?address=${mintAddress}`,
      )) as BirdeyePriceResponse;
      return data?.success ? data.data.value : null;
    } catch {
      return null;
    }
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

    const tokens: Array<[string, keyof Prices]> = [
      [PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL, 'solana'],
      [PROVIDER_CONFIG.TOKEN_ADDRESSES.BTC, 'bitcoin'],
      [PROVIDER_CONFIG.TOKEN_ADDRESSES.ETH, 'ethereum'],
    ];

    for (const [addr, key] of tokens) {
      const price = await this.fetchBirdeyePrice(addr);
      if (price !== null) prices[key].usd = price.toString();
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
        this.connection.getParsedTokenAccountsByOwner(walletAddress, { programId: TOKEN_PROGRAM_ID }),
        this.connection.getParsedTokenAccountsByOwner(walletAddress, { programId: TOKEN_2022_PROGRAM_ID }),
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
      const birdeyeApiKey = this.runtime.getSetting('BIRDEYE_API_KEY');
      if (typeof birdeyeApiKey === 'string' && birdeyeApiKey.length > 0) {
        try {
          const walletData = (await this.birdeyeFetchWithRetry(
            `${PROVIDER_CONFIG.BIRDEYE_API}/v1/wallet/token_list?wallet=${publicKey.toBase58()}`,
          )) as BirdeyeWalletTokenListResponse;

          if (walletData?.success && walletData?.data) {
            const solPrice = await this.fetchBirdeyePrice(PROVIDER_CONFIG.TOKEN_ADDRESSES.SOL);
            const solPriceInUSD = solPrice ?? 0;

            const data = walletData.data;
            const portfolio: WalletPortfolio = {
              totalUsd: String(data.totalUsd ?? '0'),
              totalSol: solPriceInUSD > 0
                ? new BigNumber(data.totalUsd ?? 0).div(solPriceInUSD).toFixed(6)
                : '0',
              items: (data.items || []).map((item) => ({
                name: item.name || 'Unknown',
                address: item.address,
                symbol: item.symbol || 'Unknown',
                decimals: item.decimals ?? 0,
                balance: item.balance ?? '0',
                uiAmount: item.uiAmount ?? '0',
                priceUsd: item.priceUsd ?? '0',
                valueUsd: item.valueUsd ?? '0',
                valueSol: solPriceInUSD > 0
                  ? new BigNumber(item.valueUsd || 0).div(solPriceInUSD).toFixed(6)
                  : '0',
              })),
            };

            await this.runtime.cacheManager.set<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, portfolio);
            this.lastUpdate = now;
            return portfolio;
          }
        } catch (e) {
          elizaLogger.error('solana::updateWalletData - Birdeye exception:', e);
        }
      }

      // RPC fallback
      elizaLogger.info('Using RPC fallback for wallet data (no Birdeye)');
      const accounts = await this.getTokenAccounts();
      if (!accounts || accounts.length === 0) {
        const emptyPortfolio: WalletPortfolio = { totalUsd: '0', totalSol: '0', items: [] };
        await this.runtime.cacheManager.set<WalletPortfolio>(SOLANA_WALLET_DATA_CACHE_KEY, emptyPortfolio);
        this.lastUpdate = now;
        return emptyPortfolio;
      }

      const items: Item[] = accounts.map((acc) => ({
        name: '',
        address: acc.account.data.parsed.info.mint,
        symbol: '',
        decimals: acc.account.data.parsed.info.tokenAmount.decimals,
        balance: acc.account.data.parsed.info.tokenAmount.amount,
        uiAmount: acc.account.data.parsed.info.tokenAmount.uiAmount?.toString() ?? '0',
        priceUsd: '0',
        valueUsd: '0',
        valueSol: '0',
      }));

      const portfolio: WalletPortfolio = { totalUsd: '0', totalSol: '0', items };
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
