/** Versioned, client-only account-vault and sheet-envelope primitives. */
export interface AccountVaultScope {
  principal: string;
  canisterId: string;
  host: string;
}

export interface VaultCiphertext { iv: string; ciphertext: string }
export interface VaultPasskeyBackup extends VaultCiphertext {
  credentialId: string;
  prfSalt: string;
  rpId: string;
}
export interface AccountVaultPayload {
  version: 1;
  scope: string;
  rootFingerprint: string;
  sheetKey: { keyId: string; publicKeyB64: string; privateKey: VaultCiphertext };
  recovery: VaultCiphertext | null;
  passkeys: VaultPasskeyBackup[];
}
export interface SheetKeyEnvelopeContext {
  version: 1;
  pairId: string;
  keyId: string;
  recipientPrincipal: string;
  recipientKeyId: string;
}

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const SHEET_PREFIX = "iou-sheet-envelope-v1:";
export const vaultBytes = (value: ArrayLike<number>): Uint8Array<ArrayBuffer> => new Uint8Array(Array.from(value));
export const vaultBuffer = (value: Uint8Array): ArrayBuffer => vaultBytes(value).buffer;
export function vaultRandom(size: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(size));
}
export function vaultB64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export function vaultUnb64(text: string, max = 65536): Uint8Array<ArrayBuffer> {
  if (typeof text !== "string" || text.length > max * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new Error("Invalid vault encoding");
  }
  const value = atob(text);
  if (value.length > max) throw new Error("Vault value too large");
  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
  if (vaultB64(bytes) !== text) throw new Error("Noncanonical vault encoding");
  return bytes;
}
export const vaultB64Url = (bytes: Uint8Array): string => vaultB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export function vaultUnb64Url(text: string, size?: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 1024) throw new Error("Invalid recovery encoding");
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = vaultUnb64(normal + "=".repeat((4 - normal.length % 4) % 4), 768);
  if (vaultB64Url(bytes) !== text || (size !== undefined && bytes.length !== size)) throw new Error("Invalid recovery key length");
  return bytes;
}
function checked(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("Invalid vault context");
  return value;
}
export function accountVaultScopeId(scope: AccountVaultScope): string {
  if (["anonymous", "2vxsx-fae"].includes(scope.principal)) throw new Error("Sign in to unlock account keys");
  return JSON.stringify(["iou-account-vault-v1", checked(scope.host).replace(/\/+$/, ""), checked(scope.canisterId), checked(scope.principal)]);
}
export function requireAccountRoot(root: Uint8Array): void {
  if (root.length !== 32) throw new Error("Invalid account root length");
}
export async function accountRootFingerprint(root: Uint8Array, scope: AccountVaultScope): Promise<string> {
  requireAccountRoot(root);
  const context = utf8.encode(JSON.stringify(["iou-root-fingerprint-v1", accountVaultScopeId(scope)]));
  const bytes = new Uint8Array(context.length + root.length);
  bytes.set(context); bytes.set(root, context.length);
  try { return vaultB64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))); }
  finally { bytes.fill(0); }
}
export async function vaultAesKey(secret: Uint8Array, scope: AccountVaultScope, purpose: string): Promise<CryptoKey> {
  const key = await crypto.subtle.importKey("raw", vaultBuffer(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("iou-vault-kdf-v1"), info: utf8.encode(JSON.stringify([accountVaultScopeId(scope), purpose])) }, key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export function vaultAad(scope: AccountVaultScope, purpose: string, identity = ""): string {
  return JSON.stringify(["iou-vault-aead-v1", accountVaultScopeId(scope), purpose, identity]);
}
export async function vaultSeal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<VaultCiphertext> {
  const iv = vaultRandom(12);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, vaultBuffer(plaintext));
  return { iv: vaultB64(iv), ciphertext: vaultB64(new Uint8Array(ciphertext)) };
}
export async function vaultOpen(key: CryptoKey, value: VaultCiphertext, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const iv = vaultUnb64(value.iv, 12);
  const ciphertext = vaultUnb64(value.ciphertext);
  if (iv.length !== 12 || ciphertext.length < 16) throw new Error("Invalid encrypted vault record");
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, ciphertext));
}
export async function accountWrappingKeyId(rawPublicKey: Uint8Array): Promise<string> {
  if (rawPublicKey.length !== 65 || rawPublicKey[0] !== 4) throw new Error("Invalid P-256 public key");
  await crypto.subtle.importKey("raw", vaultBuffer(rawPublicKey), { name: "ECDH", namedCurve: "P-256" }, false, []);
  return vaultB64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", vaultBuffer(rawPublicKey))));
}
export async function createAccountVaultPayload(root: Uint8Array, scope: AccountVaultScope): Promise<AccountVaultPayload> {
  requireAccountRoot(root);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keyId = await accountWrappingKeyId(publicKey);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  try {
    const key = await vaultAesKey(root, scope, "sheet-private-key");
    return { version: 1, scope: accountVaultScopeId(scope), rootFingerprint: await accountRootFingerprint(root, scope), sheetKey: { keyId, publicKeyB64: vaultB64(publicKey), privateKey: await vaultSeal(key, privateBytes, vaultAad(scope, "sheet-private-key", keyId)) }, recovery: null, passkeys: [] };
  } finally { privateBytes.fill(0); }
}
export async function openAccountVaultKeypair(payload: AccountVaultPayload, root: Uint8Array, scope: AccountVaultScope): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; publicKeyB64: string; keyId: string }> {
  if (payload.scope !== accountVaultScopeId(scope) || payload.rootFingerprint !== await accountRootFingerprint(root, scope)) throw new Error("Account root does not match this vault");
  const rawPublic = vaultUnb64(payload.sheetKey.publicKeyB64, 65);
  if (await accountWrappingKeyId(rawPublic) !== payload.sheetKey.keyId) throw new Error("Vault public key fingerprint mismatch");
  const key = await vaultAesKey(root, scope, "sheet-private-key");
  const privateBytes = await vaultOpen(key, payload.sheetKey.privateKey, vaultAad(scope, "sheet-private-key", payload.sheetKey.keyId));
  try {
    const privateKey = await crypto.subtle.importKey("pkcs8", privateBytes, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const publicKey = await crypto.subtle.importKey("raw", rawPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    // A decryptable record must also contain a private key matching its published public key.
    const probe = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const left = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: probe.publicKey }, privateKey, 256));
    const right = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, probe.privateKey, 256));
    let mismatch = 0;
    for (let i = 0; i < left.length; i++) mismatch |= left[i] ^ right[i];
    left.fill(0); right.fill(0);
    if (mismatch) throw new Error("Vault private/public key mismatch");
    return { privateKey, publicKey, publicKeyB64: payload.sheetKey.publicKeyB64, keyId: payload.sheetKey.keyId };
  } finally { privateBytes.fill(0); }
}
export function encodeAccountVault(payload: AccountVaultPayload): Uint8Array<ArrayBuffer> {
  return utf8.encode(JSON.stringify(payload));
}
export function decodeAccountVault(bytes: ArrayLike<number>, scope: AccountVaultScope): AccountVaultPayload {
  if (bytes.length > 65536) throw new Error("Account vault is too large");
  const value = JSON.parse(decoder.decode(vaultBytes(bytes))) as AccountVaultPayload;
  if (!value || value.version !== 1 || value.scope !== accountVaultScopeId(scope) || typeof value.rootFingerprint !== "string" || !value.sheetKey || typeof value.sheetKey.keyId !== "string" || typeof value.sheetKey.publicKeyB64 !== "string" || !value.sheetKey.privateKey || !Array.isArray(value.passkeys) || value.passkeys.length > 8 || !(value.recovery === null || (value.recovery && typeof value.recovery.iv === "string" && typeof value.recovery.ciphertext === "string"))) throw new Error("Invalid or unsupported account vault");
  for (const backup of value.passkeys) {
    if (!backup || typeof backup.credentialId !== "string" || typeof backup.prfSalt !== "string" || typeof backup.rpId !== "string" || typeof backup.iv !== "string" || typeof backup.ciphertext !== "string") throw new Error("Invalid passkey backup");
  }
  return value;
}
export function createAccountRecoveryCode(): string { return "IOU1-" + vaultB64Url(vaultRandom(32)); }
function recoveryBytes(code: string): Uint8Array<ArrayBuffer> {
  if (!code.trim().startsWith("IOU1-")) throw new Error("Invalid IOU recovery code");
  return vaultUnb64Url(code.trim().slice(5), 32);
}
export async function createRecoveryBackup(root: Uint8Array, scope: AccountVaultScope, code: string): Promise<VaultCiphertext> {
  requireAccountRoot(root);
  const secret = recoveryBytes(code);
  try { return await vaultSeal(await vaultAesKey(secret, scope, "recovery-code"), root, vaultAad(scope, "recovery-code")); }
  finally { secret.fill(0); }
}
export async function openRecoveryBackup(backup: VaultCiphertext, scope: AccountVaultScope, code: string): Promise<Uint8Array<ArrayBuffer>> {
  const secret = recoveryBytes(code);
  try { const root = await vaultOpen(await vaultAesKey(secret, scope, "recovery-code"), backup, vaultAad(scope, "recovery-code")); requireAccountRoot(root); return root; }
  finally { secret.fill(0); }
}
export function createSheetKeyId(): string { return vaultB64Url(vaultRandom(32)); }
function sheetAad(context: SheetKeyEnvelopeContext): string {
  if (context.version !== 1) throw new Error("Unsupported sheet envelope version");
  return JSON.stringify(["iou-sheet-envelope-v1", checked(context.pairId), checked(context.keyId), checked(context.recipientPrincipal), checked(context.recipientKeyId), context.version]);
}
async function sheetAes(privateKey: CryptoKey, publicKey: CryptoKey, aad: string): Promise<CryptoKey> {
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  try {
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("iou-sheet-envelope-kdf-v1"), info: utf8.encode(aad) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally { shared.fill(0); }
}
export async function createSheetKeyEnvelope(sheetKey: Uint8Array, recipientPublicKeyB64: string, context: SheetKeyEnvelopeContext): Promise<string> {
  requireAccountRoot(sheetKey);
  const raw = vaultUnb64(recipientPublicKeyB64, 65);
  if (await accountWrappingKeyId(raw) !== context.recipientKeyId) throw new Error("Recipient public key fingerprint mismatch");
  const recipient = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephemeralB64 = vaultB64(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)));
  // Bind both static recipient identity (its fingerprint is in context) and the
  // ephemeral public-key encoding, not just the ECDH shared x-coordinate.
  const aad = JSON.stringify([sheetAad(context), ephemeralB64]);
  const sealed = await vaultSeal(await sheetAes(ephemeral.privateKey, recipient, aad), sheetKey, aad);
  return SHEET_PREFIX + vaultB64(utf8.encode(JSON.stringify({ ...context, ephemeralB64, ...sealed })));
}
export async function openSheetKeyEnvelope(envelope: string, recipientPrivateKey: CryptoKey, context: SheetKeyEnvelopeContext): Promise<Uint8Array<ArrayBuffer>> {
  if (!envelope.startsWith(SHEET_PREFIX) || envelope.length > 4096) throw new Error("Invalid sheet key envelope");
  const value = JSON.parse(decoder.decode(vaultUnb64(envelope.slice(SHEET_PREFIX.length), 2048))) as VaultCiphertext & SheetKeyEnvelopeContext & { ephemeralB64: string };
  if (value.version !== 1) throw new Error("Unsupported sheet key envelope");
  const raw = vaultUnb64(value.ephemeralB64, 65);
  await accountWrappingKeyId(raw);
  const ephemeral = await crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  if (sheetAad(value) !== sheetAad(context)) throw new Error("Sheet envelope context mismatch");
  const aad = JSON.stringify([sheetAad(context), value.ephemeralB64]);
  const key = await vaultOpen(await sheetAes(recipientPrivateKey, ephemeral, aad), value, aad);
  requireAccountRoot(key);
  return key;
}
