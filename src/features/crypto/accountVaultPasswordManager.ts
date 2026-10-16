import { vaultUnb64Url } from "./accountVaultCrypto";

interface ManagedPasswordCredential extends Credential { readonly password: string }
interface ManagedPasswordCredentialData { id: string; password: string; name: string }
interface ManagedPasswordCredentialConstructor {
  new(data: ManagedPasswordCredentialData): ManagedPasswordCredential;
}
interface PasswordRequestOptions extends CredentialRequestOptions { password: true }
type PasswordManagerGlobals = typeof globalThis & { PasswordCredential?: ManagedPasswordCredentialConstructor };

export type ManagedRecoveryErrorCode = "MANAGER_UNAVAILABLE" | "MANAGER_CANCELLED" | "MANAGER_INVALID_CREDENTIAL" | "MANAGER_FAILED";
export class ManagedRecoveryError extends Error {
  constructor(readonly code: ManagedRecoveryErrorCode, message: string) {
    super(message); this.name = "ManagedRecoveryError";
  }
}

function unavailable(): ManagedRecoveryError {
  return new ManagedRecoveryError("MANAGER_UNAVAILABLE", "This browser cannot open the password manager directly. Use the recovery password field and your password manager's autofill instead.");
}
function cancelled(): ManagedRecoveryError {
  return new ManagedRecoveryError("MANAGER_CANCELLED", "No recovery credential was selected. Nothing was unlocked or changed.");
}
function invalid(): ManagedRecoveryError {
  return new ManagedRecoveryError("MANAGER_INVALID_CREDENTIAL", "The selected credential is not the encryption recovery entry for this IOU account.");
}
/** Availability is only an API check, not evidence that the browser saved or synced an entry. */
export function managerRecoveryAvailable(): boolean {
  return globalThis.isSecureContext === true && typeof navigator !== "undefined" &&
    typeof navigator.credentials?.store === "function" && typeof navigator.credentials?.get === "function" &&
    typeof (globalThis as PasswordManagerGlobals).PasswordCredential === "function";
}
function requireManager(): { credentials: CredentialsContainer; Constructor: ManagedPasswordCredentialConstructor } {
  if (!managerRecoveryAvailable()) throw unavailable();
  return { credentials: navigator.credentials, Constructor: (globalThis as PasswordManagerGlobals).PasswordCredential! };
}
function validateId(id: string): void {
  if (typeof id !== "string" || !id.trim() || id.length > 2048 || /[\u0000-\u001f\u007f]/.test(id)) throw invalid();
}
function validateSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.length > 128 || !/^IOU1-[A-Za-z0-9_-]{43}$/.test(secret)) throw invalid();
  let bytes: Uint8Array | undefined;
  try { bytes = vaultUnb64Url(secret.slice(5), 32); return secret; }
  catch { throw invalid(); }
  finally { bytes?.fill(0); }
}
function sanitizeFailure(error: unknown): ManagedRecoveryError {
  if (error instanceof ManagedRecoveryError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return cancelled();
  if (name === "NotSupportedError" || name === "SecurityError") return unavailable();
  // Provider errors can contain credential details; do not attach or repeat them.
  return new ManagedRecoveryError("MANAGER_FAILED", "The password-manager request could not finish. No automatic retry or paid recovery was started.");
}
/** Explicit Save action only. Completion does not prove storage or sync; verify by retrieving the entry separately. */
export async function saveManagedRecoveryCredential(credentialId: string, secret: string): Promise<void> {
  validateId(credentialId);
  validateSecret(secret);
  const { credentials, Constructor } = requireManager();
  try {
    const credential = new Constructor({ id: credentialId, password: secret, name: "IOU encryption recovery" });
    if (credential.type !== "password" || credential.id !== credentialId || credential.password !== secret) throw invalid();
    await credentials.store(credential);
  } catch (error) { throw sanitizeFailure(error); }
}
/** Explicit user action only. Never requests silent access, retries, or reads a different account's password. */
export async function readManagedRecoveryCredential(credentialId: string): Promise<string> {
  validateId(credentialId);
  const { credentials } = requireManager();
  const options: PasswordRequestOptions = { password: true, mediation: "required" };
  try {
    const credential = await credentials.get(options);
    if (!credential) throw cancelled();
    if (credential.type !== "password" || credential.id !== credentialId) throw invalid();
    return validateSecret((credential as ManagedPasswordCredential).password);
  } catch (error) { throw sanitizeFailure(error); }
}
