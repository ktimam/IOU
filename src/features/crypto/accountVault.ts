import {
  accountRootFingerprint, accountVaultScopeId, createAccountRecoveryCode,
  createAccountVaultPayload, createRecoveryBackup, decodeAccountVault, encodeAccountVault,
  openAccountVaultKeypair, openRecoveryBackup, requireAccountRoot, vaultUnb64,
  createManagedRecovery, openManagedRecoveryBackup, openManagedRecoverySecret,
  managedRecoveryCredentialId, validateManagedRecoveryOrigin,
  type AccountVaultPayload, type AccountVaultScope, type VaultManagedRecovery,
} from "./accountVaultCrypto";
import { clearVaultPasskeyEnrollmentRequired, deleteVaultDeviceRoots, readVaultDeviceRoot, readVaultPasskeyEnrollmentRequired, VaultStorageUnavailableError, writeVaultDeviceRoot } from "./accountVaultStorage";
import { enrollVaultPasskey, unlockVaultPasskeys } from "./accountVaultPasskey";

export { accountVaultScopeId, createAccountRecoveryCode, createSheetKeyEnvelope, createSheetKeyId, openSheetKeyEnvelope, accountWrappingKeyId, vaultB64, managedRecoveryCredentialId, validateManagedRecoveryOrigin } from "./accountVaultCrypto";
export type { AccountVaultScope, AccountVaultPayload, SheetKeyEnvelopeContext } from "./accountVaultCrypto";
export { VaultStorageUnavailableError } from "./accountVaultStorage";

export interface AccountVaultActor {
  get_account_vault(): Promise<[] | [{ revision: bigint; payload: ArrayLike<number> }]>;
  set_account_vault(expectedRevision: bigint, payload: number[]): Promise<{ Ok: bigint } | { Err: string }>;
  register_account_wrapping_key(vaultRevision: bigint, keyId: string, publicKey: number[]): Promise<{ Ok: null } | { Err: string }>;
}
export interface AccountVaultRecord { revision: bigint; payload: AccountVaultPayload }
export class VaultUnlockRequiredError extends Error {
  readonly code = "ACCOUNT_VAULT_LOCKED";
  constructor() { super("Unlock your IOU account with its saved password-manager recovery entry, use a device that remembers its keys, or choose explicit paid emergency recovery. No paid recovery was started."); this.name = "VaultUnlockRequiredError"; }
}
export class VaultNotInitializedError extends Error {
  readonly code = "ACCOUNT_VAULT_NOT_INITIALIZED";
  constructor() { super("Set up encrypted IOU account keys first"); this.name = "VaultNotInitializedError"; }
}
export class VaultConflictError extends Error {
  constructor() { super("Account backup changed on another device. Reload and try again."); this.name = "VaultConflictError"; }
}
export class VaultBackupOutcomeUnknownError extends Error {
  constructor() { super("The backup update may have completed; keep the displayed code. The previous code may no longer work. No automatic retry was started."); this.name = "VaultBackupOutcomeUnknownError"; }
}
export class VaultPasskeyBackupOutcomeUnknownError extends Error {
  constructor() { super("The encryption passkey backup may have been saved, but IOU could not verify it. Keep the passkey in your password manager and refresh to check before trying again. No paid recovery was started."); this.name = "VaultPasskeyBackupOutcomeUnknownError"; }
}
export class VaultManagedRecoveryOutcomeUnknownError extends Error {
  constructor() { super("The recovery backup update could not be verified. Refresh before trying again; IOU will reuse a saved candidate, never silently replace it. No paid recovery was started."); this.name = "VaultManagedRecoveryOutcomeUnknownError"; }
}

let sessionGeneration = 0;
const memory = new Map<string, { fingerprint: string; root: Uint8Array }>();
const pending = new Map<string, Promise<Uint8Array | null>>();
const pendingManagedPreparation = new Map<string, Promise<{ credentialId: string; secret: string; verifiedOrigins: string[] }>>();
const cleanup = new Set<() => void>();
export function registerAccountVaultCleanup(callback: () => void): () => void {
  cleanup.add(callback);
  return () => { cleanup.delete(callback); };
}
function current(generation: number): void {
  if (generation !== sessionGeneration) throw new Error("Account session changed");
}
/** Capture before an external paid request; assert before handing its result to this module. */
export function readAccountVaultSessionGeneration(): number { return sessionGeneration; }
export function assertAccountVaultSessionGeneration(generation: number): void { current(generation); }
/** Explicit setup retry only. Does not assert that a published server vault is absent. */
export async function loadUnpublishedAccountRoot(scope: AccountVaultScope): Promise<Uint8Array | null> {
  const generation = sessionGeneration;
  const root = await readVaultDeviceRoot(scope);
  try { current(generation); if (root) requireAccountRoot(root); return root?.slice() ?? null; }
  finally { root?.fill(0); }
}
function remember(scope: AccountVaultScope, root: Uint8Array, fingerprint: string, generation: number): void {
  current(generation);
  const id = accountVaultScopeId(scope);
  memory.get(id)?.root.fill(0);
  memory.set(id, { fingerprint, root: root.slice() });
}
/** Invalidates in-flight work as well as wiping the module's own byte copies. */
export function clearAccountVaultMemory(): void {
  sessionGeneration++;
  for (const callback of cleanup) { try { callback(); } catch { /* Always finish wiping the vault. */ } }
  for (const cached of memory.values()) cached.root.fill(0);
  for (const operation of pending.values()) void operation.then((root) => root?.fill(0), () => undefined);
  memory.clear(); pending.clear(); pendingManagedPreparation.clear();
}
/** Explicit logout/forget; delegation expiry should only clear session memory. */
export async function clearAccountVaultDevice(principal?: string): Promise<void> {
  clearAccountVaultMemory();
  await deleteVaultDeviceRoots(principal);
}
export async function clearAccountVaultLocal(scope: AccountVaultScope): Promise<void> {
  await clearAccountVaultDevice(scope.principal);
}
async function readRecord(actor: AccountVaultActor, scope: AccountVaultScope, generation: number): Promise<AccountVaultRecord | null> {
  accountVaultScopeId(scope);
  const result = await actor.get_account_vault();
  current(generation);
  if (result.length === 0) return null;
  if (result.length !== 1 || typeof result[0].revision !== "bigint" || result[0].revision < 1n) throw new Error("Invalid account vault revision");
  return { revision: result[0].revision, payload: decodeAccountVault(result[0].payload, scope) };
}
/** Always reads the current encrypted server record; never invokes VetKD. */
export async function loadAccountVault(actor: AccountVaultActor, scope: AccountVaultScope): Promise<AccountVaultRecord | null> {
  return readRecord(actor, scope, sessionGeneration);
}
async function rootForRecord(record: AccountVaultRecord, scope: AccountVaultScope, generation: number): Promise<Uint8Array> {
  current(generation);
  const remembered = memory.get(accountVaultScopeId(scope));
  if (remembered?.fingerprint === record.payload.rootFingerprint) return remembered.root.slice();
  let root: Uint8Array | null;
  try { root = await readVaultDeviceRoot(scope, record.payload.rootFingerprint); }
  catch (error) {
    current(generation);
    if (error instanceof VaultStorageUnavailableError) throw error;
    throw new VaultUnlockRequiredError();
  }
  try {
    current(generation);
    if (!root || await accountRootFingerprint(root, scope) !== record.payload.rootFingerprint) throw new VaultUnlockRequiredError();
    remember(scope, root, record.payload.rootFingerprint, generation);
    return root.slice();
  } finally { root?.fill(0); }
}
/** Missing vault = null; existing but locked vault = explicit unlock error, never a paid fallback. */
export async function loadAccountRoot(actor: AccountVaultActor, scope: AccountVaultScope): Promise<Uint8Array | null> {
  const generation = sessionGeneration;
  const id = accountVaultScopeId(scope);
  let operation = pending.get(id);
  if (!operation) {
    const generation = sessionGeneration;
    operation = (async () => {
      const record = await readRecord(actor, scope, generation);
      return record ? rootForRecord(record, scope, generation) : null;
    })();
    pending.set(id, operation);
  }
  try { const root = await operation; current(generation); return root?.slice() ?? null; }
  finally { if (pending.get(id) === operation) pending.delete(id); }
}
export async function isAccountPasskeyEnrollmentRequired(scope: AccountVaultScope): Promise<boolean> {
  const generation = sessionGeneration;
  const required = await readVaultPasskeyEnrollmentRequired(scope);
  current(generation);
  return required;
}
async function saveLocal(scope: AccountVaultScope, root: Uint8Array, fingerprint: string, generation: number, requirePasskeyEnrollment = false): Promise<void> {
  current(generation);
  await writeVaultDeviceRoot(scope, root, fingerprint, () => generation === sessionGeneration, requirePasskeyEnrollment);
  current(generation);
  remember(scope, root, fingerprint, generation);
}
async function publish(actor: AccountVaultActor, record: AccountVaultRecord, generation: number): Promise<void> {
  current(generation);
  const result = await actor.register_account_wrapping_key(record.revision, record.payload.sheetKey.keyId, Array.from(vaultUnb64(record.payload.sheetKey.publicKeyB64, 65)));
  current(generation);
  if ("Err" in result) throw new Error(`Account wrapping key registration failed: ${result.Err}`);
}
async function validateRoot(record: AccountVaultRecord, root: Uint8Array, scope: AccountVaultScope, generation: number): Promise<void> {
  requireAccountRoot(root);
  await openAccountVaultKeypair(record.payload, root, scope);
  current(generation);
}
function summary(record: AccountVaultRecord, created: boolean) {
  return { created, revision: record.revision, publicKeyB64: record.payload.sheetKey.publicKeyB64, keyId: record.payload.sheetKey.keyId };
}
/** Caller must explicitly acquire root32 first. This module has no paid actor methods. */
export async function initializeAccountVault(actor: AccountVaultActor, scope: AccountVaultScope, root32: Uint8Array) {
  const generation = sessionGeneration;
  const root = root32.slice();
  try {
    requireAccountRoot(root);
    const existing = await readRecord(actor, scope, generation);
    if (existing) {
      await validateRoot(existing, root, scope, generation);
      await saveLocal(scope, root, existing.payload.rootFingerprint, generation);
      await publish(actor, existing, generation);
      return summary(existing, false);
    }
    const payload = await createAccountVaultPayload(root, scope);
    current(generation);
    // Fail before a remote mutation when durable browser key storage is unavailable.
    await saveLocal(scope, root, payload.rootFingerprint, generation);
    const result = await actor.set_account_vault(0n, Array.from(encodeAccountVault(payload)));
    current(generation);
    if ("Err" in result) {
      // Another device may have initialized first. Preserve its canonical keypair.
      const winner = await readRecord(actor, scope, generation);
      if (!winner) throw new Error(`Account vault initialization failed: ${result.Err}`);
      await validateRoot(winner, root, scope, generation);
      await saveLocal(scope, root, winner.payload.rootFingerprint, generation);
      await publish(actor, winner, generation);
      return summary(winner, false);
    }
    const record = { revision: result.Ok, payload };
    await publish(actor, record, generation);
    return summary(record, true);
  } finally { root.fill(0); }
}
/** Explicit emergency recovery supplies an already-verified K_wrap. No network derivation here. */
export async function restoreAccountVaultWithRoot(actor: AccountVaultActor, scope: AccountVaultScope, root32: Uint8Array, requirePasskeyEnrollment = false): Promise<void> {
  const generation = sessionGeneration;
  const root = root32.slice();
  try {
    const record = await readRecord(actor, scope, generation);
    if (!record) throw new VaultNotInitializedError();
    await validateRoot(record, root, scope, generation);
    await saveLocal(scope, root, record.payload.rootFingerprint, generation, requirePasskeyEnrollment);
    await publish(actor, record, generation);
  } finally { root.fill(0); }
}
/** Reads latest encrypted private key and verifies it matches the public registry key material. */
export async function loadAccountVaultSheetKeypair(actor: AccountVaultActor, scope: AccountVaultScope) {
  const generation = sessionGeneration;
  const record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  const root = await rootForRecord(record, scope, generation);
  try { const pair = await openAccountVaultKeypair(record.payload, root, scope); current(generation); return pair; }
  finally { root.fill(0); }
}
/** Gate/setup path also retries idempotent publication after an interrupted initialization. */
export async function getAccountVaultSheetKeypair(actor: AccountVaultActor, scope: AccountVaultScope) {
  const generation = sessionGeneration;
  const record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  const root = await rootForRecord(record, scope, generation);
  try {
    const pair = await openAccountVaultKeypair(record.payload, root, scope);
    current(generation);
    await publish(actor, record, generation);
    return pair;
  } finally { root.fill(0); }
}
async function replaceBackups(actor: AccountVaultActor, record: AccountVaultRecord, generation: number): Promise<bigint> {
  current(generation);
  const result = await actor.set_account_vault(record.revision, Array.from(encodeAccountVault(record.payload)));
  current(generation);
  if ("Err" in result) throw new VaultConflictError();
  // The immutable public key did not change. Do not hide a newly committed recovery
  // code behind an unrelated publication failure; the gate retries publication.
  return result.Ok;
}
export async function addRecoveryCodeBackup(actor: AccountVaultActor, scope: AccountVaultScope, onPrepared?: (recoveryCode: string) => void): Promise<{ recoveryCode: string; revision: bigint }> {
  const generation = sessionGeneration;
  const record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  const root = await rootForRecord(record, scope, generation);
  try {
    const recoveryCode = createAccountRecoveryCode();
    record.payload.recovery = await createRecoveryBackup(root, scope, recoveryCode);
    current(generation);
    // Make the new recovery capability available to the explicit create UI
    // before the request can commit. Never embed it in diagnostics or errors.
    onPrepared?.(recoveryCode);
    current(generation);
    try { return { recoveryCode, revision: await replaceBackups(actor, record, generation) }; }
    catch (error) {
      current(generation);
      if (error instanceof VaultConflictError) throw error; // definitive CAS refusal
      try {
        const latest = await readRecord(actor, scope, generation);
        if (latest?.payload.rootFingerprint === record.payload.rootFingerprint &&
            latest.payload.recovery?.iv === record.payload.recovery.iv &&
            latest.payload.recovery?.ciphertext === record.payload.recovery.ciphertext) {
          return { recoveryCode, revision: latest.revision };
        }
      } catch { current(generation); }
      throw new VaultBackupOutcomeUnknownError();
    }
  } finally { root.fill(0); }
}
export async function addPasskeyBackup(actor: AccountVaultActor, scope: AccountVaultScope, displayName?: string): Promise<{ credentialId: string; revision: bigint }> {
  const generation = sessionGeneration;
  const record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  if (record.payload.passkeys.length >= 8) throw new Error("Account already has the maximum number of passkey backups");
  const root = await rootForRecord(record, scope, generation);
  try {
    const backup = await enrollVaultPasskey(root, scope, displayName);
    current(generation);
    record.payload.passkeys.push(backup);
    try { await replaceBackups(actor, record, generation); }
    catch (cause) {
      current(generation);
      // A definitive CAS refusal did not enroll this credential. Never overwrite
      // the other device's backup or automatically create another passkey.
      if (cause instanceof VaultConflictError) throw cause;
    }
    // A provider credential alone is not a usable backup. Verify the exact
    // encrypted record even if the update acknowledged success; a lost reply
    // is also reconciled here without repeating the write or provider prompt.
    try {
      const latest = await readRecord(actor, scope, generation);
      if (latest && latest.revision > record.revision &&
          latest.payload.rootFingerprint === record.payload.rootFingerprint &&
          latest.payload.sheetKey.keyId === record.payload.sheetKey.keyId &&
          latest.payload.sheetKey.publicKeyB64 === record.payload.sheetKey.publicKeyB64 &&
          latest.payload.passkeys.some((saved) => saved.credentialId === backup.credentialId &&
            saved.rpId === backup.rpId && saved.prfSalt === backup.prfSalt &&
            saved.iv === backup.iv && saved.ciphertext === backup.ciphertext)) {
        await clearVaultPasskeyEnrollmentRequired(scope, record.payload.rootFingerprint, () => generation === sessionGeneration);
        current(generation);
        return { credentialId: backup.credentialId, revision: latest.revision };
      }
    } catch { current(generation); }
    throw new VaultPasskeyBackupOutcomeUnknownError();
  } finally { root.fill(0); }
}
export async function unlockAccountVaultWithRecoveryCode(actor: AccountVaultActor, scope: AccountVaultScope, code: string): Promise<void> {
  const generation = sessionGeneration;
  const record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  if (!record.payload.recovery) throw new Error("No recovery-code backup was enrolled for this account");
  const root = await openRecoveryBackup(record.payload.recovery, scope, code);
  try {
    await validateRoot(record, root, scope, generation);
    await saveLocal(scope, root, record.payload.rootFingerprint, generation);
    await publish(actor, record, generation);
  } finally { root.fill(0); }
}
export async function unlockAccountVaultWithPasskey(actor: AccountVaultActor, scope: AccountVaultScope, credentialId?: string): Promise<void> {
  const generation = sessionGeneration;
  const record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  const backups = credentialId ? record.payload.passkeys.filter((entry) => entry.credentialId === credentialId) : record.payload.passkeys;
  if (!backups.length) throw new Error("No matching passkey backup was enrolled for this account");
  // One provider prompt selects among all enrolled credentials on this IOU RP.
  const root = await unlockVaultPasskeys(backups, scope);
  try {
    await validateRoot(record, root, scope, generation);
    await saveLocal(scope, root, record.payload.rootFingerprint, generation);
    await publish(actor, record, generation);
  } finally { root.fill(0); }
}

export interface ManagedRecoveryDescriptor { credentialId: string; verified: boolean }
async function managedDescriptor(value: VaultManagedRecovery, scope: AccountVaultScope, origin: string, generation: number): Promise<ManagedRecoveryDescriptor> {
  const credentialId = await managedRecoveryCredentialId(scope, value.id);
  current(generation);
  return { credentialId, verified: value.verifiedOrigins.includes(origin) };
}
/** Public scoped identifier only: safe for the locked recovery form, with no key derivation. */
export async function readManagedRecoveryDescriptor(actor: AccountVaultActor, scope: AccountVaultScope, origin: string): Promise<ManagedRecoveryDescriptor | null> {
  const generation = sessionGeneration;
  validateManagedRecoveryOrigin(origin);
  const record = await readRecord(actor, scope, generation);
  return record?.payload.managedRecovery ? managedDescriptor(record.payload.managedRecovery, scope, origin, generation) : null;
}
function sameManagedBackup(a: VaultManagedRecovery | undefined, b: VaultManagedRecovery): boolean {
  return !!a && a.id === b.id && a.backup.iv === b.backup.iv && a.backup.ciphertext === b.backup.ciphertext &&
    a.protectedSecret.iv === b.protectedSecret.iv && a.protectedSecret.ciphertext === b.protectedSecret.ciphertext &&
    b.verifiedOrigins.every(origin => a.verifiedOrigins.includes(origin));
}
/** One CAS followed by exact read-back, including acknowledged writes and ambiguous replies. */
async function commitManagedRecovery(actor: AccountVaultActor, record: AccountVaultRecord, scope: AccountVaultScope, generation: number): Promise<AccountVaultRecord> {
  const backup = record.payload.managedRecovery!;
  try { await replaceBackups(actor, record, generation); }
  catch (error) {
    current(generation);
    if (error instanceof VaultConflictError) throw error;
  }
  try {
    const latest = await readRecord(actor, scope, generation);
    if (latest && latest.revision > record.revision &&
        latest.payload.rootFingerprint === record.payload.rootFingerprint &&
        latest.payload.sheetKey.keyId === record.payload.sheetKey.keyId &&
        latest.payload.sheetKey.publicKeyB64 === record.payload.sheetKey.publicKeyB64 &&
        latest.payload.sheetKey.privateKey.iv === record.payload.sheetKey.privateKey.iv &&
        latest.payload.sheetKey.privateKey.ciphertext === record.payload.sheetKey.privateKey.ciphertext &&
        sameManagedBackup(latest.payload.managedRecovery, backup)) return latest;
  } catch { current(generation); }
  throw new VaultManagedRecoveryOutcomeUnknownError();
}
/** Requires an already-unlocked account; never derives or replaces its root. */
export async function prepareManagedRecovery(actor: AccountVaultActor, scope: AccountVaultScope, origin: string): Promise<ManagedRecoveryDescriptor & { secret: string }> {
  const generation = sessionGeneration;
  validateManagedRecoveryOrigin(origin);
  // Duplicate mounted controls share one candidate/CAS, including an ambiguous
  // failure. A later explicit retry re-reads its saved candidate instead of rotating it.
  const key = JSON.stringify([accountVaultScopeId(scope), generation]);
  let operation = pendingManagedPreparation.get(key);
  if (!operation) {
    operation = prepareManagedRecoveryCandidate(actor, scope, generation);
    pendingManagedPreparation.set(key, operation);
  }
  try {
    const candidate = await operation;
    current(generation);
    return { credentialId: candidate.credentialId, secret: candidate.secret, verified: candidate.verifiedOrigins.includes(origin) };
  } finally {
    if (pendingManagedPreparation.get(key) === operation) pendingManagedPreparation.delete(key);
  }
}
async function prepareManagedRecoveryCandidate(actor: AccountVaultActor, scope: AccountVaultScope, generation: number) {
  let record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  const root = await rootForRecord(record, scope, generation);
  try {
    await validateRoot(record, root, scope, generation);
    if (!record.payload.managedRecovery) {
      const candidate = await createManagedRecovery(root, scope);
      current(generation);
      record.payload.managedRecovery = candidate.managedRecovery;
      record = await commitManagedRecovery(actor, record, scope, generation);
    }
    // Reopening validates both ciphertexts, including a previously saved candidate.
    const secret = await openManagedRecoverySecret(record.payload.managedRecovery!, root, scope);
    current(generation);
    const credentialId = await managedRecoveryCredentialId(scope, record.payload.managedRecovery!.id);
    current(generation);
    return { credentialId, secret, verifiedOrigins: [...record.payload.managedRecovery!.verifiedOrigins] };
  } finally { root.fill(0); }
}
/** Confirm only a credential actually returned by the manager/autofill flow. */
export async function confirmManagedRecovery(actor: AccountVaultActor, scope: AccountVaultScope, origin: string, credentialId: string, secret: string): Promise<void> {
  const generation = sessionGeneration;
  validateManagedRecoveryOrigin(origin);
  let record = await readRecord(actor, scope, generation);
  if (!record) throw new VaultNotInitializedError();
  const backup = record.payload.managedRecovery;
  if (!backup) throw new Error("No password-manager recovery backup is saved for this account");
  const descriptor = await managedDescriptor(backup, scope, origin, generation);
  if (credentialId !== descriptor.credentialId) throw new Error("The selected recovery credential belongs to a different account or backup");
  const root = await openManagedRecoveryBackup(backup, scope, secret);
  try {
    await validateRoot(record, root, scope, generation);
    // Also verify the encrypted re-save capability before declaring setup complete.
    const protectedSecret = await openManagedRecoverySecret(backup, root, scope);
    current(generation);
    if (protectedSecret !== secret) throw new Error("Recovery credential does not match this account");
    if (!descriptor.verified) {
      if (backup.verifiedOrigins.length >= 16) throw new Error("The recovery credential has reached its verified-origin limit");
      backup.verifiedOrigins.push(origin);
      record = await commitManagedRecovery(actor, record, scope, generation);
    }
    await saveLocal(scope, root, record.payload.rootFingerprint, generation);
    await clearVaultPasskeyEnrollmentRequired(scope, record.payload.rootFingerprint, () => generation === sessionGeneration);
    current(generation);
    await publish(actor, record, generation);
  } finally { root.fill(0); }
}
/** Unlocks the original root with no PRF/provider prompt and no paid actor method. */
export async function unlockManagedRecovery(actor: AccountVaultActor, scope: AccountVaultScope, origin: string, credentialId: string, secret: string): Promise<void> {
  await confirmManagedRecovery(actor, scope, origin, credentialId, secret);
}
