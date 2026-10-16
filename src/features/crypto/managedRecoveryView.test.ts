import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vault = vi.hoisted(() => ({ descriptor: vi.fn(), prepare: vi.fn(), confirm: vi.fn() }));
vi.mock("./accountVault", () => ({ readManagedRecoveryDescriptor: vault.descriptor,
  prepareManagedRecovery: vault.prepare, confirmManagedRecovery: vault.confirm }));
import { loadManagedRecoveryView } from "./managedRecoveryView";

const actor = { acquire_account_root: vi.fn(), vetkd_wrap_consumer_key: vi.fn() } as any;
const scope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
const origin = "https://iou.example";
const candidate = { credentialId: "fixture-account", secret: "synthetic-entry-in-test-memory", verified: false };
const store = vi.fn(), get = vi.fn(), fetch = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vault.descriptor.mockResolvedValue(null); vault.prepare.mockResolvedValue(candidate);
  vi.stubGlobal("navigator", { credentials: { store, get } }); vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  expect(store).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(vault.confirm).not.toHaveBeenCalled();
  expect(actor.acquire_account_root).not.toHaveBeenCalled(); expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("automatic manager recovery view preparation", () => {
  it("prepares once automatically for an unlocked account missing recovery, without opening a provider", async () => {
    const preparing = vi.fn();
    expect(await loadManagedRecoveryView(actor, scope, origin, true, () => {}, preparing)).toEqual({
      descriptor: { credentialId: candidate.credentialId, verified: false }, prepared: candidate,
    });
    expect(vault.descriptor).toHaveBeenCalledExactlyOnceWith(actor, scope, origin);
    expect(vault.prepare).toHaveBeenCalledExactlyOnceWith(actor, scope, origin);
    expect(preparing).toHaveBeenCalledOnce();
  });
  it("reopens the retained unverified candidate on a later visit, without verifying or rotating it", async () => {
    vault.descriptor.mockResolvedValue({ credentialId: candidate.credentialId, verified: false });
    const first = await loadManagedRecoveryView(actor, scope, origin, true, () => {});
    const later = await loadManagedRecoveryView(actor, scope, origin, true, () => {});
    expect(later.prepared).toEqual(first.prepared);
    expect(vault.prepare).toHaveBeenCalledTimes(2);
  });
  it.each([null, { credentialId: candidate.credentialId, verified: false }, { credentialId: candidate.credentialId, verified: true }])(
    "a locked view never prepares even when its descriptor is %s", async (descriptor) => {
      vault.descriptor.mockResolvedValue(descriptor);
      expect(await loadManagedRecoveryView(actor, scope, origin, false, () => {})).toEqual({ descriptor });
      expect(vault.prepare).not.toHaveBeenCalled();
    });
  it("does not prepare or force a verified account to save again", async () => {
    const descriptor = { credentialId: candidate.credentialId, verified: true };
    vault.descriptor.mockResolvedValue(descriptor);
    expect(await loadManagedRecoveryView(actor, scope, origin, true, () => {})).toEqual({ descriptor });
    expect(vault.prepare).not.toHaveBeenCalled();
  });
  it("does not force resaving if another view verified during preparation", async () => {
    vault.prepare.mockResolvedValue({ ...candidate, verified: true });
    expect(await loadManagedRecoveryView(actor, scope, origin, true, () => {})).toEqual({
      descriptor: { credentialId: candidate.credentialId, verified: true },
    });
  });
  it("a cancelled StrictMode effect never prepares; the live replacement effect can prepare", async () => {
    let live = true;
    const current = () => { if (!live) throw new Error("Account session changed"); };
    const cancelled = loadManagedRecoveryView(actor, scope, origin, true, current);
    live = false;
    await expect(cancelled).rejects.toThrow(/session changed/);
    expect(vault.prepare).not.toHaveBeenCalled();
    expect((await loadManagedRecoveryView(actor, scope, origin, true, () => {})).prepared).toEqual(candidate);
    expect(vault.prepare).toHaveBeenCalledOnce();
  });
  it("discards a result after actor, account, origin or view lifetime changes", async () => {
    let live = true;
    vault.prepare.mockImplementationOnce(async () => { live = false; return candidate; });
    await expect(loadManagedRecoveryView(actor, scope, origin, true,
      () => { if (!live) throw new Error("Account session changed"); })).rejects.toThrow(/session changed/);
    expect(vault.prepare).toHaveBeenCalledOnce();
  });
  it("does not prepare when reading the descriptor fails, and never starts an automatic retry loop", async () => {
    vault.descriptor.mockRejectedValue(new Error("offline"));
    await expect(loadManagedRecoveryView(actor, scope, origin, true, () => {})).rejects.toThrow("offline");
    await Promise.resolve(); await Promise.resolve();
    expect(vault.descriptor).toHaveBeenCalledOnce(); expect(vault.prepare).not.toHaveBeenCalled();
  });
  it("keeps preparation failure for manual retry instead of automatically trying again", async () => {
    vault.prepare.mockRejectedValueOnce(new Error("unknown write result"));
    await expect(loadManagedRecoveryView(actor, scope, origin, true, () => {})).rejects.toThrow("unknown write result");
    await Promise.resolve(); await Promise.resolve();
    expect(vault.prepare).toHaveBeenCalledOnce();
    expect((await loadManagedRecoveryView(actor, scope, origin, true, () => {})).prepared).toEqual(candidate);
  });
  it("checks the scoped origin separately on each visit", async () => {
    vault.descriptor.mockImplementation(async (_actor, _scope, suppliedOrigin) => ({
      credentialId: candidate.credentialId, verified: suppliedOrigin === origin,
    }));
    await loadManagedRecoveryView(actor, scope, origin, true, () => {});
    expect(vault.prepare).not.toHaveBeenCalled();
    const otherOrigin = "https://iou.example:9443";
    await loadManagedRecoveryView(actor, scope, otherOrigin, true, () => {});
    expect(vault.prepare).toHaveBeenCalledExactlyOnceWith(actor, scope, otherOrigin);
  });
});
