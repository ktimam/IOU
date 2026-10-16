import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ record: vi.fn(), root: vi.fn(), publish: vi.fn(), setup: vi.fn(), replacement: vi.fn(), generation: 0 }));
vi.mock("./accountVault", () => ({
  loadAccountVault: state.record, loadAccountRoot: state.root, getAccountVaultSheetKeypair: state.publish,
  readAccountVaultSessionGeneration: () => state.generation,
  assertAccountVaultSessionGeneration: (value: number) => { if (value !== state.generation) throw new Error("Account session changed"); },
  VaultUnlockRequiredError: class extends Error {},
  isAccountPasskeyEnrollmentRequired: state.replacement,
}));
vi.mock("./vaultAccess", () => ({ accountVaultScope: (principal: string) => ({ principal }), recoverAccountVaultPaid: state.setup }));
import { VaultUnlockRequiredError } from "./accountVault";
import { prepareVaultOnboarding } from "./vaultOnboarding";

const actor = {} as any;
const origin = "http://localhost:3000";
function record(rpIds: string[] = [], verifiedOrigins?: string[]) {
  return { revision: 1n, payload: { passkeys: rpIds.map((rpId) => ({ rpId })),
    ...(verifiedOrigins === undefined ? {} : { managedRecovery: { verifiedOrigins } }) } };
}
beforeEach(() => {
  vi.resetAllMocks(); state.generation = 0;
  state.record.mockResolvedValue(record());
  state.root.mockImplementation(async () => new Uint8Array(32).fill(9));
  state.setup.mockResolvedValue(undefined); state.publish.mockResolvedValue({});
  state.replacement.mockResolvedValue(false);
});

describe("automatic account setup and verified recovery gate", () => {
  it("initializes a confirmed new account automatically, but stays gated for recovery", async () => {
    state.record.mockResolvedValueOnce(null);
    const started = vi.fn();
    expect(await prepareVaultOnboarding(actor, "alice", origin, true, () => true, started)).toBe("recovery");
    expect(started).toHaveBeenCalledOnce();
    expect(state.setup).toHaveBeenCalledExactlyOnceWith(actor, "alice", false);
  });
  it("requires manager setup for a remembered PRF-only account without paid recovery or changing its backup", async () => {
    const legacy = record(["localhost"]);
    const before = JSON.stringify(legacy.payload);
    state.record.mockResolvedValue(legacy);
    for (let i = 0; i < 2; i++) expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("recovery");
    expect(state.setup).not.toHaveBeenCalled();
    expect(JSON.stringify(legacy.payload)).toBe(before);
  });
  it("requires enrollment for existing remembered accounts with no recovery, even after reload", async () => {
    for (let i = 0; i < 2; i++) expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("recovery");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("does not treat a passkey from another domain as an enrollment on this domain", async () => {
    state.record.mockResolvedValue(record(["other.example"]));
    expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("recovery");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("requires replacement enrollment after paid emergency recovery even with an old saved passkey", async () => {
    state.record.mockResolvedValue(record(["localhost"])); state.replacement.mockResolvedValue(true);
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("recovery");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("never purchases recovery for an existing account with missing local keys", async () => {
    state.root.mockRejectedValue(new VaultUnlockRequiredError());
    expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("unlock");
    expect(state.setup).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
  });
  it("fails closed on unavailable storage without purchasing recovery", async () => {
    state.root.mockRejectedValue(new Error("IndexedDB unavailable"));
    await expect(prepareVaultOnboarding(actor, "alice", origin, true)).rejects.toThrow("IndexedDB");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("does not initialize when the initial vault query fails", async () => {
    state.record.mockRejectedValue(new Error("Network unavailable"));
    await expect(prepareVaultOnboarding(actor, "alice", origin, true)).rejects.toThrow("Network");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("does not automatically retry a failed setup in the same mounted gate", async () => {
    state.record.mockResolvedValue(null);
    state.setup.mockRejectedValue(new Error("Unknown setup outcome"));
    await expect(prepareVaultOnboarding(actor, "alice", origin, true)).rejects.toThrow("Unknown");
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("setup");
    expect(state.setup).toHaveBeenCalledOnce();
  });
  it("will not enter the app on an unconfirmed initialization reply", async () => {
    state.record.mockResolvedValue(null);
    await expect(prepareVaultOnboarding(actor, "alice", origin, true)).rejects.toThrow("could not be confirmed");
    expect(state.setup).toHaveBeenCalledOnce();
  });
  it("checks the final persisted manager backup, not a stale pre-operation verification", async () => {
    state.record.mockResolvedValueOnce(record([], [origin])).mockResolvedValueOnce(record());
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("recovery");
  });
  it("reconciles a committed verified manager backup without a new paid request", async () => {
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("recovery");
    state.record.mockResolvedValue(record(["localhost"], [origin]));
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("ready");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("wipes its transient root copy", async () => {
    const root = new Uint8Array(32).fill(9); state.root.mockResolvedValue(root);
    await prepareVaultOnboarding(actor, "alice", origin, true);
    expect(root.every((byte) => byte === 0)).toBe(true);
  });
  it("does not initialize a cancelled StrictMode effect; the live effect can initialize", async () => {
    state.record.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const started = vi.fn();
    await expect(prepareVaultOnboarding(actor, "alice", origin, true, () => false, started)).rejects.toThrow("session changed");
    expect(started).not.toHaveBeenCalled(); expect(state.setup).not.toHaveBeenCalled();
    expect(await prepareVaultOnboarding(actor, "alice", origin, true, () => true, started)).toBe("recovery");
    expect(state.setup).toHaveBeenCalledOnce();
  });
  it("stops before paid setup if the account session changes during a query", async () => {
    state.record.mockImplementationOnce(async () => { state.generation++; return null; });
    await expect(prepareVaultOnboarding(actor, "alice", origin, true)).rejects.toThrow("session changed");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("allows a remembered account with manager recovery verified for this exact origin", async () => {
    state.record.mockResolvedValue(record([], [origin]));
    expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("ready");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it.each(["https://other.example", "http://localhost:3001", "https://localhost:3000"])("does not accept manager recovery verified at %s", async (verifiedOrigin) => {
    state.record.mockResolvedValue(record(["localhost"], [verifiedOrigin]));
    expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("recovery");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("keeps an unconfirmed manager candidate gated across reloads", async () => {
    state.record.mockResolvedValue(record(["localhost"], []));
    for (let i = 0; i < 2; i++) expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("recovery");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it("preserves sticky replacement requirements despite both old confirmed backup methods", async () => {
    state.record.mockResolvedValue(record(["localhost"], [origin]));
    state.replacement.mockResolvedValue(true);
    expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("recovery");
    expect(state.replacement).toHaveBeenCalledOnce(); expect(state.setup).not.toHaveBeenCalled();
  });
  it("requires unlocking local keys even when manager recovery is verified", async () => {
    state.record.mockResolvedValue(record([], [origin]));
    state.root.mockRejectedValue(new VaultUnlockRequiredError());
    expect(await prepareVaultOnboarding(actor, "alice", origin, true)).toBe("unlock");
    expect(state.setup).not.toHaveBeenCalled(); expect(state.publish).not.toHaveBeenCalled();
  });
  it("checks persisted manager verification after publishing rather than a stale initial record", async () => {
    state.record.mockResolvedValueOnce(record([], [origin])).mockResolvedValueOnce(record([], []));
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("recovery");
    state.record.mockResolvedValue(record([], [origin]));
    expect(await prepareVaultOnboarding(actor, "alice", origin, false)).toBe("ready");
    expect(state.setup).not.toHaveBeenCalled();
  });
  it.each(["localhost", "https://iou.example/", "https://iou.example/path", "https://iou.example#fragment", "http://iou.example", "https://user:password@iou.example"])("rejects noncanonical or insecure origin %s before queries or setup", async (invalidOrigin) => {
    await expect(prepareVaultOnboarding(actor, "alice", invalidOrigin, true)).rejects.toThrow(/origin/);
    expect(state.record).not.toHaveBeenCalled(); expect(state.root).not.toHaveBeenCalled();
    expect(state.publish).not.toHaveBeenCalled(); expect(state.setup).not.toHaveBeenCalled();
  });
});
