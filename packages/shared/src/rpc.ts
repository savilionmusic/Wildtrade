export const DEFAULT_PUBLIC_RPC_ENDPOINT = 'https://api.mainnet-beta.solana.com';

function normalizeValue(value: string | undefined | null): string {
  return String(value ?? '').trim();
}

export function isPlaceholderRpcValue(value: string | undefined | null): boolean {
  const normalized = normalizeValue(value).toLowerCase();
  if (!normalized) return true;

  return normalized.startsWith('your_')
    || normalized.includes('your_key')
    || normalized.includes('your-endpoint')
    || normalized.includes('your-server.example.com')
    || normalized.includes('placeholder')
    || normalized.includes('example')
    || normalized.includes('...');
}

export function normalizeHttpRpcEndpoint(endpoint: string | undefined | null): string | null {
  const normalized = normalizeValue(endpoint);
  if (!normalized || isPlaceholderRpcValue(normalized)) return null;

  if (/^https?:\/\//i.test(normalized)) return normalized;
  if (/^wss?:\/\//i.test(normalized)) {
    return normalized.replace(/^wss?:\/\//i, (match) => (match.toLowerCase() === 'wss://' ? 'https://' : 'http://'));
  }

  return `https://${normalized}`;
}

export function normalizeWsRpcEndpoint(endpoint: string | undefined | null): string | null {
  const normalized = normalizeValue(endpoint);
  if (!normalized || isPlaceholderRpcValue(normalized)) return null;

  if (/^wss?:\/\//i.test(normalized)) return normalized;
  if (/^https?:\/\//i.test(normalized)) {
    return normalized.replace(/^https?:\/\//i, (match) => (match.toLowerCase() === 'https://' ? 'wss://' : 'ws://'));
  }

  return `wss://${normalized}`;
}

export function selectPrimaryHttpRpcEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.SOLANA_RPC_HTTP,
    env.SOLANA_RPC_CONSTANTK,
    env.SOLANA_RPC_URL,
    env.SOLANA_RPC_QUICKNODE,
  ];

  for (const candidate of candidates) {
    const endpoint = normalizeHttpRpcEndpoint(candidate);
    if (endpoint) return endpoint;
  }

  return selectPublicHttpRpcEndpoint(env);
}

export function selectPrimaryWsRpcEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [
    env.SOLANA_WSS_URL,
    env.SOLANA_RPC_CONSTANTK,
    env.SOLANA_RPC_URL,
    env.SOLANA_RPC_QUICKNODE,
  ];

  for (const candidate of candidates) {
    const endpoint = normalizeWsRpcEndpoint(candidate);
    if (endpoint) return endpoint;
  }

  return normalizeWsRpcEndpoint(selectPrimaryHttpRpcEndpoint(env)) ?? `wss://${DEFAULT_PUBLIC_RPC_ENDPOINT.replace(/^https?:\/\//i, '')}`;
}

export function selectPrivateHttpFallbackEndpoint(
  primaryHttpEndpoint: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const primary = normalizeHttpRpcEndpoint(primaryHttpEndpoint);
  const publicEndpoint = selectPublicHttpRpcEndpoint(env);
  const candidates = [
    env.SOLANA_RPC_HTTP,
    env.SOLANA_RPC_QUICKNODE,
    env.SOLANA_RPC_URL,
    env.SOLANA_RPC_CONSTANTK,
  ];

  for (const candidate of candidates) {
    const endpoint = normalizeHttpRpcEndpoint(candidate);
    if (!endpoint) continue;
    if (endpoint === primary || endpoint === publicEndpoint) continue;
    return endpoint;
  }

  return null;
}

export function selectPublicHttpRpcEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeHttpRpcEndpoint(env.SOLANA_RPC_PUBLIC) ?? DEFAULT_PUBLIC_RPC_ENDPOINT;
}

export function shouldAllowPublicRpcFallback(env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeValue(env.SOLANA_ALLOW_PUBLIC_RPC_FALLBACK).toLowerCase() === 'true';
}

export function getConfiguredWalletPublicKey(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeValue(env.WALLET_PUBLIC_KEY || env.SOLANA_WALLET_PUBLIC_KEY);
}