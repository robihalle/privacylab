import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const torJsPath = process.argv[2];
if (!torJsPath) throw new Error('Pass the patched tor-js checkout.');
const torJs = resolve(torJsPath);
const require = createRequire(resolve(torJs, 'package.json'));
const { build } = require('esbuild');
const wasmDir = resolve(torJs, 'crates/tor-js-wasm/pkg');
const artifacts = new URL('./artifacts/', import.meta.url);
const bytes = await readFile(resolve(wasmDir, 'tor_js_bg.wasm'));
const notices = await Promise.all([
  readFile(resolve(torJs, 'LICENSE-MIT'), 'utf8'),
  readFile(resolve(torJs, '../arti-browser/LICENSE-MIT'), 'utf8'),
]);
const hash = createHash('sha256').update(bytes).digest('hex');

await mkdir(artifacts, { recursive: true });
await writeFile(new URL('tor_js_bg.wasm', artifacts), bytes);
await writeFile(new URL('tor_js_bg.wasm.gz', artifacts), gzipSync(bytes, { level: 9 }));
await build({
  absWorkingDir: import.meta.dirname,
  entryPoints: ['client.js'],
  outfile: 'artifacts/client.js',
  bundle: true,
  minify: true,
  banner: { js: '/*! tor-js and Arti license notices\n' + notices.join('\n') + '*/' },
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  external: ['node:*', '@kpstreams/quic-client'],
  define: {
    __WASM_SHA256__: JSON.stringify(hash),
    __PACKAGE_VERSION__: JSON.stringify('anyone-privacy-lab'),
  },
  plugins: [{
    name: 'patched-anyone-client',
    setup(bundle) {
      bundle.onResolve({ filter: /^#wasm$/ }, () => ({ path: resolve(wasmDir, 'tor_js.js') }));
      bundle.onResolve({ filter: /^anyone-client\// }, args => ({
        path: resolve(torJs, 'src', args.path.replace(/^anyone-client\//, '').replace(/\.js$/, '.ts')),
      }));
    },
  }],
});
console.log('Anyone client WASM SHA-256:', hash);
