import type { AgentRuntime } from '@elizaos/core';

// Keywords that indicate something worth the auditor reviewing
const ERROR_KEYWORDS = [
  '429', 'too many requests',
  '504', '503', 'gateway timeout',
  'timeout', 'timed out',
  'simulation failed',
  'rpc error', 'rpc failed',
  'blockhash expired', 'blockhash not found',
  'failed to fetch', 'fetch failed',
  'socket hang up', 'econnreset', 'econnrefused',
  'blocked', 'honeypot',
  ' rug', // space prefix to avoid "debug" etc
  'uncaught', '[fatal]',
  'discrepancy',         // reconciler findings
  'catastrophic',        // auditor own reports
  'stop loss triggered', // trade protection events
];

let patched = false;
let originalStdoutWrite: (typeof process.stdout.write) | null = null;
let originalStderrWrite: (typeof process.stderr.write) | null = null;

function lineMatchesError(line: string): boolean {
  const lower = line.toLowerCase();
  return ERROR_KEYWORDS.some(kw => lower.includes(kw));
}

function feedToAuditor(runtime: AgentRuntime, line: string): void {
  // Fire-and-forget: give the error-detector evaluator something to act on
  runtime.messageManager.createMemory({
    id: crypto.randomUUID() as any,
    userId: '00000000-0000-0000-0000-000000000001' as any,
    agentId: runtime.agentId,
    roomId: '00000000-0000-0000-0000-000000000098' as any, // dedicated error feed room
    content: { text: line.trim() },
    createdAt: Date.now(),
  }).catch(() => {}); // never throw — we are inside stdout.write
}

export function startLogWatcher(runtime: AgentRuntime): void {
  if (patched) return;
  patched = true;

  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);

  function makeInterceptor(original: typeof process.stdout.write) {
    return function interceptedWrite(chunk: any, encoding?: any, callback?: any): boolean {
      const line = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      if (lineMatchesError(line)) {
        feedToAuditor(runtime, line);
      }
      // Always forward to the original writer
      if (typeof encoding === 'function') {
        return original(chunk, encoding);
      }
      return original(chunk, encoding, callback);
    };
  }

  (process.stdout as any).write = makeInterceptor(originalStdoutWrite);
  (process.stderr as any).write = makeInterceptor(originalStderrWrite);

  console.log('[auditor] Log watcher active — error lines will be fed to auditor evaluator.');
}

export function stopLogWatcher(): void {
  if (!patched) return;
  if (originalStdoutWrite) (process.stdout as any).write = originalStdoutWrite;
  if (originalStderrWrite) (process.stderr as any).write = originalStderrWrite;
  patched = false;
  originalStdoutWrite = null;
  originalStderrWrite = null;
}
