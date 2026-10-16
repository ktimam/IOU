import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  generation: 0, cleanups: [] as (() => void)[],
  load: vi.fn(), unpublished: vi.fn(), initialize: vi.fn(), restore: vi.fn(), derive: vi.fn(), transports: [] as Uint8Array[],
  pendingRead: vi.fn(), pendingWrite: vi.fn(), pendingDelete: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("../auth/config", () => ({ canisterId: "local-canister", host: "http://localhost:4943" }));
vi.mock("./accountVault", () => ({
  loadAccountRoot: state.load, loadUnpublishedAccountRoot: state.unpublished,
  initializeAccountVault: state.initialize, restoreAccountVaultWithRoot: state.restore,
  readAccountVaultSessionGeneration: () => state.generation,
  assertAccountVaultSessionGeneration: (generation: number) => { if (generation !== state.generation) throw new Error("Account session changed"); },
  registerAccountVaultCleanup: (cleanup: () => void) => { state.cleanups.push(cleanup); },
  VaultUnlockRequiredError: class extends Error {},
}));
vi.mock("./prodVetkd", () => ({
  deriveConsumerWrapKeyProd: state.derive,
  validateVetkdMasterPublicKey: state.validate,
  restorePendingTransportKey: (secretKey: Uint8Array, publicKey: Uint8Array) => ({ secretKey: secretKey.slice(), publicKey: publicKey.slice() }),
  newTransportKey: () => {
    const secretKey = new Uint8Array(32).fill(13); state.transports.push(secretKey);
    return { secretKey, publicKey: new Uint8Array(48).fill(14) };
  },
}));
vi.mock("./accountVaultStorage", () => ({
  readPendingAccountRootRequest: state.pendingRead,
  writePendingAccountRootRequest: state.pendingWrite,
  deletePendingAccountRootRequest: state.pendingDelete,
}));
import { recoverAccountVaultPaid, requireAccountRoot } from "./vaultAccess";
function logout() { state.generation++; state.cleanups.forEach((fn) => fn()); }
function actor(record: unknown[] = []) {
  return {
    get_account_vault: vi.fn(async () => record),
    vetkd_public_key: vi.fn(async () => new Uint8Array(96)),
    acquire_account_root: vi.fn(async (_id: string, _key: number[], _emergency: boolean) => ({ Ok: [1, 2] })),
  };
}
beforeEach(() => {
  logout(); vi.clearAllMocks(); state.transports.length = 0;
  state.load.mockResolvedValue(null); state.unpublished.mockResolvedValue(null);
  state.initialize.mockResolvedValue({}); state.restore.mockResolvedValue(undefined);
  state.pendingRead.mockResolvedValue(null); state.pendingWrite.mockResolvedValue(undefined); state.pendingDelete.mockResolvedValue(undefined);
  state.validate.mockReset();
  state.derive.mockImplementation(async () => new Uint8Array(32).fill(21));
});
describe("explicit paid account root acquisition", () => {
  it("never pays when ordinary encrypted data asks for a missing root", async () => {
    const api = actor();
    await expect(requireAccountRoot(api, "alice")).rejects.toThrow(/Set up/);
    expect(api.acquire_account_root).not.toHaveBeenCalled();
  });
  it("reuses a remembered root without dispatching VetKD", async () => {
    const root = new Uint8Array(32).fill(21); state.load.mockResolvedValue(root);
    const api = actor([{ revision: 1n }]);
    await recoverAccountVaultPaid(api, "alice", true);
    expect(api.acquire_account_root).not.toHaveBeenCalled();
    expect(state.restore).toHaveBeenCalledWith(api, expect.objectContaining({ principal: "alice" }), root, true);
    expect(root.every((byte) => byte === 0)).toBe(true);
  });
  it("resumes unpublished protected storage without a second bootstrap fee", async () => {
    const root = new Uint8Array(32).fill(21); state.unpublished.mockResolvedValue(root);
    const api = actor();
    await recoverAccountVaultPaid(api, "alice", false);
    expect(state.initialize).toHaveBeenCalledOnce();
    expect(api.acquire_account_root).not.toHaveBeenCalled();
    expect(root.every((byte) => byte === 0)).toBe(true);
  });
  it("uses one timestamped id and transport for concurrent setup and explicit retry after a lost response", async () => {
    const api = actor();
    api.acquire_account_root.mockRejectedValueOnce(new Error("unknown network outcome"));
    const results = await Promise.allSettled([recoverAccountVaultPaid(api, "alice", false), recoverAccountVaultPaid(api, "alice", false)]);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(api.acquire_account_root).toHaveBeenCalledOnce();
    await recoverAccountVaultPaid(api, "alice", false);
    const [first, second] = api.acquire_account_root.mock.calls;
    expect(first[0]).toMatch(/^\d{13}_[0-9a-f-]{36}$/);
    expect(second).toEqual(first);
    expect(state.transports).toHaveLength(1);
    expect(state.transports[0].every((byte) => byte === 0)).toBe(true);
  });
  it("will not bootstrap over an existing locked account", async () => {
    const api = actor([{ revision: 1n }]);
    await expect(recoverAccountVaultPaid(api, "alice", false)).rejects.toThrow(/already exists/);
    expect(api.acquire_account_root).not.toHaveBeenCalled();
  });
  it("explicit emergency recovery restores the existing vault, never creates new private keys", async () => {
    const api = actor([{ revision: 1n }]);
    await recoverAccountVaultPaid(api, "alice", true);
    expect(api.acquire_account_root.mock.calls[0][2]).toBe(true);
    expect(state.restore).toHaveBeenCalledOnce();
    expect(state.initialize).not.toHaveBeenCalled();
  });
  it("a sign-out during a paid call wipes its transport and prevents late persistence", async () => {
    const api = actor();
    let finish!: (value: { Ok: number[] }) => void;
    api.acquire_account_root.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = recoverAccountVaultPaid(api, "alice", false);
    await vi.waitFor(() => expect(finish).toBeDefined());
    logout(); finish({ Ok: [1, 2] });
    await expect(pending).rejects.toThrow(/session changed/);
    expect(state.initialize).not.toHaveBeenCalled();
    expect(state.restore).not.toHaveBeenCalled();
    expect(state.transports[0].every((byte) => byte === 0)).toBe(true);
  });
  it("does not pay if protected browser storage cannot be inspected", async () => {
    const api = actor(); state.unpublished.mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(recoverAccountVaultPaid(api, "alice", false)).rejects.toThrow("IndexedDB");
    expect(api.acquire_account_root).not.toHaveBeenCalled();
  });
  it("does not dispatch if a pending transport cannot be saved durably", async () => {
    const api = actor(); state.pendingWrite.mockRejectedValueOnce(new Error("storage write failed"));
    await expect(recoverAccountVaultPaid(api, "alice", false)).rejects.toThrow("storage write failed");
    expect(api.acquire_account_root).not.toHaveBeenCalled();
    expect(state.transports[0].every((byte) => byte === 0)).toBe(true);
  });
  it("validates the threshold public key before spending any derivation fee", async () => {
    const api = actor(); state.validate.mockImplementationOnce(() => { throw new Error("invalid vetKD master public key"); });
    await expect(recoverAccountVaultPaid(api, "alice", false)).rejects.toThrow(/master public key/);
    expect(api.acquire_account_root).not.toHaveBeenCalled();
  });
  it("replays a protected request after a reload with the same transport and ID", async () => {
    const api = actor();
    const saved = { id: "1720000000000_00000000-0000-4000-8000-000000000001", secretKey: new Uint8Array(32).fill(5), publicKey: new Uint8Array(48).fill(6) };
    state.pendingRead.mockResolvedValueOnce(saved);
    await recoverAccountVaultPaid(api, "alice", false);
    expect(api.acquire_account_root).toHaveBeenCalledWith(saved.id, Array.from(saved.publicKey), false);
    expect(state.transports).toHaveLength(0);
    expect(saved.secretKey.every((byte) => byte === 0)).toBe(true);
    expect(state.pendingDelete).toHaveBeenCalledOnce();
  });
  it("retains the protected transport if root persistence fails after a successful paid call", async () => {
    const api = actor(); state.initialize.mockRejectedValueOnce(new Error("root save failed"));
    await expect(recoverAccountVaultPaid(api, "alice", false)).rejects.toThrow("root save failed");
    expect(api.acquire_account_root).toHaveBeenCalledOnce();
    expect(state.pendingDelete).not.toHaveBeenCalled();
  });
  it.each([
    "emergency root recovery is limited to once per 24 hours",
    "paid key derivation budget exhausted; retry later",
  ])("clears only the definitively unadmitted request on %s without automatically retrying", async (message) => {
    const api = actor([{ revision: 1n }]);
    api.acquire_account_root.mockImplementationOnce(async () => ({ Err: message }) as any);
    await expect(recoverAccountVaultPaid(api, "alice", true)).rejects.toThrow(message);
    expect(api.acquire_account_root).toHaveBeenCalledOnce();
    expect(state.pendingDelete).toHaveBeenCalledWith(expect.anything(), true, api.acquire_account_root.mock.calls[0][0]);
    expect(state.transports[0].every((byte) => byte === 0)).toBe(true);
    await recoverAccountVaultPaid(api, "alice", true);
    expect(api.acquire_account_root.mock.calls[1][0]).not.toBe(api.acquire_account_root.mock.calls[0][0]);
    expect(state.transports).toHaveLength(2);
  });
  it.each([
    "root request pending or outcome unknown; no second derivation dispatched",
    "root request outcome unknown; this request will never dispatch again",
    "account root result is uncertain and may already have been paid; this request will not dispatch again",
    "account root derivation failed; this request will not dispatch again",
    "root request timestamp is stale, reused, or in the future",
  ])("preserves the existing protected request on %s", async (message) => {
    const api = actor([{ revision: 1n }]);
    api.acquire_account_root.mockImplementationOnce(async () => ({ Err: message }) as any);
    await expect(recoverAccountVaultPaid(api, "alice", true)).rejects.toThrow(message);
    expect(state.pendingDelete).not.toHaveBeenCalled();
    await recoverAccountVaultPaid(api, "alice", true);
    expect(api.acquire_account_root.mock.calls[1]).toEqual(api.acquire_account_root.mock.calls[0]);
    expect(state.transports).toHaveLength(1);
  });
});
