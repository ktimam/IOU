import { Principal } from "@dfinity/principal";
import { createSheetKeyId, createSheetKeyEnvelope, openSheetKeyEnvelope, getAccountVaultSheetKeypair,
  loadAccountVaultSheetKeypair, readAccountVaultSessionGeneration, assertAccountVaultSessionGeneration,
  accountVaultScopeId, registerAccountVaultCleanup } from "./accountVault";
import { accountVaultScope } from "./vaultAccess";
import { deriveProdSheetKey, prepareProdSheetKey } from "./prodVetkd";
import { encryptName, decryptWithSheetKey, decryptEntryPayload, loadExistingLegacySheetKey } from "./devVetkd";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const PREFIX = "iou-sheet-envelope-v1:";
export type SheetKeyInfo = { scheme: "vetkd-v1" | "random-v2"; key_id: string };

export function requireOk<T>(result: { Ok: T } | { Err: string }): T {
  if (result && Object.hasOwn(result, "Ok")) return (result as { Ok: T }).Ok;
  throw new Error((result as { Err: string })?.Err || "The encrypted key operation failed.");
}

export async function sheetKeyInfo(actor: any, sheetId: string): Promise<SheetKeyInfo> {
  const info = requireOk<SheetKeyInfo>(await actor.get_sheet_key_info(sheetId));
  if (!info || !["vetkd-v1", "random-v2"].includes(info.scheme) || typeof info.key_id !== "string" || !info.key_id) {
    throw new SheetKeyIntegrityError("Unsupported sheet encryption format. Update IOU; no key was replaced.");
  }
  return info;
}

export class LegacySheetRecoveryRequiredError extends Error {
  constructor(readonly sheetId: string) {
    super("This older sheet has no readable saved key on this device. Use Recover this sheet (paid VetKD) here to review its one-time key recovery, or open it on a device that still holds its original key. No paid recovery was started.");
    this.name = "LegacySheetRecoveryRequiredError";
  }
}
export class LegacySheetBackupPendingError extends Error {
  constructor(readonly sheetId: string) {
    super("The recovered sheet key is kept in this session, but its encrypted backup could not be verified. Keep this page open and retry securing this sheet; another key recovery is not needed in this session.");
    this.name = "LegacySheetBackupPendingError";
  }
}
class SheetKeyIntegrityError extends Error {
  constructor(message: string) { super(message); this.name = "SheetKeyIntegrityError"; }
}

// Retain only keys already recovered/verified in this account session, so a lost
// backup response never requires paying again. Logout/account change wipes them.
const recoveredKeys = new Map<string, Uint8Array>();
const sheetLocks = new Map<string, Promise<void>>();
const migrations = new Map<string, Promise<void>>();
registerAccountVaultCleanup(() => {
  for (const key of recoveredKeys.values()) key.fill(0);
  recoveredKeys.clear(); sheetLocks.clear(); migrations.clear();
});
function sheetScope(principal: string, sheetId: string): string {
  return JSON.stringify([accountVaultScopeId(accountVaultScope(principal)), sheetId]);
}
function retainedId(principal: string, sheetId: string, keyId: string): string {
  return JSON.stringify([sheetScope(principal, sheetId), keyId]);
}
async function withSheetLock<T>(principal: string, sheetId: string, generation: number, run: () => Promise<T>): Promise<T> {
  const id = JSON.stringify([generation, sheetScope(principal, sheetId)]);
  const previous = sheetLocks.get(id) ?? Promise.resolve();
  const operation = previous.then(() => { assertAccountVaultSessionGeneration(generation); return run(); });
  const settled = operation.then(() => undefined, () => undefined);
  sheetLocks.set(id, settled);
  try { return await operation; }
  finally { if (sheetLocks.get(id) === settled) sheetLocks.delete(id); }
}
function equalKey(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 32 || b.length !== 32) return false;
  let mismatch = 0;
  for (let i = 0; i < 32; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
function rememberRecovered(principal: string, sheetId: string, keyId: string, key: Uint8Array, generation: number): void {
  assertAccountVaultSessionGeneration(generation);
  if (key.length !== 32) throw new Error("Invalid recovered sheet key");
  const id = retainedId(principal, sheetId, keyId);
  recoveredKeys.get(id)?.fill(0); recoveredKeys.set(id, key.slice());
}
function forgetRecovered(principal: string, sheetId: string, keyId: string): void {
  const id = retainedId(principal, sheetId, keyId);
  recoveredKeys.get(id)?.fill(0); recoveredKeys.delete(id);
}
type SheetSnapshot = { info: SheetKeyInfo; sheet: any; wrapped: Uint8Array; envelope: string | null };
async function readSnapshot(actor: any, sheetId: string, generation: number): Promise<SheetSnapshot> {
  const info = await sheetKeyInfo(actor, sheetId); assertAccountVaultSessionGeneration(generation);
  const sheet = (await actor.get_sheet(sheetId))[0]; assertAccountVaultSessionGeneration(generation);
  if (!sheet) throw new Error("Sheet not found or access is unavailable.");
  const wrapped = new Uint8Array((await actor.get_sheet_wrapped_key(sheetId))[0] ?? []);
  assertAccountVaultSessionGeneration(generation);
  let text = "";
  const marker = encoder.encode("iou-sheet-envelope");
  const modern = marker.every((byte, i) => wrapped[i] === byte);
  try { text = decoder.decode(wrapped); }
  catch { if (modern) throw new SheetKeyIntegrityError("Damaged encrypted sheet key. No recovery or replacement was started."); }
  if (text.startsWith("iou-sheet-envelope") && !text.startsWith(PREFIX)) throw new SheetKeyIntegrityError("Unsupported or damaged encrypted sheet key. No recovery or replacement was started.");
  return { info, sheet, wrapped, envelope: text.startsWith(PREFIX) ? text : null };
}
async function openSnapshot(actor: any, principal: string, snapshot: SheetSnapshot, generation: number): Promise<Uint8Array> {
  const keypair = await loadAccountVaultSheetKeypair(actor, accountVaultScope(principal));
  assertAccountVaultSessionGeneration(generation);
  let key: Uint8Array;
  try {
    key = await openSheetKeyEnvelope(snapshot.envelope!, keypair.privateKey, {
      version: 1, pairId: snapshot.sheet.pair_id, keyId: snapshot.info.key_id,
      recipientPrincipal: principal, recipientKeyId: keypair.keyId,
    });
  } catch { assertAccountVaultSessionGeneration(generation); throw new SheetKeyIntegrityError("The encrypted sheet key is damaged or does not match this account and sheet. No recovery or replacement was started."); }
  try { assertAccountVaultSessionGeneration(generation); return key; }
  catch (cause) { key.fill(0); throw cause; }
}
type LegacyCiphertext = { entry_key: ArrayLike<number>; iv: ArrayLike<number>; ciphertext: ArrayLike<number> };
async function legacyEntryCiphertexts(actor: any, sheetId: string, generation: number): Promise<LegacyCiphertext[]> {
  const ciphertexts: LegacyCiphertext[] = [];
  let ciphertextBytes = 0;
  let cursor: [] | [bigint] = [];
  // All pages are authoritative, including deleted entries and saved versions.
  // Bound work and fail closed instead of silently accepting a partial scan.
  for (let page = 0; page < 100; page++) {
    const response: any = await actor.list_entries(sheetId, cursor, 100);
    assertAccountVaultSessionGeneration(generation);
    if (!response || !Array.isArray(response.entries) || response.entries.length > 100 || !Array.isArray(response.next_cursor) || response.next_cursor.length > 1) throw new SheetKeyIntegrityError("The original sheet entries could not be completely checked. No key backup was changed.");
    for (const entry of response.entries) {
      const history = entry.history ?? [];
      if (!Array.isArray(history) || history.length > 1 || (history.length && !Array.isArray(history[0]))) throw new SheetKeyIntegrityError("The original sheet history could not be checked. No key backup was changed.");
      for (const item of [entry, ...(history[0] ?? [])]) {
        if (item.entry_key?.length !== 32 || item.iv?.length !== 12 || !(item.ciphertext?.length >= 16) || ciphertexts.length >= 10_000) throw new SheetKeyIntegrityError("The original sheet ciphertext is damaged or exceeds the safe migration check limit. No key backup was changed.");
        ciphertextBytes += item.ciphertext.length;
        if (ciphertextBytes > 32 * 1024 * 1024) throw new SheetKeyIntegrityError("The original sheet exceeds the safe migration check limit. No key backup was changed.");
        ciphertexts.push(item);
      }
    }
    if (!response.next_cursor.length) return ciphertexts;
    const next: unknown = response.next_cursor[0];
    if (!response.entries.length || typeof next !== "bigint" || next < 0n || (cursor.length && next >= cursor[0])) throw new SheetKeyIntegrityError("The original sheet entry pagination changed. No key backup was changed.");
    cursor = [next];
  }
  throw new SheetKeyIntegrityError("The original sheet exceeds the safe migration check limit. No key backup was changed.");
}
/** Old production wrappers/names could use a placeholder key: entries take precedence. */
async function validateCachedKey(actor: any, sheetId: string, sheet: any, key: Uint8Array, generation: number): Promise<boolean> {
  if (key.length !== 32) throw new Error("Invalid retained sheet key. No backup was changed.");
  const entries = await legacyEntryCiphertexts(actor, sheetId, generation);
  if (entries.length) {
    for (const entry of entries) {
      try {
        const plaintext = await decryptEntryPayload(new Uint8Array(entry.entry_key), new Uint8Array(entry.iv), new Uint8Array(entry.ciphertext), key);
        plaintext.fill(0); assertAccountVaultSessionGeneration(generation);
      } catch { assertAccountVaultSessionGeneration(generation); return false; }
    }
    return true;
  }
  const name = sheet.name_enc?.[0], iv = sheet.name_iv?.[0];
  if (name?.length && iv?.length) {
    try {
      const plaintext = await decryptWithSheetKey(key, new Uint8Array(iv), new Uint8Array(name));
      plaintext.fill(0); assertAccountVaultSessionGeneration(generation); return true;
    } catch { assertAccountVaultSessionGeneration(generation); }
  }
  return false;
}
async function requireLegacyVerificationEvidence(actor: any, sheetId: string, sheet: any, generation: number): Promise<void> {
  const entries = await legacyEntryCiphertexts(actor, sheetId, generation);
  if (entries.length || (sheet.name_enc?.[0]?.length >= 16 && sheet.name_iv?.[0]?.length === 12)) return;
  throw new Error("This older sheet has no original encrypted content available to verify a recovered key. Open it on its original device; no paid recovery was started.");
}

function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export async function wrapSheetKeyForMember(actor: any, sheetKey: Uint8Array, pairId: string, keyId: string, recipient: string): Promise<number[]> {
  const records = await actor.get_account_wrapping_key(Principal.fromText(recipient));
  const record = records[0];
  if (!record) throw new Error("Your partner needs to finish IOU account encryption setup before this key can be shared.");
  const envelope = await createSheetKeyEnvelope(sheetKey, bytesToB64(new Uint8Array(record.public_key)), {
    version: 1, pairId, keyId, recipientPrincipal: recipient, recipientKeyId: record.key_id,
  });
  return Array.from(encoder.encode(envelope));
}

async function persistRecoveredKey(actor: any, principal: string, sheetId: string, original: SheetSnapshot, key: Uint8Array, generation: number): Promise<void> {
  rememberRecovered(principal, sheetId, original.info.key_id, key, generation);
  try {
    const keypair = await getAccountVaultSheetKeypair(actor, accountVaultScope(principal));
    assertAccountVaultSessionGeneration(generation);
    // Recheck before writing: another device may have completed the same migration.
    const before = await readSnapshot(actor, sheetId, generation);
    if (before.info.key_id !== original.info.key_id || before.info.scheme !== original.info.scheme || before.sheet.pair_id !== original.sheet.pair_id) throw new SheetKeyIntegrityError("Sheet encryption changed. No key was replaced.");
    if (before.envelope) {
      const online = await openSnapshot(actor, principal, before, generation);
      try { if (!equalKey(online, key)) throw new SheetKeyIntegrityError("The saved sheet key does not match the recovered key. No key was replaced."); }
      finally { online.fill(0); }
      forgetRecovered(principal, sheetId, original.info.key_id); return;
    }
    if (before.wrapped.length !== original.wrapped.length || !before.wrapped.every((byte, i) => byte === original.wrapped[i])) throw new SheetKeyIntegrityError("The sheet key copy changed on another device. Retry reading it; no key was replaced.");
    if (!await validateCachedKey(actor, sheetId, before.sheet, key, generation)) throw new SheetKeyIntegrityError("The recovered key does not decrypt all original sheet entries. No key backup was changed.");
    const envelope = await createSheetKeyEnvelope(key, keypair.publicKeyB64, {
      version: 1, pairId: original.sheet.pair_id, keyId: original.info.key_id,
      recipientPrincipal: principal, recipientKeyId: keypair.keyId,
    });
    assertAccountVaultSessionGeneration(generation);
    try { requireOk(await actor.set_sheet_wrapped_key(sheetId, original.info.key_id, Array.from(encoder.encode(envelope)))); }
    catch { assertAccountVaultSessionGeneration(generation); /* Reconcile once; never repeat a write automatically. */ }
    const saved = await readSnapshot(actor, sheetId, generation);
    if (!saved.envelope) throw new LegacySheetBackupPendingError(sheetId);
    if (saved.info.key_id !== original.info.key_id || saved.info.scheme !== original.info.scheme || saved.sheet.pair_id !== original.sheet.pair_id) throw new SheetKeyIntegrityError("Sheet encryption changed while saving its backup. No replacement was attempted.");
    const reopened = await openSnapshot(actor, principal, saved, generation);
    try { if (!equalKey(reopened, key)) throw new SheetKeyIntegrityError("Sheet backup did not preserve the recovered key. No replacement was attempted."); }
    finally { reopened.fill(0); }
    forgetRecovered(principal, sheetId, original.info.key_id);
  } catch (cause) {
    assertAccountVaultSessionGeneration(generation);
    if (cause instanceof SheetKeyIntegrityError || cause instanceof LegacySheetBackupPendingError) throw cause;
    throw new LegacySheetBackupPendingError(sheetId);
  }
}
async function readVaultSheetKeyUnlocked(actor: any, principal: string, sheetId: string, generation: number, availableKey?: Uint8Array): Promise<Uint8Array> {
  const snapshot = await readSnapshot(actor, sheetId, generation);
  if (snapshot.envelope) {
    const key = await openSnapshot(actor, principal, snapshot, generation);
    forgetRecovered(principal, sheetId, snapshot.info.key_id);
    return key;
  }
  if (snapshot.info.scheme !== "vetkd-v1") throw new Error("This sheet's encrypted key copy is missing or damaged. Ask an authorized member to share it again; no replacement key was generated.");
  let key: Uint8Array | null = recoveredKeys.get(retainedId(principal, sheetId, snapshot.info.key_id))?.slice() ?? null;
  if (!key && availableKey && await validateCachedKey(actor, sheetId, snapshot.sheet, availableKey, generation)) key = availableKey.slice();
  if (!key) {
    key = await loadExistingLegacySheetKey(principal, snapshot.wrapped);
    try { assertAccountVaultSessionGeneration(generation); } catch (cause) { key?.fill(0); throw cause; }
    if (key) {
      try {
        if (!await validateCachedKey(actor, sheetId, snapshot.sheet, key, generation)) { key.fill(0); key = null; }
      } catch (cause) { key?.fill(0); throw cause; }
    }
  }
  if (!key) throw new LegacySheetRecoveryRequiredError(sheetId);
  try { await persistRecoveredKey(actor, principal, sheetId, snapshot, key, generation); return key.slice(); }
  finally { key.fill(0); }
}
/** Automatically backs up available original keys; never invokes VetKD. */
export async function readVaultSheetKey(actor: any, principal: string, sheetId: string, availableKey?: Uint8Array): Promise<Uint8Array> {
  const generation = readAccountVaultSessionGeneration(), supplied = availableKey?.slice();
  try { return await withSheetLock(principal, sheetId, generation, () => readVaultSheetKeyUnlocked(actor, principal, sheetId, generation, supplied)); }
  finally { supplied?.fill(0); }
}

/** Explicit approval only. Retries saved-key backup without repeating an earlier derivation. */
export async function migrateLegacySheetKey(actor: any, principal: string, sheetId: string, availableKey?: Uint8Array): Promise<void> {
  const generation = readAccountVaultSessionGeneration(), supplied = availableKey?.slice();
  const operationId = JSON.stringify([generation, sheetScope(principal, sheetId)]);
  const existingOperation = migrations.get(operationId);
  if (existingOperation) { supplied?.fill(0); await existingOperation; assertAccountVaultSessionGeneration(generation); return; }
  let operation: Promise<void> | undefined;
  try {
    operation = withSheetLock(principal, sheetId, generation, async () => {
      try { const existing = await readVaultSheetKeyUnlocked(actor, principal, sheetId, generation, supplied); existing.fill(0); return; }
      catch (cause) { if (!(cause instanceof LegacySheetRecoveryRequiredError)) throw cause; }
      const snapshot = await readSnapshot(actor, sheetId, generation);
      if (snapshot.info.scheme !== "vetkd-v1") throw new Error("A locally generated sheet key cannot be recovered using legacy VetKD.");
      await getAccountVaultSheetKeypair(actor, accountVaultScope(principal));
      assertAccountVaultSessionGeneration(generation);
      const prepared = await prepareProdSheetKey(actor);
      assertAccountVaultSessionGeneration(generation);
      // Public-key preparation took a network round trip: recheck free recovery
      // immediately before the one explicitly approved paid derivation.
      try { const existing = await readVaultSheetKeyUnlocked(actor, principal, sheetId, generation, supplied); existing.fill(0); return; }
      catch (cause) { if (!(cause instanceof LegacySheetRecoveryRequiredError)) throw cause; }
      await requireLegacyVerificationEvidence(actor, sheetId, snapshot.sheet, generation);
      assertAccountVaultSessionGeneration(generation);
      const key = await deriveProdSheetKey(actor, sheetId, prepared);
      try {
        assertAccountVaultSessionGeneration(generation);
        if (!await validateCachedKey(actor, sheetId, snapshot.sheet, key, generation)) throw new Error("The recovered legacy key could not decrypt this sheet's original content. No encrypted key backup was changed; its original device may be required.");
        await persistRecoveredKey(actor, principal, sheetId, snapshot, key, generation);
      }
      finally { key.fill(0); }
    });
    migrations.set(operationId, operation);
    await operation;
  } finally { supplied?.fill(0); if (migrations.get(operationId) === operation) migrations.delete(operationId); }
}

export async function createRandomSheet(actor: any, principal: string, opts: { pairId: string; closingDays: number; name?: string }): Promise<{ sheet: any; K_sheet: Uint8Array }> {
  const generation = readAccountVaultSessionGeneration();
  const pair = (await actor.get_pair(opts.pairId))[0];
  if (!pair) throw new Error("Pair not found or not a member.");
  const members = pair.members.map((member: { toText(): string }) => member.toText());
  if (!members.includes(principal)) throw new Error("Not a member of this account.");
  await getAccountVaultSheetKeypair(actor, accountVaultScope(principal));
  const keyId = createSheetKeyId();
  const key = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrapA = await wrapSheetKeyForMember(actor, key, opts.pairId, keyId, members[0]);
    const wrapB = members[1] === "2vxsx-fae" ? [] : await wrapSheetKeyForMember(actor, key, opts.pairId, keyId, members[1]);
    const name = opts.name?.trim() ? await encryptName(key, opts.name.trim()) : undefined;
    const request = { pair_id: opts.pairId, key_id: keyId,
      closing_window_days: Math.max(30, Math.min(730, opts.closingDays)), wrapped_key_a: wrapA, wrapped_key_b: wrapB,
      name_enc: name ? [name.enc] : [], name_iv: name ? [name.iv] : [] };
    assertAccountVaultSessionGeneration(generation);
    let sheet: any;
    try { sheet = requireOk(await actor.create_sheet_v2(request)); }
    catch (cause) {
      // A lost response is not permission to make a second sheet. Reconcile the
      // active sheet against this exact immutable key id, without another write.
      const currentPair = (await actor.get_my_pairs()).find((pair: { id: string }) => pair.id === opts.pairId);
      const active = currentPair?.active_sheet_id?.[0];
      if (!active || (await sheetKeyInfo(actor, active)).key_id !== keyId) throw cause;
      sheet = (await actor.get_sheet(active))[0];
      if (!sheet) throw cause;
    }
    assertAccountVaultSessionGeneration(generation);
    return { sheet, K_sheet: key };
  } catch (cause) { key.fill(0); throw cause; }
}

export async function findLegacySheetsToMigrate(actor: any, principal: string): Promise<string[]> {
  const pending: string[] = [];
  for (const pair of await actor.get_my_pairs()) {
    const ids = new Set<string>([...pair.active_sheet_id, ...(await actor.list_archived_sheets(pair.id)).map((sheet: any) => sheet.id)]);
    for (const sheetId of ids) {
      // Pair membership alone need not include access to a pre-join sheet.
      if (!(await actor.get_sheet(sheetId)).length) continue;
      const info = await sheetKeyInfo(actor, sheetId);
      if (info.scheme !== "vetkd-v1") continue;
      try { const key = await readVaultSheetKey(actor, principal, sheetId); key.fill(0); }
      catch (cause) { if (cause instanceof LegacySheetRecoveryRequiredError) pending.push(sheetId); else throw cause; }
    }
  }
  return pending;
}
