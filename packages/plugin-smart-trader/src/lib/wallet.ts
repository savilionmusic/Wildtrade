import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

let cachedKeypair: Keypair | null = null;

export function getKeypair(): Keypair {
  if (cachedKeypair) return cachedKeypair;

  const privateKeyBase58 = process.env.WALLET_PRIVATE_KEY;
  if (!privateKeyBase58) {
    throw new Error('[smart-trader] WALLET_PRIVATE_KEY env var is not set');
  }

  const secretKey = bs58.decode(privateKeyBase58);
  cachedKeypair = Keypair.fromSecretKey(secretKey);
  console.log(`[smart-trader] Wallet loaded: ${cachedKeypair.publicKey.toBase58()}`);
  return cachedKeypair;
}

export function getPublicKey(): string {
  return getKeypair().publicKey.toBase58();
}
