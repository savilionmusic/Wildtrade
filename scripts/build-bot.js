import { build } from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  bundle: true,
  outfile: path.join(root, 'dist', 'bot.cjs'),
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  sourcemap: true,
  external: [
    'better-sqlite3',
    '@img/sharp-*',
    '@anush008/tokenizers',
    '@anush008/tokenizers-*',
    'cpu-features',
    'ssh2',
    'onnxruntime-node',
    'onnxruntime-web',
    '@electric-sql/pglite',
    'sql.js',
  ],
  alias: {
    'sharp': path.join(root, 'scripts', 'stub-sharp', 'index.js'),
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
