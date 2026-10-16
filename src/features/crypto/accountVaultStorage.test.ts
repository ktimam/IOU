import { afterEach, describe, expect, it, vi } from "vitest";
import { clearVaultPasskeyEnrollmentRequired, deletePendingAccountRootRequest, deleteVaultDeviceRoots, readPendingAccountRootRequest, readVaultDeviceRoot, readVaultPasskeyEnrollmentRequired, VaultStorageUnavailableError, writePendingAccountRootRequest, writeVaultDeviceRoot } from "./accountVaultStorage";
import { accountRootFingerprint, vaultB64, type AccountVaultScope } from "./accountVaultCrypto";

const scope: AccountVaultScope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
function installIDB(records = new Map<string, any>()) {
  const makeTransaction = () => {
    let aborted = false;
    const finish = () => queueMicrotask(() => { if (!aborted) tx.oncomplete?.(); });
    const tx = {
      oncomplete: null as (() => void) | null, onabort: null as (() => void) | null, onerror: null, error: null,
      abort: () => { aborted = true; queueMicrotask(() => tx.onabort?.()); },
      objectStore: () => ({
        put: (value: unknown, key: string) => { records.set(key, structuredClone(value)); finish(); },
        delete: (key: string) => { records.delete(key); finish(); },
        clear: () => { records.clear(); finish(); },
        get: (key: string) => { const request = { result: records.get(key), onsuccess: null as (() => void) | null }; queueMicrotask(() => { request.onsuccess?.(); finish(); }); return request; },
        openCursor: () => {
          const keys = [...records.keys()]; let index = 0;
          const request = { result: null as null | { value: unknown; delete: () => void; continue: () => void }, onsuccess: null as (() => void) | null };
          const advance = () => queueMicrotask(() => {
            const key = keys[index++];
            request.result = key === undefined ? null : { value: records.get(key), delete: () => { records.delete(key); }, continue: advance };
            request.onsuccess?.(); if (!request.result) finish();
          }); advance(); return request;
        },
      }),
    };
    return tx;
  };
  vi.stubGlobal("indexedDB", { open: () => {
    const request = { onsuccess: null as (() => void) | null, onerror: null, onblocked: null, onupgradeneeded: null, result: { onversionchange: null, close: vi.fn(), transaction: makeTransaction } };
    queueMicrotask(() => request.onsuccess?.()); return request;
  } });
  return records;
}
afterEach(() => vi.unstubAllGlobals());
describe("account vault durable browser storage", () => {
  it("fails closed without IndexedDB and never falls back to localStorage plaintext", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const setItem = vi.fn(); vi.stubGlobal("localStorage", { setItem });
    await expect(writeVaultDeviceRoot(scope, new Uint8Array(32), "fp", () => true)).rejects.toBeInstanceOf(VaultStorageUnavailableError);
    await expect(readVaultDeviceRoot(scope, "fp")).rejects.toBeInstanceOf(VaultStorageUnavailableError);
    expect(setItem).not.toHaveBeenCalled();
  });
  it("stores only a nonextractable protector and encrypted root atomically", async () => {
    const records = installIDB();
    const root = new Uint8Array(32).fill(13);
    const fingerprint = await accountRootFingerprint(root, scope);
    await writeVaultDeviceRoot(scope, root, fingerprint, () => true);
    const record = [...records.values()][0] as { protector: CryptoKey; root: { ciphertext: string } };
    expect(record.protector.extractable).toBe(false);
    expect(record.protector.algorithm.name).toBe("AES-GCM");
    expect(record.root.ciphertext).not.toBe(vaultB64(root));
    expect(JSON.stringify(record)).not.toContain(vaultB64(root));
    expect(await readVaultDeviceRoot(scope, fingerprint)).toEqual(root);
    expect(await readVaultDeviceRoot(scope)).toEqual(root);
    expect(await readVaultDeviceRoot({ ...scope, principal: "bob" }, fingerprint)).toBeNull();
    expect(await readVaultDeviceRoot(scope, "wrong fingerprint")).toBeNull();
    await expect(writeVaultDeviceRoot(scope, root, fingerprint, () => false)).rejects.toThrow(/session changed/);
  });
  it("restores a protected unfinished paid request across database reopen and removes it on completion", async () => {
    const records = installIDB();
    const request = { id: "123_request", secretKey: new Uint8Array(32).fill(7), publicKey: new Uint8Array(48).fill(4) };
    await writePendingAccountRootRequest(scope, false, request, () => true);
    const stored = [...records.values()][0];
    expect(stored.protector.extractable).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(vaultB64(request.secretKey));
    installIDB(records); // no session-memory dependency
    expect(await readPendingAccountRootRequest(scope, false)).toEqual(request);
    expect(await readPendingAccountRootRequest(scope, true)).toBeNull();
    expect(await readPendingAccountRootRequest({ ...scope, principal: "bob" }, false)).toBeNull();
    await deletePendingAccountRootRequest(scope, false);
    expect(await readPendingAccountRootRequest(scope, false)).toBeNull();
  });
  it("atomically stores the emergency enrollment marker with its protected root and preserves it on ordinary writes", async () => {
    const records = installIDB(), root = new Uint8Array(32).fill(12);
    const fingerprint = await accountRootFingerprint(root, scope);
    expect(await readVaultPasskeyEnrollmentRequired(scope)).toBe(false);
    await writeVaultDeviceRoot(scope, root, fingerprint, () => true, true);
    expect(records.size).toBe(1); // No additional store or independent marker record.
    const stored = [...records.values()][0];
    expect(stored.passkeyEnrollmentRequired).toBe(true);
    expect(stored.protector.extractable).toBe(false);
    expect(JSON.stringify(stored)).not.toContain(vaultB64(root));
    installIDB(records);
    expect(await readVaultPasskeyEnrollmentRequired(scope)).toBe(true);
    await writeVaultDeviceRoot(scope, root, fingerprint, () => true);
    expect(await readVaultPasskeyEnrollmentRequired(scope)).toBe(true);
    expect(await readVaultDeviceRoot(scope, fingerprint)).toEqual(root);
    expect(await readVaultPasskeyEnrollmentRequired({ ...scope, principal: "bob" })).toBe(false);
    await clearVaultPasskeyEnrollmentRequired(scope, fingerprint, () => true);
    expect(await readVaultPasskeyEnrollmentRequired(scope)).toBe(false);
    expect(await readVaultDeviceRoot(scope, fingerprint)).toEqual(root);
  });
  it("does not clear an enrollment marker for another root or a stale account session", async () => {
    const records = installIDB(), root = new Uint8Array(32).fill(15);
    const fingerprint = await accountRootFingerprint(root, scope);
    await writeVaultDeviceRoot(scope, root, fingerprint, () => true, true);
    await expect(clearVaultPasskeyEnrollmentRequired(scope, "other-root", () => true)).rejects.toThrow(/encryption changed/);
    await expect(clearVaultPasskeyEnrollmentRequired(scope, fingerprint, () => false)).rejects.toThrow(/session changed/);
    let checks = 0;
    await expect(clearVaultPasskeyEnrollmentRequired(scope, fingerprint, () => ++checks === 1)).rejects.toThrow(/session changed/);
    expect(await readVaultPasskeyEnrollmentRequired(scope)).toBe(true);
    expect(records.size).toBe(1);
    await deleteVaultDeviceRoots(scope.principal);
    expect(records.size).toBe(0);
    await expect(clearVaultPasskeyEnrollmentRequired(scope, fingerprint, () => true)).rejects.toThrow(/encryption changed/);
    expect(records.size).toBe(0); // A late completion cannot recreate logout-deleted keys.
  });
  it("does not write a recovered root or marker when logout wins before the atomic transaction", async () => {
    const records = installIDB(), root = new Uint8Array(32).fill(15);
    const fingerprint = await accountRootFingerprint(root, scope);
    let checks = 0;
    await expect(writeVaultDeviceRoot(scope, root, fingerprint, () => ++checks === 1, true)).rejects.toThrow(/session changed/);
    expect(records.size).toBe(0);
  });
  it("fails before a paid request can start when storage is unavailable, stale or already reserved", async () => {
    const request = { id: "request", secretKey: new Uint8Array(32).fill(7), publicKey: new Uint8Array(48).fill(4) };
    vi.stubGlobal("indexedDB", undefined);
    await expect(writePendingAccountRootRequest(scope, false, request, () => true)).rejects.toBeInstanceOf(VaultStorageUnavailableError);
    const records = installIDB();
    await expect(writePendingAccountRootRequest(scope, false, request, () => false)).rejects.toThrow(/session changed/);
    expect(records.size).toBe(0);
    await writePendingAccountRootRequest(scope, false, request, () => true);
    await expect(writePendingAccountRootRequest(scope, false, { ...request, id: "other" }, () => true)).rejects.toThrow(/already pending/);
    expect(await readPendingAccountRootRequest(scope, false)).toEqual(request);
  });
  it("authenticates request ID, emergency flag and transport public key; logout purges pending records", async () => {
    const records = installIDB();
    const request = { id: "request", secretKey: new Uint8Array(32).fill(7), publicKey: new Uint8Array(48).fill(4) };
    await writePendingAccountRootRequest(scope, false, request, () => true);
    const [key, original] = [...records.entries()][0];
    for (const altered of [{ ...original, id: "other" }, { ...original, emergency: true }, { ...original, publicKeyB64: vaultB64(new Uint8Array(48).fill(8)) }]) {
      records.set(key, altered);
      await expect(readPendingAccountRootRequest(scope, false)).rejects.toThrow();
    }
    records.set(key, original);
    await writePendingAccountRootRequest({ ...scope, principal: "bob" }, false, request, () => true);
    await deleteVaultDeviceRoots("alice");
    expect(await readPendingAccountRootRequest(scope, false)).toBeNull();
    expect(await readPendingAccountRootRequest({ ...scope, principal: "bob" }, false)).toEqual(request);
  });
  it("does not delete a newer tab's pending request when an older completion cleans up", async () => {
    installIDB();
    const request = { id: "newer_request", secretKey: new Uint8Array(32).fill(7), publicKey: new Uint8Array(48).fill(4) };
    await writePendingAccountRootRequest(scope, true, request, () => true);
    await deletePendingAccountRootRequest(scope, true, "older_request");
    expect(await readPendingAccountRootRequest(scope, true)).toEqual(request);
    await deletePendingAccountRootRequest(scope, true, request.id);
    expect(await readPendingAccountRootRequest(scope, true)).toBeNull();
  });
});
