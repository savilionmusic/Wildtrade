import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export interface TwikitTweet {
  handle: string;
  id: string;
  text: string;
  timestamp: number;
}

let cachedPythonCmd: string | null = null;
let twikitChecked = false;
let twikitAvailable = false;
let venvSetupAttempted = false;

// Login failure cooldown — don't retry for 30 minutes after a failure
let loginFailedUntil = 0;
const LOGIN_COOLDOWN_MS = 30 * 60 * 1000;

export function reportTwikitLoginFailure(): void {
  loginFailedUntil = Date.now() + LOGIN_COOLDOWN_MS;
  const mins = LOGIN_COOLDOWN_MS / 60_000;
  console.log(`[twikit] Login failed — pausing Twitter KOL polling for ${mins} minutes.`);
}

function getVenvDir(): string {
  return path.join(process.cwd(), '.twikit-venv');
}

function getVenvPython(): string {
  const venv = getVenvDir();
  // macOS/Linux venv python path
  return path.join(venv, 'bin', 'python3');
}

async function findSystemPython(): Promise<string | null> {
  for (const cmd of ['python3', 'python']) {
    const found = await new Promise<boolean>((resolve) => {
      const proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
      // Timeout to prevent hanging if macOS prompts for Xcode tools
      const timeout = setTimeout(() => { proc.kill(); resolve(false); }, 3000);
      proc.on('error', () => { clearTimeout(timeout); resolve(false); });
      proc.on('close', (code) => { clearTimeout(timeout); resolve(code === 0); });
    });
    if (found) return cmd;
  }
  return null;
}

async function ensureVenvWithTwikit(): Promise<string | null> {
  const venvPython = getVenvPython();
  const venvDir = getVenvDir();

  // If venv python exists and twscrape is already installed, we're done
  if (fs.existsSync(venvPython)) {
    const installed = await new Promise<boolean>((resolve) => {
      const proc = spawn(venvPython, ['-c', 'import twscrape'], { stdio: 'ignore' });
      const timeout = setTimeout(() => { proc.kill(); resolve(false); }, 3000);
      proc.on('error', () => { clearTimeout(timeout); resolve(false); });
      proc.on('close', (code) => { clearTimeout(timeout); resolve(code === 0); });
    });
    if (installed) return venvPython;
  }

  if (venvSetupAttempted) return null;
  venvSetupAttempted = true;

  const systemPython = await findSystemPython();
  if (!systemPython) {
    console.log('[twikit] Python not found. Install Python 3 to enable Twitter KOL tracking.');
    return null;
  }

  console.log('[twikit] First-time setup: creating virtual environment...');

  // Create venv
  const venvCreated = await new Promise<boolean>((resolve) => {
    const proc = spawn(systemPython, ['-m', 'venv', venvDir], { stdio: 'pipe' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });

  if (!venvCreated || !fs.existsSync(venvPython)) {
    console.log('[twikit] Failed to create virtual environment.');
    return null;
  }

  console.log('[twikit] Installing twscrape into virtual environment (one-time, ~10 seconds)...');

  // Install twscrape — more reliable than twikit on Python 3.14
  const venvPip = path.join(venvDir, 'bin', 'pip3');
  const installed = await new Promise<boolean>((resolve) => {
    const proc = spawn(venvPip, ['install', 'twscrape', '--quiet'], { stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code !== 0) console.log(`[twikit] pip install error: ${stderr.slice(0, 200)}`);
      resolve(code === 0);
    });
  });

  if (!installed) {
    console.log('[twikit] Failed to install twscrape. KOL Twitter polling disabled.');
    return null;
  }

  console.log('[twikit] twscrape installed successfully in .twikit-venv!');
  return venvPython;
}

async function getPythonWithTwikit(): Promise<string | null> {
  if (cachedPythonCmd !== null) return cachedPythonCmd || null;

  // Try venv first (auto-created by us)
  const venvPython = await ensureVenvWithTwikit();
  if (venvPython) {
    cachedPythonCmd = venvPython;
    return venvPython;
  }

  // Fallback: system python with twscrape already installed
  if (!twikitChecked) {
    twikitChecked = true;
    const systemPython = await findSystemPython();
    if (systemPython) {
      twikitAvailable = await new Promise<boolean>((resolve) => {
        const proc = spawn(systemPython, ['-c', 'import twscrape'], { stdio: 'ignore' });
        proc.on('error', () => resolve(false));
        proc.on('close', (code) => resolve(code === 0));
      });
      if (twikitAvailable) {
        cachedPythonCmd = systemPython;
        return systemPython;
      }
    }
  }

  cachedPythonCmd = '';
  return null;
}

function getScriptPath(): string {
  return path.join(process.cwd(), 'scripts', 'twikit_scraper.py');
}

export async function fetchTwikitTweets(handles: string[]): Promise<TwikitTweet[]> {
  if (handles.length === 0) return [];

  // Respect login failure cooldown
  if (Date.now() < loginFailedUntil) {
    return [];
  }

  const pythonCmd = await getPythonWithTwikit();
  if (!pythonCmd) {
    return [];
  }

  const scriptPath = getScriptPath();

  return new Promise((resolve) => {
    const env = { ...process.env, PYTHONUNBUFFERED: '1' };
    const proc = spawn(pythonCmd, [scriptPath, ...handles], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timeout = setTimeout(() => {
      proc.kill();
      console.log('[twikit] Timeout — took too long to fetch tweets.');
      resolve([]);
    }, 60_000);

    proc.on('close', () => {
      clearTimeout(timeout);

      for (const line of stderr.trim().split('\n')) {
        if (line.trim()) console.log(`[twikit] ${line.trim()}`);
      }

      const raw = stdout.trim();
      if (!raw) { resolve([]); return; }

      try {
        const data = JSON.parse(raw);
        if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
          const msg: string = data.error as string;
          console.log(`[twikit] ${msg}${data.hint ? ' — ' + data.hint : ''}`);
          // Detect login failures and start cooldown
          if (msg.toLowerCase().includes('login failed')) {
            reportTwikitLoginFailure();
          }
          resolve([]);
          return;
        }
        const tweets = Array.isArray(data) ? (data as TwikitTweet[]) : [];
        if (tweets.length > 0) {
          console.log(`[twikit] Fetched ${tweets.length} tweets from ${handles.length} KOL handles`);
        }
        resolve(tweets);
      } catch {
        if (raw) console.log(`[twikit] Could not parse output: ${raw.slice(0, 120)}`);
        resolve([]);
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timeout);
      console.log(`[twikit] Spawn error: ${String(err)}`);
      resolve([]);
    });
  });
}

