import { accountVaultScopeId, vaultAad, vaultAesKey, vaultB64, vaultB64Url, vaultBuffer, vaultOpen, vaultRandom, vaultSeal, vaultUnb64, vaultUnb64Url, type AccountVaultScope, type VaultPasskeyBackup } from "./accountVaultCrypto";

type PrfOutputs = { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
function environment(): string {
  if (typeof navigator === "undefined" || !navigator.credentials || typeof location === "undefined" || !globalThis.isSecureContext) throw new Error("Passkey backup requires a secure browser page");
  return location.hostname;
}
function output(prf: PrfOutputs["prf"]): Uint8Array | null {
  // Never serialize the whole credential: toJSON includes these secret PRF results.
  const first = prf?.results?.first;
  if (!first) return null;
  if (first.byteLength !== 32) throw new Error("Invalid passkey PRF result");
  return (ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first)).slice();
}
function extensions(salt: Uint8Array): AuthenticationExtensionsClientInputs {
  return { prf: { eval: { first: vaultBuffer(salt) } } } as AuthenticationExtensionsClientInputs;
}
function missingPrf(prf: PrfOutputs["prf"], credential: PublicKeyCredential): Error {
  // Report only allowlisted structure, never extension values or credential data.
  const shape = !prf ? "prf-absent" : !prf.results ? "results-absent" : "first-absent";
  const attachment = credential.authenticatorAttachment === "platform" ? "platform"
    : credential.authenticatorAttachment === "cross-platform" ? "cross-platform" : "unknown";
  return new Error(`The selected passkey returned no encryption result (PRF) in this browser. Your account keys were not reset. [IOU-PASSKEY/PRF-NO-RESULT] [output=${shape}; attachment=${attachment}]`);
}
function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index++) different |= left[index] ^ right[index];
  return different === 0;
}
async function evaluate(credentialId: string, salt: Uint8Array, rpId: string): Promise<Uint8Array> {
  if (rpId !== environment()) throw new Error("This passkey backup belongs to a different IOU domain");
  if (salt.length !== 32) throw new Error("Invalid passkey salt");
  const credential = await navigator.credentials.get({ publicKey: { challenge: vaultBuffer(vaultRandom(32)), rpId, allowCredentials: [{ type: "public-key", id: vaultBuffer(vaultUnb64Url(credentialId)) }], userVerification: "required", timeout: 60000, extensions: extensions(salt) } }) as PublicKeyCredential | null;
  if (!credential || vaultB64Url(new Uint8Array(credential.rawId)) !== credentialId) throw new Error("Passkey unlock was cancelled or returned the wrong credential");
  const prf = (credential.getClientExtensionResults() as PrfOutputs).prf;
  const secret = output(prf);
  if (!secret) throw missingPrf(prf, credential);
  return secret;
}
export async function enrollVaultPasskey(root: Uint8Array, scope: AccountVaultScope, displayName = "IOU account"): Promise<VaultPasskeyBackup> {
  const rpId = environment();
  const salt = vaultRandom(32);
  const userId = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accountVaultScopeId(scope)));
  const credential = await navigator.credentials.create({ publicKey: { challenge: vaultBuffer(vaultRandom(32)), rp: { id: rpId, name: "IOU encrypted account" }, user: { id: userId, name: scope.principal, displayName }, pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }], authenticatorSelection: { residentKey: "required", userVerification: "required" }, attestation: "none", timeout: 60000, extensions: extensions(salt) } }) as PublicKeyCredential | null;
  if (!credential) throw new Error("Passkey creation was cancelled");
  const credentialId = vaultB64Url(new Uint8Array(credential.rawId));
  const createdPrf = (credential.getClientExtensionResults() as PrfOutputs).prf;
  const createdOutput = output(createdPrf);
  if (!createdOutput && createdPrf?.enabled !== true) throw new Error("Passkey creation did not confirm encryption support (PRF) in this browser. No passkey backup was saved.");
  let secret: Uint8Array | null = null;
  try {
    // Creation-time PRF support does not prove that later authentication can
    // reproduce the secret. Verify the actual unlock before publishing a backup.
    secret = await evaluate(credentialId, salt, rpId);
    if (createdOutput && !equalBytes(createdOutput, secret)) {
      throw new Error("Passkey creation and unlock returned different encryption results. No passkey backup was saved. [IOU-PASSKEY/PRF-MISMATCH]");
    }
    const key = await vaultAesKey(secret, scope, "passkey-backup");
    const aad = vaultAad(scope, "passkey-backup", JSON.stringify([credentialId, rpId, vaultB64(salt)]));
    const sealed = await vaultSeal(key, root, aad);
    const reopened = await vaultOpen(key, sealed, aad);
    try { if (!equalBytes(reopened, root)) throw new Error("Passkey backup verification failed. No passkey backup was saved."); }
    finally { reopened.fill(0); }
    return { credentialId, rpId, prfSalt: vaultB64(salt), ...sealed };
  } finally { secret?.fill(0); createdOutput?.fill(0); }
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
  let backup = eligible[0];
  let secret: Uint8Array;
  if (eligible.length === 1) {
    // Use the same standard PRF input as enrollment. On Windows, eval and
    // evalByCredential take distinct native API paths despite equivalent salts.
    secret = await evaluate(backup.credentialId, vaultUnb64(backup.prfSalt, 32), rpId);
  } else {
    const credential = await navigator.credentials.get({ publicKey: { challenge: vaultBuffer(vaultRandom(32)), rpId, allowCredentials, userVerification: "required", timeout: 60000, extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs } }) as PublicKeyCredential | null;
    const selected = credential && eligible.find((entry) => entry.credentialId === vaultB64Url(new Uint8Array(credential.rawId)));
    if (!credential || !selected) throw new Error("Passkey unlock was cancelled or returned the wrong credential");
    backup = selected;
    // Only a successful credential selection with an omitted PRF result may
    // take this one bounded compatibility request. Never retry cancellation,
    // malformed output or failed decryption, and never change providers/keys.
    secret = output((credential.getClientExtensionResults() as PrfOutputs).prf) ?? await evaluate(backup.credentialId, vaultUnb64(backup.prfSalt, 32), rpId);
  }
  try { return await vaultOpen(await vaultAesKey(secret, scope, "passkey-backup"), backup, vaultAad(scope, "passkey-backup", JSON.stringify([backup.credentialId, backup.rpId, backup.prfSalt]))); }
  finally { secret.fill(0); }
}
