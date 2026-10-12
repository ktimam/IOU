import { canisterId, host } from "../auth/config";
import { assertAccountVaultSessionGeneration, createSheetKeyEnvelope, getAccountVaultSheetKeypair, readAccountVaultSessionGeneration } from "./accountVault";
import { requireAccountRoot, vaultBuffer, vaultB64Url, vaultOpen, vaultRandom, vaultSeal, vaultUnb64, vaultUnb64Url, type VaultCiphertext } from "./accountVaultCrypto";
import { requireOk, sheetKeyInfo } from "./vaultSheets";
import type { InviteParams } from "../flows/inviteLink";

export interface VaultInviteContext { host: string; canisterId: string; pairId: string; keyId: string; sheetId: string; code: string }
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
function aad(context: VaultInviteContext): string {
  const values = [context.host.replace(/\/+$/, ""), context.canisterId, context.pairId, context.keyId, context.sheetId, context.code];
  if (values.some((value) => typeof value !== "string" || !value || value.length > 1024)) throw new Error("Invalid encrypted invitation context");
  return JSON.stringify(["iou-invite-envelope-v1", ...values]);
}
async function inviteKey(secret: Uint8Array, context: VaultInviteContext): Promise<CryptoKey> {
  requireAccountRoot(secret);
  const base = await crypto.subtle.importKey("raw", vaultBuffer(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode("iou-invite-key-v1"), info: encoder.encode(aad(context)) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
/** The independent invite secret stays in the fragment; only this opaque envelope is uploaded. */
export async function sealVaultInvite(sheetKey: Uint8Array, context: VaultInviteContext): Promise<{ envelope: number[]; inviteSecretB64u: string }> {
  requireAccountRoot(sheetKey);
  const secret = vaultRandom(32);
  try {
    const sealed = await vaultSeal(await inviteKey(secret, context), sheetKey, aad(context));
    const envelope = encoder.encode(JSON.stringify({ version: 1, ...context, ...sealed }));
    if (envelope.length > 4096) throw new Error("Encrypted invitation is too large");
    return { envelope: Array.from(envelope), inviteSecretB64u: vaultB64Url(secret) };
  } finally { secret.fill(0); }
}
export async function openVaultInvite(envelope: ArrayLike<number>, inviteSecretB64u: string, context: VaultInviteContext): Promise<Uint8Array> {
  if (!envelope.length || envelope.length > 4096) throw new Error("Invalid encrypted invitation");
  const value = JSON.parse(decoder.decode(new Uint8Array(Array.from(envelope)))) as VaultInviteContext & VaultCiphertext & { version: number };
  if (value.version !== 1 || aad(value) !== aad(context)) throw new Error("Encrypted invitation context mismatch");
  const secret = vaultUnb64Url(inviteSecretB64u, 32);
  try {
    const key = await vaultOpen(await inviteKey(secret, context), value, aad(context));
    try { requireAccountRoot(key); return key; } catch (error) { key.fill(0); throw error; }
  } finally { secret.fill(0); }
}
/** Caller first loads the existing sheet key; a legacy migration is never started here. */
export async function createVaultInvite(actor: any, principal: string, sheetId: string, sheetKey: Uint8Array): Promise<InviteParams> {
  const generation = readAccountVaultSessionGeneration();
  const info = await sheetKeyInfo(actor, sheetId);
  const sheet = (await actor.get_sheet(sheetId))[0];
  if (!sheet) throw new Error("Sheet not found or access is unavailable.");
  if (!principal || principal === "2vxsx-fae") throw new Error("Sign in before sharing an invitation.");
  assertAccountVaultSessionGeneration(generation);
  const code = await actor.issue_invite(sheet.pair_id) as string;
  const sealed = await sealVaultInvite(sheetKey, { host, canisterId, pairId: sheet.pair_id, keyId: info.key_id, sheetId, code });
  assertAccountVaultSessionGeneration(generation);
  requireOk(await actor.set_sheet_invite_envelope(code, sheetId, sealed.envelope));
  assertAccountVaultSessionGeneration(generation);
  return { code, sheetId, inviteSecretB64u: sealed.inviteSecretB64u };
}
/** Decrypt and persist a recipient-bound copy before consuming the one-use invitation. */
export async function acceptVaultInvite(actor: any, principal: string, invite: InviteParams, assertCallerCurrent: () => void = () => undefined): Promise<{ K_sheet: Uint8Array }> {
  if (!invite.inviteSecretB64u || invite.keyB64u) throw new Error("This older invite has no encrypted key backup. Ask the creator to migrate the sheet if needed and share a new invite. No paid recovery was started.");
  // Validate the bearer secret before any update or platform-key prompt.
  const checkedSecret = vaultUnb64Url(invite.inviteSecretB64u, 32); checkedSecret.fill(0);
  const generation = readAccountVaultSessionGeneration();
  const current = () => { assertAccountVaultSessionGeneration(generation); assertCallerCurrent(); };
  current();
  const pair = await getAccountVaultSheetKeypair(actor, { principal, host, canisterId });
  current();
  const record = requireOk<{ pair_id: string; key_id: string; envelope: ArrayLike<number> }>(await actor.get_sheet_invite_envelope(invite.code, invite.sheetId));
  current();
  const key = await openVaultInvite(record.envelope, invite.inviteSecretB64u, { host, canisterId, pairId: record.pair_id, keyId: record.key_id, sheetId: invite.sheetId, code: invite.code });
  try {
    const wrapped = await createSheetKeyEnvelope(key, pair.publicKeyB64, { version: 1, pairId: record.pair_id, keyId: record.key_id, recipientPrincipal: principal, recipientKeyId: pair.keyId });
    current();
    await actor.accept_invite(invite.code, [{ sheet_id: invite.sheetId, wrapped_key_for_partner: Array.from(encoder.encode(wrapped)) }], Array.from(vaultUnb64(pair.publicKeyB64, 65)));
    current();
    return { K_sheet: key };
  } catch (error) { key.fill(0); throw error; }
}
