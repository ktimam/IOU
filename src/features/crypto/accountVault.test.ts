import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountRootFingerprint, accountVaultScopeId, createAccountVaultPayload, decodeAccountVault, encodeAccountVault, type AccountVaultScope } from "./accountVaultCrypto";

const disk = vi.hoisted(() => ({ records: new Map<string, Uint8Array>(), requirements: new Set<string>(), read: vi.fn(), write: vi.fn(), remove: vi.fn(), readRequired: vi.fn(), clearRequired: vi.fn() }));
const passkeys = vi.hoisted(() => ({ enroll: vi.fn(), unlock: vi.fn() }));
vi.mock("./accountVaultStorage", () => ({
  VaultStorageUnavailableError: class extends Error {},
  readVaultDeviceRoot: disk.read, writeVaultDeviceRoot: disk.write, deleteVaultDeviceRoots: disk.remove,
  readVaultPasskeyEnrollmentRequired: disk.readRequired, clearVaultPasskeyEnrollmentRequired: disk.clearRequired,
}));
vi.mock("./accountVaultPasskey", () => ({ enrollVaultPasskey: passkeys.enroll, unlockVaultPasskeys: passkeys.unlock }));
import { addPasskeyBackup, addRecoveryCodeBackup, assertAccountVaultSessionGeneration, clearAccountVaultDevice, clearAccountVaultMemory, getAccountVaultSheetKeypair, initializeAccountVault, isAccountPasskeyEnrollmentRequired, loadAccountRoot, loadUnpublishedAccountRoot, readAccountVaultSessionGeneration, registerAccountVaultCleanup, restoreAccountVaultWithRoot, unlockAccountVaultWithPasskey, unlockAccountVaultWithRecoveryCode, VaultBackupOutcomeUnknownError, VaultPasskeyBackupOutcomeUnknownError, VaultConflictError, VaultUnlockRequiredError, type AccountVaultActor } from "./accountVault";
import { prepareManagedRecovery, confirmManagedRecovery, unlockManagedRecovery, readManagedRecoveryDescriptor, VaultManagedRecoveryOutcomeUnknownError } from "./accountVault";

const scope: AccountVaultScope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
const root = new Uint8Array(32).fill(31);
const recoveryOrigin = "https://iou.example";
const passkeyBackup = { credentialId: "credential-1", rpId: "iou.example", prfSalt: "salt", iv: "iv", ciphertext: "sealed-root" };
function server() {
  let record: { revision: bigint; payload: number[] } | null = null;
  const actor = {
    get_account_vault: vi.fn(async () => record ? [structuredClone(record)] as [{ revision: bigint; payload: number[] }] : [] as []),
    set_account_vault: vi.fn(async (expected: bigint, payload: number[]) => {
      if (expected !== (record?.revision ?? 0n)) return { Err: "revision conflict" };
      record = { revision: expected + 1n, payload: [...payload] };
      return { Ok: record.revision };
    }),
    register_account_wrapping_key: vi.fn(async () => ({ Ok: null })),
    vetkd_wrap_consumer_key: vi.fn(),
    acquire_account_root: vi.fn(),
  } satisfies AccountVaultActor & { vetkd_wrap_consumer_key: ReturnType<typeof vi.fn>; acquire_account_root: ReturnType<typeof vi.fn> };
  return { actor, get record() { return record; }, set record(value) { record = value; } };
}
beforeEach(() => {
  clearAccountVaultMemory(); disk.records.clear(); disk.requirements.clear(); vi.clearAllMocks();
  passkeys.enroll.mockReset().mockImplementation(async () => ({ ...passkeyBackup }));
  passkeys.unlock.mockReset();
  disk.read.mockImplementation(async (s: AccountVaultScope) => disk.records.get(accountVaultScopeId(s))?.slice() ?? null);
  disk.write.mockImplementation(async (s: AccountVaultScope, key: Uint8Array, _fp: string, current: () => boolean, required = false) => {
    if (!current()) throw new Error("Account session changed");
    disk.records.set(accountVaultScopeId(s), key.slice());
    if (required) disk.requirements.add(accountVaultScopeId(s));
  });
  disk.readRequired.mockReset().mockImplementation(async (s: AccountVaultScope) => disk.requirements.has(accountVaultScopeId(s)));
  disk.clearRequired.mockReset().mockImplementation(async (s: AccountVaultScope, fingerprint: string, current: () => boolean) => {
    const stored = disk.records.get(accountVaultScopeId(s));
    if (!stored || await accountRootFingerprint(stored, s) !== fingerprint) throw new Error("Account encryption changed");
    if (!current()) throw new Error("Account session changed");
    disk.requirements.delete(accountVaultScopeId(s));
  });
  disk.remove.mockImplementation(async () => { disk.records.clear(); disk.requirements.clear(); });
});

describe("durable replacement enrollment after emergency recovery", () => {
  it("keeps the replacement gate over reloads and free restores until a new passkey is verified", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await addPasskeyBackup(state.actor, scope);
    const before = structuredClone(state.record);
    await restoreAccountVaultWithRoot(state.actor, scope, root, true);
    expect(state.record).toEqual(before); // Old passkey/server backup remains intact.
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    clearAccountVaultMemory();
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    await restoreAccountVaultWithRoot(state.actor, scope, root); // Ordinary restore preserves marker.
    passkeys.unlock.mockResolvedValue(root.slice());
    await unlockAccountVaultWithPasskey(state.actor, scope);
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    passkeys.enroll.mockResolvedValueOnce({ ...passkeyBackup, credentialId: "replacement" });
    await addPasskeyBackup(state.actor, scope);
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(false);
    expect(decodeAccountVault(state.record!.payload, scope).passkeys.map(value => value.credentialId)).toEqual([passkeyBackup.credentialId, "replacement"]);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "unverified", "conflict"])("does not clear the durable marker after %s enrollment", async (failure) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await restoreAccountVaultWithRoot(state.actor, scope, root, true);
    if (failure === "cancelled") passkeys.enroll.mockRejectedValueOnce(new Error("cancelled"));
    else if (failure === "conflict") state.actor.set_account_vault.mockResolvedValueOnce({ Err: "conflict" });
    else state.actor.set_account_vault.mockRejectedValueOnce(new Error("unknown outcome"));
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toThrow();
    expect(disk.clearRequired).not.toHaveBeenCalled();
    clearAccountVaultMemory();
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it("stays gated if the verified backup cannot clear its local marker", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await restoreAccountVaultWithRoot(state.actor, scope, root, true);
    disk.clearRequired.mockRejectedValueOnce(new Error("IndexedDB unavailable"));
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toBeInstanceOf(VaultPasskeyBackupOutcomeUnknownError);
    expect(decodeAccountVault(state.record!.payload, scope).passkeys).toEqual([passkeyBackup]);
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it("rejects a marker read from the previous account session", async () => {
    let finish!: (value: boolean) => void;
    disk.readRequired.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = isAccountPasskeyEnrollmentRequired(scope);
    clearAccountVaultMemory(); finish(true);
    await expect(pending).rejects.toThrow(/session changed/);
  });

  it("cannot clear or repopulate a marker when logout interrupts verified enrollment", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await restoreAccountVaultWithRoot(state.actor, scope, root, true);
    let finish!: () => void;
    disk.clearRequired.mockImplementationOnce(async (_scope: AccountVaultScope, _fp: string, current: () => boolean) => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (!current()) throw new Error("Account session changed");
      disk.requirements.delete(accountVaultScopeId(scope));
    });
    const pending = addPasskeyBackup(state.actor, scope);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await clearAccountVaultDevice(scope.principal); finish();
    await expect(pending).rejects.toThrow(/session changed/);
    expect(disk.records.size).toBe(0);
    expect(disk.requirements.size).toBe(0);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
});
describe("verified encryption passkey enrollment", () => {
  it("verifies the stored backup and preserves the root, wrapping keys and older backups", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await addRecoveryCodeBackup(state.actor, scope);
    await addPasskeyBackup(state.actor, scope);
    const before = decodeAccountVault(state.record!.payload, scope);
    const nextBackup = { ...passkeyBackup, credentialId: "credential-2", ciphertext: "next-sealed-root" };
    passkeys.enroll.mockResolvedValueOnce(nextBackup);
    state.actor.get_account_vault.mockClear(); state.actor.set_account_vault.mockClear();
    const result = await addPasskeyBackup(state.actor, scope);
    const after = decodeAccountVault(state.record!.payload, scope);
    expect(result).toEqual({ credentialId: nextBackup.credentialId, revision: state.record!.revision });
    expect(after).toEqual({ ...before, passkeys: [...before.passkeys, nextBackup] });
    expect(state.actor.get_account_vault).toHaveBeenCalledTimes(2);
    expect(state.actor.set_account_vault).toHaveBeenCalledOnce();
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
    expect(state.actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
  });

  it.each(["Passkey creation was cancelled", "This provider does not support encryption (PRF)"])("keeps enrollment retry free after %s", async (message) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const before = structuredClone(state.record);
    passkeys.enroll.mockRejectedValueOnce(new Error(message));
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toThrow(message);
    expect(state.record).toEqual(before);
    expect(state.actor.set_account_vault).toHaveBeenCalledOnce(); // Only initialization.
    const providerRoot = passkeys.enroll.mock.calls[0][0] as Uint8Array;
    expect(providerRoot.every(byte => byte === 0)).toBe(true);
    clearAccountVaultMemory(); // Reload keeps protected device storage.
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
    await expect(addPasskeyBackup(state.actor, scope)).resolves.toMatchObject({ credentialId: passkeyBackup.credentialId });
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
    expect(state.actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });

  it("reconciles an enrolled passkey whose update reply was lost without repeating the write or prompt", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      state.record = { revision: revision + 1n, payload };
      throw new Error("response lost after commit");
    });
    await expect(addPasskeyBackup(state.actor, scope)).resolves.toEqual({ credentialId: passkeyBackup.credentialId, revision: 2n });
    expect(passkeys.enroll).toHaveBeenCalledOnce();
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2); // Initialize + one enrollment.
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not report success when an enrollment cannot be verified (acknowledged=%s)", async (acknowledged) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      state.record = { revision: revision + 1n, payload };
      state.actor.get_account_vault.mockRejectedValueOnce(new Error("still offline"));
      if (!acknowledged) throw new Error("unknown outcome");
      return { Ok: revision + 1n };
    });
    const pending = addPasskeyBackup(state.actor, scope);
    await expect(pending).rejects.toBeInstanceOf(VaultPasskeyBackupOutcomeUnknownError);
    await pending.catch((error: Error) => {
      expect(error.message).toMatch(/keep the passkey.*refresh/i);
      expect(error.message).not.toMatch(/displayed code|recovery code/);
    });
    expect(decodeAccountVault(state.record!.payload, scope).passkeys).toEqual([passkeyBackup]);
    clearAccountVaultMemory();
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(passkeys.enroll).toHaveBeenCalledOnce();
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it("keeps the protected root and original backups when the update did not commit", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await addRecoveryCodeBackup(state.actor, scope);
    const before = structuredClone(state.record);
    state.actor.set_account_vault.mockRejectedValueOnce(new Error("network outcome unknown"));
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toBeInstanceOf(VaultPasskeyBackupOutcomeUnknownError);
    expect(state.record).toEqual(before);
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it.each(["credentialId", "rpId", "prfSalt", "iv", "ciphertext"] as const)("rejects a same-revision backup whose %s does not match the enrolled credential", async (field) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      const changed = decodeAccountVault(payload, scope);
      changed.passkeys[0][field] += "-different";
      state.record = { revision: revision + 1n, payload: Array.from(encodeAccountVault(changed)) };
      return { Ok: revision + 1n };
    });
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toBeInstanceOf(VaultPasskeyBackupOutcomeUnknownError);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it.each(["rootFingerprint", "keyId", "publicKeyB64"] as const)("rejects a matching credential if its canonical %s changed", async (field) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      const changed = decodeAccountVault(payload, scope);
      if (field === "rootFingerprint") changed.rootFingerprint += "-different";
      else changed.sheetKey[field] += "-different";
      state.record = { revision: revision + 1n, payload: Array.from(encodeAccountVault(changed)) };
      return { Ok: revision + 1n };
    });
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toBeInstanceOf(VaultPasskeyBackupOutcomeUnknownError);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it("does not reconcile or overwrite a definitive passkey CAS refusal", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const before = structuredClone(state.record);
    state.actor.get_account_vault.mockClear();
    state.actor.set_account_vault.mockResolvedValueOnce({ Err: "revision conflict" });
    await expect(addPasskeyBackup(state.actor, scope)).rejects.toBeInstanceOf(VaultConflictError);
    expect(state.actor.get_account_vault).toHaveBeenCalledOnce();
    expect(state.record).toEqual(before);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it("does not save a late passkey enrollment after sign-out or account switch", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    let finish!: (value: typeof passkeyBackup) => void;
    passkeys.enroll.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = addPasskeyBackup(state.actor, scope);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await clearAccountVaultDevice(scope.principal);
    finish({ ...passkeyBackup });
    await expect(pending).rejects.toThrow(/session changed/);
    expect(state.actor.set_account_vault).toHaveBeenCalledOnce();
    expect(decodeAccountVault(state.record!.payload, scope).passkeys).toEqual([]);
    expect(disk.records.size).toBe(0);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });

  it("rejects a late verification result after sign-out without restoring local keys", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    let finish!: (value: NonNullable<typeof state.record>[]) => void;
    state.actor.get_account_vault.mockResolvedValueOnce([structuredClone(state.record!)]);
    state.actor.get_account_vault.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const pending = addPasskeyBackup(state.actor, scope);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await clearAccountVaultDevice(scope.principal);
    finish([structuredClone(state.record!)]);
    await expect(pending).rejects.toThrow(/session changed/);
    expect(disk.records.size).toBe(0);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
});

describe("password-manager recovery without paid requests", () => {
  it("coalesces duplicate mounted preparation into one saved candidate without provider or paid calls", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const before = decodeAccountVault(state.record!.payload, scope);
    const [first, second, third] = await Promise.all([
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
    ]);
    expect(second).toEqual(first); expect(third).toEqual(first);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2); // Initial vault + one recovery candidate.
    const after = decodeAccountVault(state.record!.payload, scope);
    expect({ ...after, managedRecovery: undefined }).toEqual({ ...before, managedRecovery: undefined });
    expect(after.managedRecovery!.verifiedOrigins).toEqual([]);
    expect(passkeys.enroll).not.toHaveBeenCalled(); expect(passkeys.unlock).not.toHaveBeenCalled();
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled(); expect(state.actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });
  it("shares an uncertain preparation failure, then reuses its committed candidate on explicit retry", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      state.record = { revision: revision + 1n, payload };
      state.actor.get_account_vault.mockRejectedValueOnce(new Error("offline"));
      throw new Error("lost reply");
    });
    const results = await Promise.allSettled([
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
    ]);
    expect(results.every(result => result.status === "rejected" && result.reason instanceof VaultManagedRecoveryOutcomeUnknownError)).toBe(true);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    const committed = structuredClone(state.record);
    const retried = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    expect(await prepareManagedRecovery(state.actor, scope, recoveryOrigin)).toEqual(retried);
    expect(state.record).toEqual(committed); expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it("shares the candidate across origins but does not share origin-specific verification", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const prepared = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    await confirmManagedRecovery(state.actor, scope, recoveryOrigin, prepared.credentialId, prepared.secret);
    const writes = state.actor.set_account_vault.mock.calls.length;
    const [verified, other] = await Promise.all([
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
      prepareManagedRecovery(state.actor, scope, "https://iou.example:9443"),
    ]);
    expect(verified).toEqual({ ...prepared, verified: true });
    expect(other).toEqual(prepared);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(writes);
  });
  it("does not share in-flight candidates with another account", async () => {
    const alice = server(), bob = server(); const bobScope = { ...scope, principal: "bob" };
    await initializeAccountVault(alice.actor, scope, root);
    await initializeAccountVault(bob.actor, bobScope, root);
    const [a, b] = await Promise.all([
      prepareManagedRecovery(alice.actor, scope, recoveryOrigin),
      prepareManagedRecovery(bob.actor, bobScope, recoveryOrigin),
    ]);
    expect(a.credentialId).not.toBe(b.credentialId); expect(a.secret).not.toBe(b.secret);
    expect(alice.actor.set_account_vault).toHaveBeenCalledTimes(2); expect(bob.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(alice.actor.acquire_account_root).not.toHaveBeenCalled(); expect(bob.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it("rejects all late coalesced preparation after logout without writing or revealing a candidate", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    let finish!: (value: NonNullable<typeof state.record>[]) => void;
    state.actor.get_account_vault.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const results = Promise.allSettled([
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
      prepareManagedRecovery(state.actor, scope, recoveryOrigin),
    ]);
    await clearAccountVaultDevice(scope.principal); finish([structuredClone(state.record!)]);
    expect((await results).every(result => result.status === "rejected" && /session changed/.test(result.reason.message))).toBe(true);
    expect(state.actor.set_account_vault).toHaveBeenCalledOnce(); expect(disk.records.size).toBe(0);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
    await restoreAccountVaultWithRoot(state.actor, scope, root);
    expect((await prepareManagedRecovery(state.actor, scope, recoveryOrigin)).verified).toBe(false);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
  });
  it("preserves original root, sheet key and legacy backups through preparation, restore and reload", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const legacy = await addRecoveryCodeBackup(state.actor, scope); await addPasskeyBackup(state.actor, scope);
    const before = decodeAccountVault(state.record!.payload, scope);
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    expect(ready.verified).toBe(false);
    const prepared = decodeAccountVault(state.record!.payload, scope);
    expect({ ...prepared, managedRecovery: undefined }).toEqual({ ...before, managedRecovery: undefined });
    expect(prepared.managedRecovery?.verifiedOrigins).toEqual([]);
    const writes = state.actor.set_account_vault.mock.calls.length;
    clearAccountVaultMemory();
    expect(await prepareManagedRecovery(state.actor, scope, recoveryOrigin)).toEqual(ready);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(writes);
    await clearAccountVaultDevice(scope.principal);
    expect(await readManagedRecoveryDescriptor(state.actor, scope, recoveryOrigin)).toEqual({ credentialId: ready.credentialId, verified: false });
    await unlockManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, ready.secret);
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
    expect(await readManagedRecoveryDescriptor(state.actor, scope, recoveryOrigin)).toEqual({ credentialId: ready.credentialId, verified: true });
    expect((await getAccountVaultSheetKeypair(state.actor, scope)).keyId).toBe(before.sheetKey.keyId);
    await clearAccountVaultDevice(scope.principal);
    await unlockAccountVaultWithRecoveryCode(state.actor, scope, legacy.recoveryCode);
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
    expect(state.actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
    expect(passkeys.unlock).not.toHaveBeenCalled();
  });
  it("keeps the sticky gate after preparation or failed confirmation and clears it only after verified restore", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await restoreAccountVaultWithRoot(state.actor, scope, root, true);
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    await expect(confirmManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, "invalid")).rejects.toThrow();
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(true);
    await confirmManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, ready.secret);
    expect(await isAccountPasskeyEnrollmentRequired(scope)).toBe(false);
    expect(decodeAccountVault(state.record!.payload, scope).managedRecovery?.verifiedOrigins).toEqual([recoveryOrigin]);
    const writes = state.actor.set_account_vault.mock.calls.length;
    await confirmManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, ready.secret);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(writes);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it("makes verification origin-specific without rotating the credential", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    await confirmManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, ready.secret);
    const otherOrigin = "https://iou.example:9443";
    expect(await readManagedRecoveryDescriptor(state.actor, scope, otherOrigin)).toEqual({ credentialId: ready.credentialId, verified: false });
    const next = await prepareManagedRecovery(state.actor, scope, otherOrigin);
    expect(next).toEqual(ready);
    await clearAccountVaultDevice(scope.principal);
    await unlockManagedRecovery(state.actor, scope, otherOrigin, ready.credentialId, ready.secret);
    expect(decodeAccountVault(state.record!.payload, scope).managedRecovery?.verifiedOrigins).toEqual([recoveryOrigin, otherOrigin]);
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it("requires an unlocked root for initial preparation and does not create a candidate from a locked session", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await clearAccountVaultDevice(scope.principal);
    expect(await readManagedRecoveryDescriptor(state.actor, scope, recoveryOrigin)).toBeNull();
    await expect(prepareManagedRecovery(state.actor, scope, recoveryOrigin)).rejects.toBeInstanceOf(VaultUnlockRequiredError);
    expect(state.actor.set_account_vault).toHaveBeenCalledOnce();
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it.each([false, true])("reconciles a single candidate write before revealing the secret (acknowledged=%s)", async (acknowledged) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      state.record = { revision: revision + 1n, payload };
      if (!acknowledged) throw new Error("lost reply");
      return { Ok: revision + 1n };
    });
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    expect(ready.secret).toMatch(/^IOU1-/);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(await prepareManagedRecovery(state.actor, scope, recoveryOrigin)).toEqual(ready);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
  });
  it("does not expose an unverified candidate and reuses the committed one after an ambiguous network outcome", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      state.record = { revision: revision + 1n, payload };
      state.actor.get_account_vault.mockRejectedValueOnce(new Error("offline"));
      throw new Error("lost reply");
    });
    await expect(prepareManagedRecovery(state.actor, scope, recoveryOrigin)).rejects.toBeInstanceOf(VaultManagedRecoveryOutcomeUnknownError);
    const candidate = structuredClone(state.record);
    clearAccountVaultMemory();
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    expect(state.record).toEqual(candidate);
    expect(ready.verified).toBe(false);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
    expect(disk.clearRequired).not.toHaveBeenCalled();
  });
  it("does not retry or overwrite a definitive CAS refusal", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const before = structuredClone(state.record);
    state.actor.set_account_vault.mockResolvedValueOnce({ Err: "conflict" });
    await expect(prepareManagedRecovery(state.actor, scope, recoveryOrigin)).rejects.toBeInstanceOf(VaultConflictError);
    expect(state.record).toEqual(before);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
  });
  it.each(["id", "backup", "protectedSecret", "privateKey"])("rejects an acknowledged candidate whose %s changed on readback", async (field) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      const changed = decodeAccountVault(payload, scope);
      if (field === "id") changed.managedRecovery!.id = changed.managedRecovery!.id.split("").reverse().join("");
      else if (field === "privateKey") changed.sheetKey.privateKey.ciphertext += "AAAA";
      else changed.managedRecovery![field as "backup" | "protectedSecret"].iv = "AAAAAAAAAAAAAAAA";
      state.record = { revision: revision + 1n, payload: Array.from(encodeAccountVault(changed)) };
      return { Ok: revision + 1n };
    });
    await expect(prepareManagedRecovery(state.actor, scope, recoveryOrigin)).rejects.toBeInstanceOf(VaultManagedRecoveryOutcomeUnknownError);
    expect(disk.clearRequired).not.toHaveBeenCalled();
  });
  it("rejects a late locked descriptor after an account change", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    let finish!: (value: NonNullable<typeof state.record>[]) => void;
    state.actor.get_account_vault.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    const reading = readManagedRecoveryDescriptor(state.actor, scope, recoveryOrigin);
    clearAccountVaultMemory(); finish([structuredClone(state.record!)]);
    await expect(reading).rejects.toThrow(/session changed/);
  });
  it("does not clear the marker or store a locked device root when confirmation readback fails", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    await clearAccountVaultDevice(scope.principal); disk.write.mockClear();
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      state.record = { revision: revision + 1n, payload };
      state.actor.get_account_vault.mockRejectedValueOnce(new Error("offline"));
      return { Ok: revision + 1n };
    });
    await expect(confirmManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, ready.secret)).rejects.toBeInstanceOf(VaultManagedRecoveryOutcomeUnknownError);
    expect(disk.write).not.toHaveBeenCalled(); expect(disk.clearRequired).not.toHaveBeenCalled();
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it.each(["credential", "secret", "scope"])("rejects wrong %s without local persistence or publication", async (field) => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    await clearAccountVaultDevice(scope.principal); disk.write.mockClear(); state.actor.register_account_wrapping_key.mockClear();
    await expect(unlockManagedRecovery(state.actor, field === "scope" ? { ...scope, principal: "bob" } : scope, recoveryOrigin,
      field === "credential" ? "stale-username" : ready.credentialId, field === "secret" ? ready.secret.slice(0, -1) + (ready.secret.endsWith("A") ? "Q" : "A") : ready.secret)).rejects.toThrow();
    expect(disk.write).not.toHaveBeenCalled(); expect(state.actor.register_account_wrapping_key).not.toHaveBeenCalled();
    expect(state.actor.acquire_account_root).not.toHaveBeenCalled();
  });
  it("rejects a late confirmation readback after logout without repopulating local state", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const ready = await prepareManagedRecovery(state.actor, scope, recoveryOrigin);
    let finish!: (value: NonNullable<typeof state.record>[]) => void;
    state.actor.get_account_vault.mockResolvedValueOnce([structuredClone(state.record!)]);
    state.actor.get_account_vault.mockImplementationOnce(() => new Promise(resolve => { finish = resolve as typeof finish; }));
    state.actor.register_account_wrapping_key.mockClear();
    const operation = confirmManagedRecovery(state.actor, scope, recoveryOrigin, ready.credentialId, ready.secret);
    await vi.waitFor(() => expect(finish).toBeDefined());
    await clearAccountVaultDevice(scope.principal); finish([structuredClone(state.record!)]);
    await expect(operation).rejects.toThrow(/session changed/);
    expect(disk.records.size).toBe(0); expect(disk.clearRequired).not.toHaveBeenCalled();
    expect(state.actor.register_account_wrapping_key).not.toHaveBeenCalled();
  });
});

describe("account vault lifecycle without implicit paid calls", () => {
  it("reuses a protected root after publication fails without another paid recovery", async () => {
    const { actor } = server();
    actor.set_account_vault.mockRejectedValueOnce(new Error("offline"));
    await expect(initializeAccountVault(actor, scope, root)).rejects.toThrow("offline");
    clearAccountVaultMemory();
    expect(await loadAccountRoot(actor, scope)).toBeNull();
    const saved = await loadUnpublishedAccountRoot(scope);
    expect(saved).toEqual(root);
    expect((await initializeAccountVault(actor, scope, saved!)).created).toBe(true);
    saved!.fill(0);
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });
  it("exposes a guard and invokes registered cleanup when logout invalidates paid work", () => {
    const generation = readAccountVaultSessionGeneration();
    const callback = vi.fn(); const unregister = registerAccountVaultCleanup(callback);
    expect(() => assertAccountVaultSessionGeneration(generation)).not.toThrow();
    clearAccountVaultMemory();
    expect(callback).toHaveBeenCalledOnce();
    expect(() => assertAccountVaultSessionGeneration(generation)).toThrow(/session changed/);
    unregister(); clearAccountVaultMemory();
    expect(callback).toHaveBeenCalledOnce();
  });
  it("returns null for a new account and never calls paid recovery", async () => {
    const { actor } = server();
    expect(await loadAccountRoot(actor, scope)).toBeNull();
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });
  it("initializes once, restores after a reload, and exposes only a nonextractable private handle", async () => {
    const { actor } = server();
    expect((await initializeAccountVault(actor, scope, root)).created).toBe(true);
    clearAccountVaultMemory();
    expect(await loadAccountRoot(actor, scope)).toEqual(root);
    expect((await getAccountVaultSheetKeypair(actor, scope)).privateKey.extractable).toBe(false);
    expect((await initializeAccountVault(actor, scope, root)).created).toBe(false);
    expect(actor.set_account_vault).toHaveBeenCalledTimes(1);
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });
  it("requires explicit recovery on a new device and restores using a saved code", async () => {
    const { actor } = server();
    await initializeAccountVault(actor, scope, root);
    const { recoveryCode } = await addRecoveryCodeBackup(actor, scope);
    await clearAccountVaultDevice(scope.principal);
    await expect(loadAccountRoot(actor, scope)).rejects.toBeInstanceOf(VaultUnlockRequiredError);
    await unlockAccountVaultWithRecoveryCode(actor, scope, recoveryCode);
    expect(await loadAccountRoot(actor, scope)).toEqual(root);
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });
  it("does not overwrite canonical keys when another initializer wins CAS", async () => {
    const state = server();
    const winner = await createAccountVaultPayload(root, scope);
    state.actor.set_account_vault.mockImplementationOnce(async () => {
      state.record = { revision: 1n, payload: Array.from(encodeAccountVault(winner)) };
      return { Err: "conflict" };
    });
    const result = await initializeAccountVault(state.actor, scope, root);
    expect(result.created).toBe(false);
    expect(result.keyId).toBe(winner.sheetKey.keyId);
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(1);
  });
  it("fails before remote CAS if browser persistence fails", async () => {
    const { actor } = server(); disk.write.mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(initializeAccountVault(actor, scope, root)).rejects.toThrow(/IndexedDB/);
    expect(actor.set_account_vault).not.toHaveBeenCalled();
    expect(actor.register_account_wrapping_key).not.toHaveBeenCalled();
  });
  it("rejects a wrong emergency root before replacing local storage", async () => {
    const { actor } = server(); await initializeAccountVault(actor, scope, root);
    disk.write.mockClear();
    await expect(restoreAccountVaultWithRoot(actor, scope, new Uint8Array(32).fill(9))).rejects.toThrow(/root/);
    expect(disk.write).not.toHaveBeenCalled();
  });
  it("isolates account and deployment scopes even if an actor returns another account record", async () => {
    const { actor } = server(); await initializeAccountVault(actor, scope, root);
    await expect(loadAccountRoot(actor, { ...scope, principal: "bob" })).rejects.toThrow();
    await expect(loadAccountRoot(actor, { ...scope, host: "http://localhost:4943" })).rejects.toThrow();
  });
  it("coalesces concurrent reads but returns independent byte copies", async () => {
    const { actor } = server(); await initializeAccountVault(actor, scope, root);
    clearAccountVaultMemory(); actor.get_account_vault.mockClear();
    const [a, b] = await Promise.all([loadAccountRoot(actor, scope), loadAccountRoot(actor, scope)]);
    expect(actor.get_account_vault).toHaveBeenCalledTimes(1);
    a!.fill(0); expect(b).toEqual(root);
    expect(await loadAccountRoot(actor, scope)).toEqual(root);
  });
  it("cannot repopulate memory after logout interrupts a key read", async () => {
    const { actor } = server(); await initializeAccountVault(actor, scope, root); clearAccountVaultMemory();
    let resolveRead!: (value: Uint8Array) => void;
    disk.read.mockImplementationOnce(() => new Promise<Uint8Array>((resolve) => { resolveRead = resolve; }));
    const reading = loadAccountRoot(actor, scope);
    await vi.waitFor(() => expect(resolveRead).toBeDefined());
    await clearAccountVaultDevice(scope.principal);
    resolveRead(root.slice());
    await expect(reading).rejects.toThrow(/session changed/);
    await expect(loadAccountRoot(actor, scope)).rejects.toBeInstanceOf(VaultUnlockRequiredError);
  });
  it("keeps the root fingerprint and wrapping public key stable when updating recovery", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    const original = decodeAccountVault(state.record!.payload, scope);
    await addRecoveryCodeBackup(state.actor, scope);
    const next = decodeAccountVault(state.record!.payload, scope);
    expect(next.sheetKey).toEqual(original.sheetKey);
    expect(next.rootFingerprint).toBe(await accountRootFingerprint(root, scope));
    expect(next.recovery).not.toBeNull();
  });
  it("displays the prepared code before CAS and reconciles a committed update whose response was lost", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    let displayed = "";
    state.actor.set_account_vault.mockImplementationOnce(async (revision, payload) => {
      expect(displayed).toMatch(/^IOU1-/);
      state.record = { revision: revision + 1n, payload };
      throw new Error("response lost after commit");
    });
    const backup = await addRecoveryCodeBackup(state.actor, scope, (code) => { displayed = code; });
    expect(backup).toEqual({ recoveryCode: displayed, revision: 2n });
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2); // initialize + single update
    await clearAccountVaultDevice(scope.principal);
    await unlockAccountVaultWithRecoveryCode(state.actor, scope, displayed);
    expect(await loadAccountRoot(state.actor, scope)).toEqual(root);
  });
  it("preserves the prepared code with an honest warning when an update cannot be reconciled", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    let displayed = "";
    state.actor.set_account_vault.mockImplementationOnce(async () => {
      state.actor.get_account_vault.mockRejectedValueOnce(new Error("still offline"));
      throw new Error("unknown outcome");
    });
    const operation = addRecoveryCodeBackup(state.actor, scope, (code) => { displayed = code; });
    await expect(operation).rejects.toBeInstanceOf(VaultBackupOutcomeUnknownError);
    await expect(operation).rejects.toThrow(/previous code may no longer work/i);
    expect(displayed).toMatch(/^IOU1-/);
    await operation.catch((error: Error) => expect(error.message).not.toContain(displayed));
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
  });
  it("does not retry or reconcile a definitive recovery-backup CAS refusal", async () => {
    const state = server(); await initializeAccountVault(state.actor, scope, root);
    state.actor.get_account_vault.mockClear();
    state.actor.set_account_vault.mockResolvedValueOnce({ Err: "revision conflict" });
    const display = vi.fn();
    await expect(addRecoveryCodeBackup(state.actor, scope, display)).rejects.toBeInstanceOf(VaultConflictError);
    expect(display).toHaveBeenCalledOnce();
    expect(state.actor.get_account_vault).toHaveBeenCalledOnce();
    expect(state.actor.set_account_vault).toHaveBeenCalledTimes(2);
  });
});
