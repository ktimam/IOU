// Preparation only: no create, deploy, fund, controller-change, or identity-export operations.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICP_CLI_VERSION, assertMainnetBuildDirectory, mainnetBuildEnvironment, requireMainnetBuildEnvironment, safeCopyMainnetWasm, validateMainnetPlan } from './lib/mainnet-plan.mjs';
import { stageMainnetPublication } from './lib/mainnet-publication.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? '--check';
const allowed = ['--check', '--check-identity', '--build-assets', '--build-backend'];
const usage = 'Preparation only: --check (offline default), --check-identity, --build-assets, or --build-backend. See docs/06-deployment-and-costs.md.';
if (process.argv.length > 3 || !allowed.includes(mode)) { console.error(usage); process.exit(1); }

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited unsuccessfully (${result.status ?? result.signal}).`);
  return result.stdout?.trim();
}

function checkRecordedCanisters(plan) {
  const cli = process.env.IOU_ICP_CLI ?? 'icp';
  for (const [name, expected] of [['iou_backend', plan.backendCanisterId], ['iou_assets', plan.assetsCanisterId]]) {
    const actual = run(cli, ['canister', 'status', name, '--id-only', '-e', 'ic', '--project-root-override', root],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    if (actual !== expected) throw new Error(`${name}: recorded mainnet ID does not match reviewed configuration. No build was performed.`);
  }
}

try {
  const configPath = process.env.IOU_MAINNET_CONFIG;
  if (!configPath) throw new Error('Set IOU_MAINNET_CONFIG to a reviewed public configuration copied from scripts/mainnet.config.example.json. No operation was performed.');
  const plan = validateMainnetPlan(JSON.parse(readFileSync(path.resolve(configPath), 'utf8')));
  if (mode === '--check') {
    const changed = run('git', ['status', '--porcelain'], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(JSON.stringify({ mode: 'offline-preflight', ...plan,
      canistersInScope: ['iou_backend', 'iou_assets'], vetkdKeyForNewCanister: 'key_1',
      sourceClean: changed === '',
      nextGate: 'Verify the same identity on a second device; review controllers, existing key state, funding and exact source commit before deployment.',
      deploymentPerformed: false }, null, 2));
    if (changed) {
      console.warn('Release blocked: the workspace contains uncommitted/untracked changes. A successful configuration check is not a release approval.');
      process.exitCode = 2;
    }
  } else if (mode === '--check-identity') {
    const cli = process.env.IOU_ICP_CLI ?? 'icp';
    const version = run(cli, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (version !== `icp ${ICP_CLI_VERSION}`) throw new Error(`Use reviewed ICP CLI ${ICP_CLI_VERSION}; found ${version}.`);
    const actual = run(cli, ['identity', 'principal', '--identity', plan.identity], { stdio: ['inherit', 'pipe', 'inherit'] });
    if (actual !== plan.expectedPrincipal) throw new Error('Selected identity does not match expectedPrincipal. No canister call was made.');
    console.log('The selected CLI principal matches. This does not prove second-device recovery or canister controller access. No canister call was made.');
  } else {
    requireMainnetBuildEnvironment(process.env.ICP_CLI_ENVIRONMENT);
    // The CLI provides this for real project builds; standalone offline staging does not.
    // Resolve recorded IDs before producing an artifact for an installable CLI build.
    if (process.env.ICP_WASM_OUTPUT_PATH) checkRecordedCanisters(plan);
    if (mode === '--build-assets') {
      const env = mainnetBuildEnvironment(plan, process.env);
      const outputDirectory = path.join(root, '.icp/mainnet-build/dist');
      assertMainnetBuildDirectory(root, outputDirectory);
      run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', outputDirectory], { env });
      stageMainnetPublication({ root, outputDirectory, publicOrigin: plan.publicOrigin, backendCanisterId: plan.backendCanisterId });
      console.log(`Production assets staged at ${outputDirectory}. Nothing uploaded.`);
    } else {
      const script = path.join(root, 'scripts/build-mainnet-backend.sh');
      if (process.platform === 'win32') {
        // WSL owns the existing Rust toolchain. No deployment key is exported into WSL.
        const linuxScript = run('wsl.exe', ['--distribution', 'Ubuntu', '--exec', 'wslpath', '-u', script], { stdio: ['ignore', 'pipe', 'pipe'] });
        run('wsl.exe', ['--distribution', 'Ubuntu', '--exec', 'bash', linuxScript]);
      } else run('bash', [script]);
      const wasm = path.join(root, 'target/mainnet/wasm32-unknown-unknown/release/iou_backend.wasm');
      safeCopyMainnetWasm(wasm, process.env.ICP_WASM_OUTPUT_PATH ?? path.join(root, '.icp/mainnet-build/iou_backend.wasm'),
        { root, tempDirectory: tmpdir() });
      console.log('Mainnet WASM built separately from the local WASM. Nothing installed.');
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
