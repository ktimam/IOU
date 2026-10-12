import { Principal } from "@dfinity/principal";
import { createSheetKeyId, createSheetKeyEnvelope, openSheetKeyEnvelope, getAccountVaultSheetKeypair,
  loadAccountVaultSheetKeypair, readAccountVaultSessionGeneration, assertAccountVaultSessionGeneration } from "./accountVault";
import { accountVaultScope } from "./vaultAccess";
import { deriveProdSheetKey, prepareProdSheetKey } from "./prodVetkd";
import { encryptName } from "./devVetkd";

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
    throw new Error("Unsupported sheet encryption format. Update IOU; no key was replaced.");
  }
  return info;
}

export class LegacySheetRecoveryRequiredError extends Error {
  constructor(readonly sheetId: string) {
    super("This older sheet needs a one-time key migration. Open Settings → Encryption recovery → Migrate older sheet keys. No paid recovery was started.");
    this.name = "LegacySheetRecoveryRequiredError";
  }
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

/** No paid calls, including on missing or corrupt encrypted copies. */
export async function readVaultSheetKey(actor: any, principal: string, sheetId: string): Promise<Uint8Array> {
  const generation = readAccountVaultSessionGeneration();
  const info = await sheetKeyInfo(actor, sheetId);
  const sheet = (await actor.get_sheet(sheetId))[0];
  if (!sheet) throw new Error("Sheet not found or access is unavailable.");
  const wrapped = (await actor.get_sheet_wrapped_key(sheetId))[0];
  let envelope = "";
  try { envelope = wrapped ? decoder.decode(new Uint8Array(wrapped)) : ""; } catch { /* legacy binary is not an envelope */ }
  if (!envelope.startsWith(PREFIX)) {
    if (info.scheme === "vetkd-v1") throw new LegacySheetRecoveryRequiredError(sheetId);
    throw new Error("This sheet's encrypted key copy is missing or damaged. Ask an authorized member to share it again; no replacement key was generated.");
  }
  const keypair = await loadAccountVaultSheetKeypair(actor, accountVaultScope(principal));
  const key = await openSheetKeyEnvelope(envelope, keypair.privateKey, {
    version: 1, pairId: sheet.pair_id, keyId: info.key_id,
    recipientPrincipal: principal, recipientKeyId: keypair.keyId,
  });
  try { assertAccountVaultSessionGeneration(generation); return key; }
  catch (cause) { key.fill(0); throw cause; }
}

/** Only an explicit reviewed migration action calls this. Never a read fallback. */
export async function migrateLegacySheetKey(actor: any, principal: string, sheetId: string): Promise<void> {
  const generation = readAccountVaultSessionGeneration();
  const info = await sheetKeyInfo(actor, sheetId);
  if (info.scheme !== "vetkd-v1") throw new Error("A locally generated sheet key cannot be recovered using legacy VetKD.");
  try { const existing = await readVaultSheetKey(actor, principal, sheetId); existing.fill(0); return; }
  catch (cause) { if (!(cause instanceof LegacySheetRecoveryRequiredError)) throw cause; }
  const sheet = (await actor.get_sheet(sheetId))[0];
  if (!sheet) throw new Error("Sheet not found or access is unavailable.");
  await getAccountVaultSheetKeypair(actor, accountVaultScope(principal));
  assertAccountVaultSessionGeneration(generation);
  const prepared = await prepareProdSheetKey(actor);
  assertAccountVaultSessionGeneration(generation);
  const key = await deriveProdSheetKey(actor, sheetId, prepared);
  try {
    assertAccountVaultSessionGeneration(generation);
    const wrapped = await wrapSheetKeyForMember(actor, key, sheet.pair_id, info.key_id, principal);
    assertAccountVaultSessionGeneration(generation);
    requireOk(await actor.set_sheet_wrapped_key(sheetId, info.key_id, wrapped));
  } finally { key.fill(0); }
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
