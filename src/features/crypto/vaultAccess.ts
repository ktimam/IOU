import { canisterId, host } from "../auth/config";
import { newTransportKey, restorePendingTransportKey, validateVetkdMasterPublicKey, deriveConsumerWrapKeyProd } from "./prodVetkd";
import { loadAccountRoot, initializeAccountVault, restoreAccountVaultWithRoot,
  loadUnpublishedAccountRoot, readAccountVaultSessionGeneration, assertAccountVaultSessionGeneration,
  VaultUnlockRequiredError, registerAccountVaultCleanup } from "./accountVault";
import { readPendingAccountRootRequest, writePendingAccountRootRequest, deletePendingAccountRootRequest } from "./accountVaultStorage";

/** A public identity is a namespace, never key material. */
export function accountVaultScope(principal: string) {
  return { principal, canisterId, host };
}

export const VAULT_CHANGED_EVENT = "iou:account-vault-changed";
export function notifyVaultChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
}

/** Missing device storage must never silently trigger a paid operation. */
export async function requireAccountRoot(actor: any, principal: string): Promise<Uint8Array> {
  const root = await loadAccountRoot(actor, accountVaultScope(principal));
  if (!root) throw new Error("Set up account encryption before using encrypted IOU data.");
  return root;
}

// Retain the same transport/request after a network error in this page. The
// backend caches its response and never redispatches an ambiguous request.
const paidAttempts = new Map<string, { id: string; transport: ReturnType<typeof newTransportKey> }>();
const operations = new Map<string, Promise<void>>();
registerAccountVaultCleanup(() => {
  for (const attempt of paidAttempts.values()) attempt.transport.secretKey.fill(0);
  paidAttempts.clear(); operations.clear();
});

async function clearCompletedAttempts(scope: ReturnType<typeof accountVaultScope>, current: () => void): Promise<void> {
  for (const emergency of [false, true]) {
    const saved = await readPendingAccountRootRequest(scope, emergency);
    try {
      current();
      if (saved) await deletePendingAccountRootRequest(scope, emergency, saved.id);
      current();
      const key = JSON.stringify([scope, emergency]);
      paidAttempts.get(key)?.transport.secretKey.fill(0);
      paidAttempts.delete(key);
    } finally { saved?.secretKey.fill(0); }
  }
}

/** Only explicit setup/emergency-recovery buttons may call this. Never on mount. */
export async function recoverAccountVaultPaid(actor: any, principal: string, emergency: boolean, newAttempt = false): Promise<void> {
  if (newAttempt && !emergency) throw new Error("A new paid recovery requires explicit emergency consent.");
  const operationKey = JSON.stringify(accountVaultScope(principal));
  const existingOperation = operations.get(operationKey);
  if (existingOperation) return existingOperation;
  const operation = recover(actor, principal, emergency, newAttempt);
  operations.set(operationKey, operation);
  try { await operation; }
  finally { if (operations.get(operationKey) === operation) operations.delete(operationKey); }
}

async function recover(actor: any, principal: string, emergency: boolean, newAttempt: boolean): Promise<void> {
  const scope = accountVaultScope(principal);
  const generation = readAccountVaultSessionGeneration();
  const current = () => assertAccountVaultSessionGeneration(generation);
  // A completed setup or interrupted publication must not buy the same key again.
  let local: Uint8Array | null = null;
  try { local = await loadAccountRoot(actor, scope); }
  catch (cause) { if (!(cause instanceof VaultUnlockRequiredError)) throw cause; }
  try {
    current();
    if (local) { await clearCompletedAttempts(scope, current); notifyVaultChanged(); return; }
  }
  finally { local?.fill(0); }
  const record = await actor.get_account_vault();
  current();
  if (!record.length) {
    const unpublished = await loadUnpublishedAccountRoot(scope);
    try {
      current();
      if (unpublished) {
        await initializeAccountVault(actor, scope, unpublished);
        current(); await clearCompletedAttempts(scope, current); notifyVaultChanged(); return;
      }
    } finally { unpublished?.fill(0); }
  } else if (!emergency) {
    throw new Error("Account encryption already exists. Unlock it or choose explicit emergency recovery.");
  }
  const attemptKey = JSON.stringify([scope, emergency]);
  if (newAttempt) {
    // Only the separate, cost-labelled user action can abandon a request.
    await deletePendingAccountRootRequest(scope, emergency);
    current();
    paidAttempts.get(attemptKey)?.transport.secretKey.fill(0);
    paidAttempts.delete(attemptKey);
  }
  let attempt = paidAttempts.get(attemptKey);
  if (!attempt) {
    const saved = await readPendingAccountRootRequest(scope, emergency);
    if (saved) {
      try { current(); attempt = { id: saved.id, transport: restorePendingTransportKey(saved.secretKey, saved.publicKey) }; }
      finally { saved.secretKey.fill(0); }
    } else {
      current();
      attempt = { id: Date.now() + "_" + crypto.randomUUID(), transport: newTransportKey() };
    }
    try {
      // Persistence (including CryptoKey structured-clone support) is checked
      // before dispatch. The backend can replay the same encrypted reply after
      // a reload because this device still holds its protected transport.
      await writePendingAccountRootRequest(scope, emergency, { id: attempt.id, ...attempt.transport },
        () => generation === readAccountVaultSessionGeneration());
      current();
    } catch (cause) { attempt.transport.secretKey.fill(0); throw cause; }
    paidAttempts.set(attemptKey, attempt);
  }
  const publicKey = new Uint8Array(await actor.vetkd_public_key());
  current();
  validateVetkdMasterPublicKey(publicKey);
  const result = await actor.acquire_account_root(attempt.id, Array.from(attempt.transport.publicKey), emergency);
  current();
  if (!result || !Object.hasOwn(result, "Ok")) {
    // These exact responses are issued only before reservation/dispatch, after
    // existing request receipts have been checked. Keeping their unadmitted
    // timestamp until the cooldown ends would make the next manual retry stale.
    // Never discard an ambiguous/network failure, Pending receipt or paid result.
    if (result?.Err === "emergency root recovery is limited to once per 24 hours" ||
        result?.Err === "paid key derivation budget exhausted; retry later") {
      await deletePendingAccountRootRequest(scope, emergency, attempt.id);
      current();
      attempt.transport.secretKey.fill(0);
      if (paidAttempts.get(attemptKey) === attempt) paidAttempts.delete(attemptKey);
    }
    throw new Error(result?.Err ?? "Account key recovery could not finish.");
  }
  const root = await deriveConsumerWrapKeyProd(principal, attempt.transport, publicKey, new Uint8Array(result.Ok));
  try {
    current();
    const existing = await actor.get_account_vault();
    current();
    if (existing.length) await restoreAccountVaultWithRoot(actor, scope, root);
    else await initializeAccountVault(actor, scope, root);
    current();
    // Delete the only durable decryptor only AFTER the root and canonical
    // encrypted vault have been persisted successfully.
    await deletePendingAccountRootRequest(scope, emergency, attempt.id);
    current();
    attempt.transport.secretKey.fill(0);
    paidAttempts.delete(attemptKey);
    notifyVaultChanged();
  } finally {
    root.fill(0);
  }
}
