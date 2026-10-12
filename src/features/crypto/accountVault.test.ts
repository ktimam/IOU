import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountRootFingerprint, accountVaultScopeId, createAccountVaultPayload, decodeAccountVault, encodeAccountVault, type AccountVaultScope } from "./accountVaultCrypto";

const disk = vi.hoisted(() => ({ records: new Map<string, Uint8Array>(), read: vi.fn(), write: vi.fn(), remove: vi.fn() }));
vi.mock("./accountVaultStorage", () => ({
  VaultStorageUnavailableError: class extends Error {},
  readVaultDeviceRoot: disk.read, writeVaultDeviceRoot: disk.write, deleteVaultDeviceRoots: disk.remove,
}));
import { addRecoveryCodeBackup, assertAccountVaultSessionGeneration, clearAccountVaultDevice, clearAccountVaultMemory, getAccountVaultSheetKeypair, initializeAccountVault, loadAccountRoot, loadUnpublishedAccountRoot, readAccountVaultSessionGeneration, registerAccountVaultCleanup, restoreAccountVaultWithRoot, unlockAccountVaultWithRecoveryCode, VaultBackupOutcomeUnknownError, VaultConflictError, VaultUnlockRequiredError, type AccountVaultActor } from "./accountVault";

const scope: AccountVaultScope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
const root = new Uint8Array(32).fill(31);
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
  } satisfies AccountVaultActor & { vetkd_wrap_consumer_key: ReturnType<typeof vi.fn> };
  return { actor, get record() { return record; }, set record(value) { record = value; } };
}
beforeEach(() => {
  clearAccountVaultMemory(); disk.records.clear(); vi.clearAllMocks();
  disk.read.mockImplementation(async (s: AccountVaultScope) => disk.records.get(accountVaultScopeId(s))?.slice() ?? null);
  disk.write.mockImplementation(async (s: AccountVaultScope, key: Uint8Array, _fp: string, current: () => boolean) => { if (!current()) throw new Error("Account session changed"); disk.records.set(accountVaultScopeId(s), key.slice()); });
  disk.remove.mockImplementation(async () => disk.records.clear());
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
