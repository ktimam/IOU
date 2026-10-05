// Test-only in-memory fixture. Never import the app's Vite config or .env files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prepareConversionFixture() {
  // Use esbuild already installed through Vite, not an added/fetched dependency.
  const require = createRequire(path.join(repo, 'package.json'));
  const { build } = createRequire(require.resolve('vite'))('esbuild');
  const expectedImporter = path.resolve(repo, 'src/features/entries/EntryForm.tsx');
  const built = await build({
    entryPoints: [path.join(here, 'harness.tsx')], absWorkingDir: repo,
    nodePaths: [path.join(repo, 'node_modules')], bundle: true, write: false,
    format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
    sourcemap: false, minify: false, metafile: true, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env': '{}' },
    plugins: [{ name: 'synthetic-conversion-preferences', setup(api) {
      api.onResolve({ filter: /usePreferences$/ }, args => {
        assert.equal(path.resolve(args.importer), expectedImporter);
        return { path: 'fixed-preferences', namespace: 'synthetic' };
      });
      api.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({
        contents: 'export const usePreferences = () => ({ prefs: { defaultCurrency: "USD" } });', loader: 'js',
      }));
    } }],
  });
  const virtual = ['synthetic:fixed-preferences', '<define:import.meta.env>'];
  const sourcePins = Object.keys(built.metafile.inputs).flatMap(input => {
    if (input.startsWith('synthetic:') || input.startsWith('<')) {
      assert(virtual.includes(input), 'Unexpected injected module'); return [];
    }
    const file = path.resolve(repo, input), relative = path.relative(repo, file).replaceAll('\\', '/');
    if (relative.startsWith('src/')) assert(/^src\/features\/(entries|settings)\//.test(relative), 'Unexpected account/app dependency');
    return [{ path: relative, sha256: hash(fs.readFileSync(file)) }];
  });
  for (const name of ['EntryForm.tsx', 'useCurrencyConversion.ts', 'fx.ts', 'conversion.ts', 'entryMath.ts']) {
    assert(sourcePins.some(pin => pin.path === 'src/features/entries/' + name), 'Actual production module missing: ' + name);
  }
  const assets = new Map();
  const add = (url, bytes, type) => assets.set(url, { bytes, type });
  add('/', fs.readFileSync(path.join(here, 'index.html')), 'text/html; charset=utf-8');
  add('/main.js', built.outputFiles[0].contents, 'text/javascript; charset=utf-8');
  add('/fixture.css', fs.readFileSync(path.join(here, 'fixture.css')), 'text/css; charset=utf-8');
  add('/global.css', fs.readFileSync(path.join(repo, 'src/styles/global.css')), 'text/css; charset=utf-8');
  for (const name of ['manrope-var.woff2', 'jetbrains-mono-var.woff2']) {
    add('/fonts/' + name, fs.readFileSync(path.join(repo, 'public/fonts', name)), 'font/woff2');
  }
  return { assets, manifest: {
    kind: 'actual IOU conversion component with synthetic preferences and FX transport',
    sourcePins,
    assets: [...assets].map(([url, asset]) => ({ url, sha256: hash(asset.bytes), byteLength: asset.bytes.length })),
    expectedScenarios: 8, readsAccountsOrEnvironmentFiles: false,
  } };
}

export async function startConversionFixture({ port = 0 } = {}) {
  assert(Number.isInteger(port) && port >= 0 && port <= 65535, 'Invalid loopback port');
  const prepared = await prepareConversionFixture();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'), asset = prepared.assets.get(url.pathname);
    if (request.method !== 'GET' || url.search || !asset) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, {
      'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(asset.bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const address = server.address(); assert(address && typeof address === 'object');
  return {
    origin: 'http://127.0.0.1:' + address.port, manifest: prepared.manifest,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--check') {
    const { manifest } = await prepareConversionFixture();
    console.log(JSON.stringify({ prepared: true, serverStarted: false, manifest }, null, 2));
  } else {
    assert(args.length === 2 && args[0] === '--port' && /^\d+$/.test(args[1]), 'Use --check or --port <loopback port>');
    const fixture = await startConversionFixture({ port: Number(args[1]) });
    console.log('Synthetic conversion fixture only: ' + fixture.origin);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void fixture.close());
  }
}
