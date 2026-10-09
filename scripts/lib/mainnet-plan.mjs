import { Principal } from '@dfinity/principal';
import { constants, copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const MAINNET_HOST = 'https://icp-api.io';
export const ICP_CLI_VERSION = '1.6.0';

function principal(value, label) {
  try {
    if (typeof value !== 'string' || Principal.fromText(value).toText() !== value ||
        value === 'aaaaa-aa' || value === '2vxsx-fae' || value === 'uxrrr-q7777-77774-qaaaq-cai') throw new Error();
    return value;
  } catch { throw new Error(`${label} must be an explicit, canonical non-anonymous principal (not a local fallback).`); }
}

function canisterPrincipal(value, label) {
  const result = principal(value, label);
  if (Principal.fromText(result).toUint8Array().at(-1) !== 1)
    throw new Error(`${label} must be a canonical opaque canister principal, not a user identity.`);
  return result;
}

/** Public deployment coordinates only. Never put seeds, private keys or passwords here. */
export function validateMainnetPlan(value) {
  if (!value || value.network !== 'ic') throw new Error('Mainnet configuration must explicitly use network "ic".');
  if (typeof value.identity !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.identity))
    throw new Error('Set the explicit ICP CLI identity name.');
  const expectedPrincipal = principal(value.expectedPrincipal, 'expectedPrincipal');
  const backendCanisterId = canisterPrincipal(value.backendCanisterId, 'backendCanisterId');
  const assetsCanisterId = canisterPrincipal(value.assetsCanisterId, 'assetsCanisterId');
  if (backendCanisterId === assetsCanisterId) throw new Error('Backend and assets must be different canisters.');
  const publicOrigin = `https://${assetsCanisterId}.icp0.io`;
  if (value.publicOrigin !== undefined && value.publicOrigin !== publicOrigin)
    throw new Error(`publicOrigin must be ${publicOrigin}; do not use a local or unreviewed alternate origin.`);
  return Object.freeze({ network: 'ic', identity: value.identity, expectedPrincipal,
    backendCanisterId, assetsCanisterId, publicOrigin });
}

/** An isolated production build never inherits .env.local or a developer's VITE_* overrides. */
export function mainnetBuildEnvironment(plan, parent = {}) {
  const env = Object.fromEntries(Object.entries(parent).filter(([key]) =>
    !key.startsWith('VITE_') && !key.startsWith('IOU_LAN_') && key !== 'IOU_HOST' && key !== 'IOU_LOCAL_APP_FRAME_ORIGINS'));
  return { ...env, NODE_ENV: 'production', IOU_MAINNET_BUILD: '1', VITE_DFX_NETWORK: 'ic',
    VITE_IOU_BACKEND_CANISTER_ID: plan.backendCanisterId, VITE_IOU_PROD_VETKD: '1',
    VITE_PUBLIC_ORIGIN: plan.publicOrigin, VITE_IC_URL: MAINNET_HOST,
    VITE_OC_IC_URL: MAINNET_HOST, VITE_OPENCHAT_HOST: MAINNET_HOST };
}

export function requireMainnetBuildEnvironment(environment) {
  if (environment !== 'ic') throw new Error('Use the explicit ICP environment "ic"; local/mainnet artifacts must not be mixed.');
}

const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an explicit absolute path.`);
  return path.resolve(value);
}
function fileInfo(value) {
  try { return lstatSync(value); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
function unlinkedDirectories(directory) {
  const volume = path.parse(directory).root;
  let current = volume;
  for (const segment of path.relative(volume, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = fileInfo(current);
    if (info && (info.isSymbolicLink() || !info.isDirectory()))
      throw new Error('Mainnet build paths must not contain symlink/junction or non-directory ancestors.');
  }
}

/** Run BEFORE Vite, which may empty its output directory before any post-build validation. */
export function assertMainnetBuildDirectory(root, output) {
  const project = absolute(root, 'Project root');
  const directory = absolute(output, 'Mainnet build output');
  if (!samePath(directory, path.join(project, '.icp/mainnet-build/dist')))
    throw new Error('Mainnet asset output must be exactly .icp/mainnet-build/dist.');
  if (!fileInfo(project)?.isDirectory()) throw new Error('Project root must be an existing directory.');
  unlinkedDirectories(directory);
  return directory;
}

/**
 * Preserve the local WASM. The only replaceable output is the dedicated
 * prepared mainnet file; the CLI receives a new out.wasm within its explicitly
 * scoped temporary directory. No existing CLI destination may be overwritten.
 */
export function safeCopyMainnetWasm(source, destination, { root, tempDirectory }) {
  const project = absolute(root, 'Project root');
  const input = absolute(source, 'Mainnet WASM source');
  const output = absolute(destination, 'Mainnet WASM destination');
  const expectedSource = path.join(project, 'target/mainnet/wasm32-unknown-unknown/release/iou_backend.wasm');
  const prepared = path.join(project, '.icp/mainnet-build/iou_backend.wasm');
  if (!samePath(input, expectedSource)) throw new Error('WASM source must be the isolated mainnet build artifact.');
  const isPrepared = samePath(output, prepared);
  if (!isPrepared) {
    const temporary = absolute(tempDirectory, 'CLI temporary directory');
    if (samePath(temporary, path.parse(temporary).root) || !inside(temporary, output) ||
      inside(project, output) || path.basename(output) !== 'out.wasm') {
      throw new Error('CLI WASM destination must be a new out.wasm under the scoped temporary directory, outside the project.');
    }
    unlinkedDirectories(temporary);
  }
  unlinkedDirectories(path.dirname(input));
  unlinkedDirectories(path.dirname(output));
  const sourceInfo = fileInfo(input), targetInfo = fileInfo(output);
  if (!sourceInfo || !sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink !== 1 || sourceInfo.size < 1)
    throw new Error('Mainnet WASM source must be a nonempty, regular, unlinked file.');
  if (targetInfo && (!isPrepared || targetInfo.isSymbolicLink() || !targetInfo.isFile() || targetInfo.nlink !== 1))
    throw new Error('Refusing an existing or linked CLI WASM destination, or a linked prepared artifact.');
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(input, output, isPrepared && targetInfo ? 0 : constants.COPYFILE_EXCL);
  return output;
}
