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
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    if (found) return cmd;
  }
  return null;
}

async function ensureVenvWithTwikit(): Promise<string | null> {
  const venvPython = getVenvPython();
  const venvDir = getVenvDir();

  // If venv python exists and twikit is already installed, we're done
  if (fs.existsSync(venvPython)) {
    const installed = await new Promise<boolean>((resolve) => {
      const proc = spawn(venvPython, ['-c', 'import twikit'], { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
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

  console.log('[twikit] Installing twikit into virtual environment (one-time, ~10 seconds)...');

  // Install twikit into venv
  const venvPip = path.join(venvDir, 'bin', 'pip3');
  const installed = await new Promise<boolean>((resolve) => {
    const proc = spawn(venvPip, ['install', 'twikit', '--quiet'], { stdio: 'pipe' });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => {
      if (code !== 0) console.log(`[twikit] pip install error: ${stderr.slice(0, 200)}`);
      resolve(code === 0);
    });
  });

  if (!installed) {
    console.log('[twikit] Failed to install twikit. KOL Twitter polling disabled.');
    return null;
  }

  console.log('[twikit] twikit installed successfully in .twikit-venv!');
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

  // Fallback: system python with twikit already installed
  if (!twikitChecked) {
    twikitChecked = true;
    const systemPython = await findSystemPython();
    if (systemPython) {
      twikitAvailable = await new Promise<boolean>((resolve) => {
        const proc = spawn(systemPython, ['-c', 'import twikit'], { stdio: 'ignore' });
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
          console.log(`[twikit] ${data.error}${data.hint ? ' — ' + data.hint : ''}`);
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

export interface TwikitTweet {
  handle: string;
  id: string;
  text: string;
  timestamp: number;
}

let cachedPythonCmd: string | null = null;
let twikitChecked = false;
let twikitAvailable = false;

async function findPython(): Promise<string | null> {
  if (cachedPythonCmd !== null) return cachedPythonCmd;
  for (const cmd of ['python3', 'python']) {
    const found = await new Promise<boolean>((resolve) => {
      const proc = spawn(cmd, ['--version'], { stdio: 'ignore' });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
    if (found) {
      cachedPythonCmd = cmd;
      return cmd;
    }
  }
  cachedPythonCmd = '';
  return null;
}

async function checkTwikitInstalled(pythonCmd: string): Promise<boolean> {
  if (twikitChecked) return twikitAvailable;
  twikitChecked = true;
  twikitAvailable = await new Promise<boolean>((resolve) => {
    const proc = spawn(pythonCmd, ['-c', 'import twikit'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
  return twikitAvailable;
}

function getScriptPath(): string {
  // Works in both dev (project root) and built modes
  const cwd = process.cwd();
  return path.join(cwd, 'scripts', 'twikit_scraper.py');
}

export async function fetchTwikitTweets(handles: string[]): Promise<TwikitTweet[]> {
  if (handles.length === 0) return [];

  const pythonCmd = await findPython();
  if (!pythonCmd) {
    console.log('[twikit] Python not found. Install Python 3 to enable Twitter KOL tracking.');
    return [];
  }

  const installed = await checkTwikitInstalled(pythonCmd);
  if (!installed) {
    console.log('[twikit] twikit not installed. Run: pip3 install twikit');
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
    }, 45_000);

    proc.on('close', () => {
      clearTimeout(timeout);

      // Forward any stderr lines as log hints
      for (const line of stderr.trim().split('\n')) {
        if (line.trim()) console.log(`[twikit] ${line.trim()}`);
      }

      const raw = stdout.trim();
      if (!raw) {
        resolve([]);
        return;
      }

      try {
        const data = JSON.parse(raw);

        if (data && typeof data === 'object' && !Array.isArray(data) && data.error) {
          console.log(`[twikit] ${data.error}${data.hint ? ' — ' + data.hint : ''}`);
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
