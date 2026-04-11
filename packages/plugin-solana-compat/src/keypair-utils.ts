import type { IAgentRuntime } from '@elizaos/core';
import { elizaLogger } from '@elizaos/core';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { KeypairResult } from './types.js';

function getStringSetting(runtime: IAgentRuntime, key: string): string | null {
  const value = runtime.getSetting(key);
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error(`Setting ${key} must be a string, got ${typeof value}`);
  return value;
}

export async function getWalletKey(
  runtime: IAgentRuntime,
  requirePrivateKey: boolean,
): Promise<KeypairResult> {
  const privateKeyStr =
    getStringSetting(runtime, 'SOLANA_PRIVATE_KEY') ??
    getStringSetting(runtime, 'WALLET_PRIVATE_KEY');

  const publicKeyStr =
    getStringSetting(runtime, 'SOLANA_PUBLIC_KEY') ??
    getStringSetting(runtime, 'WALLET_PUBLIC_KEY');

  if (privateKeyStr) {
    try {
      let secretKey: Uint8Array;
      if (privateKeyStr.startsWith('[')) {
        secretKey = new Uint8Array(JSON.parse(privateKeyStr));
      } else if (/^[0-9a-fA-F]{128}$/i.test(privateKeyStr)) {
        secretKey = new Uint8Array(Buffer.from(privateKeyStr, 'hex'));
      } else {
        secretKey = bs58.decode(privateKeyStr);
      }
      const keypair = Keypair.fromSecretKey(secretKey);
      return { keypair, publicKey: keypair.publicKey };
    } catch (err) {
      elizaLogger.error('Failed to parse private key:', err);
      if (requirePrivateKey) throw new Error('Invalid SOLANA_PRIVATE_KEY');
    }
  }

  if (publicKeyStr) {
    try {
      const publicKey = new PublicKey(publicKeyStr);
      return { publicKey };
    } catch (err) {
      elizaLogger.error('Failed to parse public key:', err);
    }
  }

  if (requirePrivateKey) throw new Error('No SOLANA_PRIVATE_KEY configured');
  return {};
}
