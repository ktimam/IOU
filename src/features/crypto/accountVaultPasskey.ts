import { accountVaultScopeId, vaultAad, vaultAesKey, vaultB64, vaultB64Url, vaultBuffer, vaultOpen, vaultRandom, vaultSeal, vaultUnb64, vaultUnb64Url, type AccountVaultScope, type VaultPasskeyBackup } from "./accountVaultCrypto";

type PrfOutputs = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
function environment(): string {
  if (typeof navigator === "undefined" || !navigator.credentials || typeof location === "undefined" || !globalThis.isSecureContext) throw new Error("Passkey backup requires a secure browser page");
  return location.hostname;
}
function output(credential: PublicKeyCredential): Uint8Array | null {
  // Never serialize the whole credential: toJSON includes these secret PRF results.
  const first = (credential.getClientExtensionResults() as PrfOutputs).prf?.results?.first;
  if (!first) return null;
  if (first.byteLength !== 32) throw new Error("Invalid passkey PRF result");
  return new Uint8Array(first).slice();
}
function extensions(salt: Uint8Array): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: vaultBuffer(salt) } } } as AuthenticationExtensionsClientInputs;
}
async function evaluate(credentialId: string, salt: Uint8Array, rpId: string): Promise<Uint8Array> {
  if (rpId !== environment()) throw new Error("This passkey backup belongs to a different IOU domain");
  const credential = await navigator.credentials.get({ publicKey: { challenge: vaultBuffer(vaultRandom(32)), rpId, allowCredentials: [{ type: "public-key", id: vaultBuffer(vaultUnb64Url(credentialId)) }], userVerification: "required", timeout: 60000, extensions: extensions(salt) } }) as PublicKeyCredential | null;
  if (!credential || vaultB64Url(new Uint8Array(credential.rawId)) !== credentialId) throw new Error("Passkey unlock was cancelled or returned the wrong credential");
  const secret = output(credential);
  if (!secret) throw new Error("This passkey/provider does not support encryption (PRF). Use a recovery code or another compatible passkey.");
  return secret;
}
export async function enrollVaultPasskey(root: Uint8Array, scope: AccountVaultScope, displayName = "IOU account"): Promise<VaultPasskeyBackup> {
  const rpId = environment();
  const salt = vaultRandom(32);
  const userId = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountVaultScopeId(scope)));
  const credential = await navigator.credentials.create({ publicKey: { challenge: vaultBuffer(vaultRandom(32)), rp: { id: rpId, name: "IOU encrypted account" }, user: { id: userId, name: scope.principal, displayName }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none", timeout: 60000, extensions: extensions(salt) } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled");
  const credentialId = vaultB64Url(new Uint8Array(credential.rawId));
  const createdOutput = output(credential);
  if (!createdOutput && (credential.getClientExtensionResults() as PrfOutputs).prf?.enabled !== true) throw new Error("This passkey/provider does not support encryption (PRF). No passkey backup was saved.");
  const secret = createdOutput ?? await evaluate(credentialId, salt, rpId);
  try {
    const key = await vaultAesKey(secret, scope, "passkey-backup");
    const sealed = await vaultSeal(key, root, vaultAad(scope, "passkey-backup", JSON.stringify([credentialId, rpId, vaultB64(salt)])));
    return { credentialId, rpId, prfSalt: vaultB64(salt), ...sealed };
  } finally { secret.fill(0); }
}
export async function unlockVaultPasskey(backup: VaultPasskeyBackup, scope: AccountVaultScope): Promise<Uint8Array> {
  return unlockVaultPasskeys([backup], scope);
}
export async function unlockVaultPasskeys(backups: VaultPasskeyBackup[], scope: AccountVaultScope): Promise<Uint8Array> {
  const rpId = environment();
  const eligible = backups.filter((backup) => backup.rpId === rpId);
  if (!eligible.length) throw new Error("This passkey backup belongs to a different IOU domain");
  const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
  const allowCredentials = eligible.map((backup) => {
    const salt = vaultUnb64(backup.prfSalt, 32);
    if (salt.length !== 32) throw new Error("Invalid passkey salt");
    if (evalByCredential[backup.credentialId]) throw new Error("Duplicate passkey backup");
    evalByCredential[backup.credentialId] = { first: vaultBuffer(salt) };
    return { type: "public-key" as const, id: vaultBuffer(vaultUnb64Url(backup.credentialId)) };
  });
  const credential = await navigator.credentials.get({ publicKey: { challenge: vaultBuffer(vaultRandom(32)), rpId, allowCredentials, userVerification: "required", timeout: 60000, extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs } }) as PublicKeyCredential | null;
  const backup = credential && eligible.find((entry) => entry.credentialId === vaultB64Url(new Uint8Array(credential.rawId)));
  if (!credential || !backup) throw new Error("Passkey unlock was cancelled or returned the wrong credential");
  const secret = output(credential);
  if (!secret) throw new Error("This passkey/provider does not support encryption (PRF). Use a recovery code or another compatible passkey.");
  try { return await vaultOpen(await vaultAesKey(secret, scope, "passkey-backup"), backup, vaultAad(scope, "passkey-backup", JSON.stringify([backup.credentialId, backup.rpId, backup.prfSalt]))); }
  finally { secret.fill(0); }
}
