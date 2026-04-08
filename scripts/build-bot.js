import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// Ensure esbuild platform binary is installed (bun install skips it)
const platformMap = { darwin: 'darwin', linux: 'linux', win32: 'win32' };
const archMap = { arm64: 'arm64', x64: 'x64' };
const p = platformMap[process.platform];
const a = archMap[process.arch];
if (p && a) {
  const require = createRequire(import.meta.url);
  const platformPkg = `@esbuild/${p}-${a}`;
  try {
    require.resolve(platformPkg);
  } catch {
    console.log(`⚡ Installing ${platformPkg}...`);
    // Try multiple package managers — npm is broken on Node v24
    const cmds = [
      `bun add --no-save ${platformPkg}`,
      `yarn add --no-lockfile ${platformPkg}`,
      `pnpm add --save-peer=false ${platformPkg}`,
      `npm install --no-save --ignore-scripts ${platformPkg}`,
    ];
    let installed = false;
    for (const cmd of cmds) {
      const bin = cmd.split(' ')[0];
      try {
        execSync(`which ${bin}`, { stdio: 'ignore' });
        console.log(`   trying: ${cmd}`);
        execSync(cmd, { cwd: root, stdio: 'inherit', timeout: 30_000 });
        installed = true;
        break;
      } catch {
        // This package manager not available or failed — try next
      }
    }
    if (!installed) {
      console.error(`❌ Could not install ${platformPkg} with any package manager.`);
      console.error(`   Run manually: bun add ${platformPkg}`);
      process.exit(1);
    }
  }
}

const { build } = await import('esbuild');

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true,
  outfile: path.join(root, 'dist', 'bot.cjs'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external: [
    '@img/sharp-*',
    '@anush008/tokenizers-*',
    'cpu-features',
    'ssh2',
    '@electric-sql/pglite',
    'sql.js',
  ],
  alias: {
    'better-sqlite3': path.join(root, 'scripts', 'stub-better-sqlite3', 'index.js'),
    '@anush008/tokenizers': path.join(root, 'scripts', 'stub-tokenizers', 'index.js'),
    'onnxruntime-node': path.join(root, 'scripts', 'stub-fastembed', 'index.js'),
    'onnxruntime-web': path.join(root, 'scripts', 'stub-fastembed', 'index.js'),
    '@roamhq/wrtc': path.join(root, 'scripts', 'stub-wrtc', 'index.js'),
    'wrtc': path.join(root, 'scripts', 'stub-wrtc', 'index.js'),
    'sharp': path.join(root, 'scripts', 'stub-sharp', 'index.js'),
    'fastembed': path.join(root, 'scripts', 'stub-fastembed', 'index.js'),
    '@wildtrade/shared': path.join(root, 'packages', 'shared', 'src', 'index.ts'),
    '@wildtrade/plugin-alpha-scout': path.join(root, 'packages', 'plugin-alpha-scout', 'src', 'index.ts'),
    '@wildtrade/plugin-smart-trader': path.join(root, 'packages', 'plugin-smart-trader', 'src', 'index.ts'),
    '@wildtrade/plugin-self-healer': path.join(root, 'packages', 'plugin-self-healer', 'src', 'index.ts'),
  },
  banner: {
    js: `
// Polyfill import.meta.url for CJS bundle
if (typeof globalThis.__importMetaUrl === 'undefined') {
  globalThis.__importMetaUrl = require('url').pathToFileURL(__filename).href;
}
`,
  },
  define: {
    'import.meta.url': 'globalThis.__importMetaUrl',
    'process.env.NODE_ENV': '"production"',
  },
  logLevel: 'info',
});

console.log('✓ Bot bundled to dist/bot.cjs');
