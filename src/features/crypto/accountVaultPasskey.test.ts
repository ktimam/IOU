import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollVaultPasskey, unlockVaultPasskey, unlockVaultPasskeys } from "./accountVaultPasskey";
import { vaultB64, vaultB64Url, type AccountVaultScope } from "./accountVaultCrypto";

const scope: AccountVaultScope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
const root = new Uint8Array(32).fill(8);
const secret = new Uint8Array(32).fill(41);
const id = new Uint8Array(32).fill(3);
const create = vi.fn();
const get = vi.fn();
function credential(results = true, enabled = true, credentialId = id) {
  return { rawId: credentialId.slice().buffer, getClientExtensionResults: () => ({ prf: { enabled, ...(results ? { results: { first: secret.slice().buffer } } : {}) } }), toJSON: vi.fn(() => { throw new Error("Secret PRF outputs must never be serialized"); }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("location", { hostname: "iou.example" });
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("navigator", { credentials: { create, get } });
  create.mockResolvedValue(credential()); get.mockResolvedValue(credential());
});
afterEach(() => vi.unstubAllGlobals());
describe("IOU-owned passkey encrypted backup", () => {
  it("uses a separate IOU RP and roundtrips without serializing PRF output", async () => {
    const created = credential(); create.mockResolvedValue(created);
    const backup = await enrollVaultPasskey(root, scope);
    expect(backup.credentialId).toBe(vaultB64Url(id));
    expect(backup.rpId).toBe("iou.example");
    expect(JSON.stringify(backup)).not.toContain(vaultB64(secret));
    expect(JSON.stringify(backup)).not.toContain(vaultB64(root));
    expect(create.mock.calls[0][0].publicKey.rp.id).toBe("iou.example");
    expect(create.mock.calls[0][0].publicKey.authenticatorSelection.userVerification).toBe("required");
    expect(await unlockVaultPasskey(backup, scope)).toEqual(root);
    expect(created.toJSON).not.toHaveBeenCalled();
  });
  it("evaluates after creation when the provider reports PRF support without a result", async () => {
    create.mockResolvedValue(credential(false, true));
    await enrollVaultPasskey(root, scope);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0].publicKey.userVerification).toBe("required");
  });
  it("does not treat ordinary passkey support as PRF support", async () => {
    create.mockResolvedValue(credential(false, false));
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/does not support encryption/);
    expect(get).not.toHaveBeenCalled();
    create.mockResolvedValue(credential(false, true)); get.mockResolvedValue(credential(false, true));
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/does not support encryption/);
  });
  it("rejects the wrong credential, origin and account context", async () => {
    const backup = await enrollVaultPasskey(root, scope);
    get.mockResolvedValue(credential(true, true, new Uint8Array(32).fill(5)));
    await expect(unlockVaultPasskey(backup, scope)).rejects.toThrow(/wrong credential/);
    get.mockResolvedValue(credential());
    await expect(unlockVaultPasskey(backup, { ...scope, principal: "bob" })).rejects.toThrow();
    get.mockClear(); vi.stubGlobal("location", { hostname: "other.example" });
    await expect(unlockVaultPasskey(backup, scope)).rejects.toThrow(/different IOU domain/);
    expect(get).not.toHaveBeenCalled();
  });
  it("fails closed when cancelled or not in a secure browser context", async () => {
    create.mockResolvedValue(null);
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/cancelled/);
    vi.stubGlobal("isSecureContext", false);
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/secure browser/);
  });
  it("offers all current-domain backups in one prompt and selects the returned credential", async () => {
    const first = await enrollVaultPasskey(root, scope);
    const otherId = new Uint8Array(32).fill(7);
    create.mockResolvedValue(credential(true, true, otherId));
    const second = await enrollVaultPasskey(root, scope);
    get.mockResolvedValue(credential(true, true, otherId));
    const foreign = { ...first, rpId: "old.example" };
    expect(await unlockVaultPasskeys([first, foreign, second], scope)).toEqual(root);
    expect(get).toHaveBeenCalledTimes(1);
    const options = get.mock.calls[0][0].publicKey;
    expect(options.allowCredentials).toHaveLength(2);
    expect(Object.keys(options.extensions.prf.evalByCredential)).toEqual([first.credentialId, second.credentialId]);
    expect(new Uint8Array(options.extensions.prf.evalByCredential[second.credentialId].first)).toHaveLength(32);
  });
});
