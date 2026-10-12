import { accountRootFingerprint, accountVaultScopeId, vaultAad, vaultB64, vaultOpen, vaultSeal, vaultUnb64, type AccountVaultScope, type VaultCiphertext } from "./accountVaultCrypto";

/** Software/browser-local protection; not a hardware-backed or XSS security boundary. */
export class VaultStorageUnavailableError extends Error {
  constructor() { super("Browser key storage is unavailable. Account keys were not saved."); this.name = "VaultStorageUnavailableError"; }
}
interface DeviceRecord {
  version: 1;
  principal: string;
  scope: string;
  fingerprint: string;
  protector: CryptoKey;
  root: VaultCiphertext;
}
const DATABASE = "iou-account-vault-v1";
const STORE = "device-roots";
export interface PendingAccountRootRequest { id: string; secretKey: Uint8Array; publicKey: Uint8Array }
interface PendingRequestRecord {
  version: 1; kind: "pending-root-request"; principal: string; scope: string;
  id: string; emergency: boolean; publicKeyB64: string; protector: CryptoKey; secret: VaultCiphertext;
}
function pendingId(scope: AccountVaultScope, emergency: boolean): string {
  return accountVaultScopeId(scope) + ":pending:" + emergency;
}
function requestAad(scope: AccountVaultScope, id: string, emergency: boolean, publicKeyB64: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid pending account request ID");
  return vaultAad(scope, "pending-account-root", JSON.stringify([id, emergency, publicKeyB64]));
}
function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new VaultStorageUnavailableError());
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(request.error ?? new VaultStorageUnavailableError());
    request.onblocked = () => reject(new VaultStorageUnavailableError());
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
  });
}
export async function readVaultDeviceRoot(scope: AccountVaultScope, fingerprint?: string): Promise<Uint8Array | null> {
  const db = await database();
  const id = accountVaultScopeId(scope);
  const record = await new Promise<DeviceRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const request = tx.objectStore(STORE).get(id);
    tx.oncomplete = () => { db.close(); resolve(request.result as DeviceRecord | undefined); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new VaultStorageUnavailableError()); };
  });
  if (!record) return null;
  if (record.version !== 1 || record.scope !== id || record.principal !== scope.principal || typeof record.fingerprint !== "string" || (fingerprint !== undefined && record.fingerprint !== fingerprint) || record.protector?.extractable !== false || record.protector.algorithm.name !== "AES-GCM") return null;
  const root = await vaultOpen(record.protector, record.root, vaultAad(scope, "device-root", record.fingerprint));
  try {
    if (await accountRootFingerprint(root, scope) !== record.fingerprint) throw new Error("Invalid cached account root");
    return root.slice();
  } finally { root.fill(0); }
}
export async function writeVaultDeviceRoot(scope: AccountVaultScope, root: Uint8Array, fingerprint: string, current: () => boolean): Promise<void> {
  // Store the protector and its ciphertext in one record/transaction. Concurrent writers
  // cannot leave ciphertext encrypted by a different winning protector.
  const protector = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const encrypted = await vaultSeal(protector, root, vaultAad(scope, "device-root", fingerprint));
  const db = await database();
  if (!current()) { db.close(); throw new Error("Account session changed"); }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put({ version: 1, principal: scope.principal, scope: accountVaultScopeId(scope), fingerprint, protector, root: encrypted } satisfies DeviceRecord, accountVaultScopeId(scope));
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new VaultStorageUnavailableError()); };
  });
}
export async function deleteVaultDeviceRoots(principal?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    if (principal === undefined) store.clear();
    else {
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if ((cursor.result.value as DeviceRecord).principal === principal) cursor.result.delete();
        cursor.result.continue();
      };
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new VaultStorageUnavailableError()); };
  });
}

/** Retains only a protected unfinished paid request, never a general transport session. */
export async function readPendingAccountRootRequest(scope: AccountVaultScope, emergency: boolean): Promise<PendingAccountRootRequest | null> {
  const db = await database();
  const record = await new Promise<PendingRequestRecord | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly"); const request = tx.objectStore(STORE).get(pendingId(scope, emergency));
    tx.oncomplete = () => { db.close(); resolve(request.result as PendingRequestRecord | undefined); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new VaultStorageUnavailableError()); };
  });
  if (!record) return null;
  if (record.version !== 1 || record.kind !== "pending-root-request" || record.scope !== accountVaultScopeId(scope) || record.principal !== scope.principal || record.emergency !== emergency || record.protector?.extractable !== false || record.protector.algorithm.name !== "AES-GCM") throw new Error("Invalid pending account request record");
  const publicKey = vaultUnb64(record.publicKeyB64, 48);
  if (publicKey.length !== 48) throw new Error("Invalid pending transport public key");
  const secretKey = await vaultOpen(record.protector, record.secret, requestAad(scope, record.id, emergency, record.publicKeyB64));
  if (secretKey.length !== 32) { secretKey.fill(0); throw new Error("Invalid pending transport secret"); }
  // The caller additionally validates SDK scalar/public-key consistency before reuse.
  return { id: record.id, secretKey, publicKey };
}
export async function writePendingAccountRootRequest(scope: AccountVaultScope, emergency: boolean, request: PendingAccountRootRequest, current: () => boolean): Promise<void> {
  if (request.secretKey.length !== 32 || request.publicKey.length !== 48) throw new Error("Invalid pending transport key length");
  const secret = request.secretKey.slice();
  const publicKeyB64 = vaultB64(request.publicKey);
  const aad = requestAad(scope, request.id, emergency, publicKeyB64);
  try {
    const protector = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const sealed = await vaultSeal(protector, secret, aad);
    const db = await database();
    if (!current()) { db.close(); throw new Error("Account session changed"); }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite"); const store = tx.objectStore(STORE); const id = pendingId(scope, emergency);
      const existing = store.get(id); let failure: Error | undefined;
      existing.onsuccess = () => {
        if (!current()) { failure = new Error("Account session changed"); tx.abort(); return; }
        const previous = existing.result as PendingRequestRecord | undefined;
        if (previous && (previous.id !== request.id || previous.publicKeyB64 !== publicKeyB64)) {
          failure = new Error("Another account recovery request is already pending. Retry to resume it."); tx.abort(); return;
        }
        if (!previous) store.put({ version: 1, kind: "pending-root-request", principal: scope.principal, scope: accountVaultScopeId(scope), id: request.id, emergency, publicKeyB64, protector, secret: sealed } satisfies PendingRequestRecord, id);
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new VaultStorageUnavailableError()); };
    });
  } finally { secret.fill(0); }
}
export async function deletePendingAccountRootRequest(scope: AccountVaultScope, emergency: boolean, expectedRequestId?: string): Promise<void> {
  const db = await database();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"); const store = tx.objectStore(STORE); const id = pendingId(scope, emergency);
    if (expectedRequestId === undefined) store.delete(id); // explicit user-requested abandonment
    else {
      const request = store.get(id);
      request.onsuccess = () => {
        // Another tab may have explicitly replaced this request while the old
        // response was in flight. Never delete its only durable decryptor.
        if ((request.result as PendingRequestRecord | undefined)?.id === expectedRequestId) store.delete(id);
      };
    }
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = tx.onerror = () => { db.close(); reject(tx.error ?? new VaultStorageUnavailableError()); };
  });
}
