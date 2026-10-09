import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { after } from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Principal } from '@dfinity/principal';
import { validateMainnetPlan, mainnetBuildEnvironment, requireMainnetBuildEnvironment,
  assertMainnetBuildDirectory, safeCopyMainnetWasm } from './mainnet-plan.mjs';

// Public principal fixtures only. These are not deployment destinations.
const input = { network: 'ic', identity: 'iou-production',
  expectedPrincipal: 'rdmx6-jaaaa-aaaaa-aaadq-cai',
  backendCanisterId: 'rrkah-fqaaa-aaaaa-aaaaq-cai', assetsCanisterId: 'ryjl3-tyaaa-aaaaa-aaaba-cai' };

test('requires explicit mainnet coordinates and derives the certified assets origin', () => {
  const plan = validateMainnetPlan(input);
  assert.equal(plan.publicOrigin, 'https://ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io');
  assert.equal(plan.network, 'ic');
  for (const key of ['network', 'identity', 'expectedPrincipal', 'backendCanisterId', 'assetsCanisterId']) {
    assert.throws(() => validateMainnetPlan({ ...input, [key]: undefined }));
  }
});

test('rejects malformed, anonymous, management, duplicated and fallback canister IDs', () => {
  for (const value of ['', 'not-a-principal', 'aaaaa-aa', '2vxsx-fae', 'uxrrr-q7777-77774-qaaaq-cai']) {
    for (const key of ['expectedPrincipal', 'backendCanisterId', 'assetsCanisterId'])
      assert.throws(() => validateMainnetPlan({ ...input, [key]: value }));
  }
  assert.throws(() => validateMainnetPlan({ ...input, assetsCanisterId: input.backendCanisterId }));
  assert.throws(() => validateMainnetPlan({ ...input, identity: '--anonymous' }));
  assert.throws(() => validateMainnetPlan({ ...input, network: 'local' }));
});

test('refuses localhost, Tailscale or an unreviewed alternate public origin', () => {
  for (const origin of ['http://localhost:3000', 'https://device.example.ts.net', 'https://other.example', 'https://ryjl3-tyaaa-aaaaa-aaaba-cai.icp0.io/'])
    assert.throws(() => validateMainnetPlan({ ...input, publicOrigin: origin }));
});

test('build environment does not inherit local flags, endpoints or credentials in VITE variables', () => {
  const parent = { PATH: '/usr/bin', NODE_ENV: 'development', VITE_DFX_NETWORK: 'local', VITE_DFX_PORT: '8080',
    VITE_IOU_PROD_VETKD: '0', VITE_IOU_BACKEND_CANISTER_ID: 'wrong',
    VITE_IOU_LAN_QC_II_ORIGIN: 'https://local.example', VITE_PRIVATE_TEST: 'must-not-ship',
    IOU_HOST: 'http://localhost:8080', IOU_LOCAL_APP_FRAME_ORIGINS: '*', IOU_LAN_QC_HTTPS_KEY_PATH: 'local.key' };
  const env = mainnetBuildEnvironment(validateMainnetPlan(input), parent);
  assert.equal(env.PATH, parent.PATH);
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(parent.NODE_ENV, 'development');
  assert.equal(env.VITE_DFX_NETWORK, 'ic');
  assert.equal(env.VITE_IOU_PROD_VETKD, '1');
  assert.equal(env.VITE_IOU_BACKEND_CANISTER_ID, input.backendCanisterId);
  assert.equal(env.VITE_IC_URL, 'https://icp-api.io');
  for (const key of ['VITE_DFX_PORT', 'VITE_IOU_LAN_QC_II_ORIGIN', 'VITE_PRIVATE_TEST', 'IOU_HOST', 'IOU_LOCAL_APP_FRAME_ORIGINS', 'IOU_LAN_QC_HTTPS_KEY_PATH'])
    assert.equal(env[key], undefined);
  assert.equal(parent.VITE_DFX_NETWORK, 'local');
});

test('build entry points require explicit ic environment', () => {
  requireMainnetBuildEnvironment('ic');
  for (const value of [undefined, '', 'local', 'production', 'https://icp-api.io'])
    assert.throws(() => requireMainnetBuildEnvironment(value));
});

test('preparation CLI rejects missing configuration and any deploy/funding mode before spawning tools', () => {
  const env = { ...process.env, PATH: '', IOU_MAINNET_CONFIG: '' };
  for (const args of [[], ['--deploy'], ['--fund'], ['--check', '--yes']]) {
    const result = spawnSync(process.execPath, ['scripts/mainnet.mjs', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Preparation only|Set IOU_MAINNET_CONFIG/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('allows a user identity only as deployer, never as either canister ID', () => {
  const user = Principal.selfAuthenticating(new Uint8Array(32)).toText();
  assert.equal(validateMainnetPlan({ ...input, expectedPrincipal: user }).expectedPrincipal, user);
  for (const key of ['backendCanisterId', 'assetsCanisterId'])
    assert.throws(() => validateMainnetPlan({ ...input, [key]: user }), /opaque canister principal/);
});

const testTemporaryRoot = path.resolve(process.env.IOU_TEST_TEMP_ROOT ?? tmpdir());
mkdirSync(testTemporaryRoot, { recursive: true });
const work = mkdtempSync(path.join(testTemporaryRoot, 'iou-mainnet-plan-'));
after(() => {
  const relative = path.relative(testTemporaryRoot, work);
  assert.ok(relative.startsWith('iou-mainnet-plan-') && !relative.includes(path.sep));
  rmSync(work, { recursive: true, force: true });
});
let sequence = 0;
function files() {
  const base = path.join(work, String(++sequence)), root = path.join(base, 'project');
  const source = path.join(root, 'target/mainnet/wasm32-unknown-unknown/release/iou_backend.wasm');
  const tempDirectory = path.join(base, 'cli-temporary');
  mkdirSync(path.dirname(source), { recursive: true }); mkdirSync(tempDirectory, { recursive: true });
  writeFileSync(source, 'synthetic-mainnet-wasm');
  return { base, root, source, tempDirectory, prepared: path.join(root, '.icp/mainnet-build/iou_backend.wasm') };
}
const directoryLink = (target, link) => symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

test('validates the exact isolated Vite output before the build can write', () => {
  const f = files(), expected = path.join(f.root, '.icp/mainnet-build/dist');
  assert.equal(assertMainnetBuildDirectory(f.root, expected), expected);
  for (const output of [f.root, path.join(f.root, 'public'), path.join(f.root, 'dist'),
    path.join(expected, '..'), path.join(f.base, 'another-output'), 'relative-output']) {
    assert.throws(() => assertMainnetBuildDirectory(f.root, output), /output|absolute/);
  }
});

test('rejects a Vite output ancestor junction before any source directory could be emptied', () => {
  const f = files(), publicDirectory = path.join(f.root, 'public');
  mkdirSync(publicDirectory); writeFileSync(path.join(publicDirectory, 'sentinel'), 'keep');
  directoryLink(publicDirectory, path.join(f.root, '.icp'));
  assert.throws(() => assertMainnetBuildDirectory(f.root, path.join(f.root, '.icp/mainnet-build/dist')), /symlink\/junction/);
  assert.equal(readFileSync(path.join(publicDirectory, 'sentinel'), 'utf8'), 'keep');
});

test('copies only to the isolated prepared WASM and can replace that regular single-link file', () => {
  const f = files();
  safeCopyMainnetWasm(f.source, f.prepared, f);
  assert.equal(readFileSync(f.prepared, 'utf8'), 'synthetic-mainnet-wasm');
  writeFileSync(f.source, 'updated-mainnet-wasm');
  safeCopyMainnetWasm(f.source, f.prepared, f);
  assert.equal(readFileSync(f.prepared, 'utf8'), 'updated-mainnet-wasm');
  const localWasm = path.join(f.root, 'target/wasm32-unknown-unknown/release/iou_backend.wasm');
  assert.throws(() => safeCopyMainnetWasm(f.source, localWasm, f), /CLI WASM destination/);
});

test('copies to a new scoped CLI out.wasm but never overwrites an existing one', () => {
  const f = files(), output = path.join(f.tempDirectory, 'cli-build', 'out.wasm');
  safeCopyMainnetWasm(f.source, output, f);
  assert.equal(readFileSync(output, 'utf8'), 'synthetic-mainnet-wasm');
  writeFileSync(f.source, 'changed');
  assert.throws(() => safeCopyMainnetWasm(f.source, output, f), /existing or linked CLI/);
  assert.equal(readFileSync(output, 'utf8'), 'synthetic-mainnet-wasm');
});

test('rejects arbitrary or project-local CLI WASM destinations and unrelated sources', () => {
  const f = files();
  for (const destination of [path.join(f.base, 'out.wasm'), path.join(f.tempDirectory, 'wrong.wasm'),
    path.join(f.root, 'target', 'out.wasm'), path.join(f.tempDirectory, '..', 'out.wasm')]) {
    assert.throws(() => safeCopyMainnetWasm(f.source, destination, f), /CLI WASM destination/);
  }
  assert.throws(() => safeCopyMainnetWasm(path.join(f.root, 'target/local.wasm'), f.prepared, f), /isolated mainnet build artifact/);
});

test('refuses linked output directories and hard-linked prepared or CLI files', () => {
  const f = files(), alias = path.join(f.tempDirectory, 'alias');
  directoryLink(f.root, alias);
  assert.throws(() => safeCopyMainnetWasm(f.source, path.join(alias, 'out.wasm'), f), /symlink\/junction/);
  const sentinel = path.join(f.base, 'local-sentinel.wasm'); writeFileSync(sentinel, 'do-not-overwrite');
  mkdirSync(path.dirname(f.prepared), { recursive: true }); linkSync(sentinel, f.prepared);
  assert.throws(() => safeCopyMainnetWasm(f.source, f.prepared, f), /linked prepared artifact/);
  const cliOutput = path.join(f.tempDirectory, 'out.wasm'); linkSync(sentinel, cliOutput);
  assert.throws(() => safeCopyMainnetWasm(f.source, cliOutput, f), /existing or linked CLI/);
  assert.equal(readFileSync(sentinel, 'utf8'), 'do-not-overwrite');
});

test('refuses a Cargo-style hard-linked source until the build normalizes it', () => {
  const f = files(), dependency = path.join(path.dirname(f.source), 'cached-dependency.wasm');
  linkSync(f.source, dependency);
  assert.throws(() => safeCopyMainnetWasm(f.source, f.prepared, f), /regular, unlinked file/);
  assert.equal(readFileSync(dependency, 'utf8'), 'synthetic-mainnet-wasm');
});
