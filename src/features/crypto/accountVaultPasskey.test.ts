import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollVaultPasskey, unlockVaultPasskey, unlockVaultPasskeys } from "./accountVaultPasskey";
import { vaultB64, vaultB64Url, type AccountVaultScope } from "./accountVaultCrypto";

const scope: AccountVaultScope = { principal: "alice", canisterId: "canister-a", host: "https://icp-api.io" };
const root = new Uint8Array(32).fill(8);
const secret = new Uint8Array(32).fill(41);
const id = new Uint8Array(32).fill(3);
const create = vi.fn();
const get = vi.fn();
function credential(results = true, enabled = true, credentialId = id, prfSecret = secret) {
  return { rawId: credentialId.slice().buffer, getClientExtensionResults: () => ({ prf: { enabled, ...(results ? { results: { first: prfSecret.slice().buffer } } : {}) } }), toJSON: vi.fn(() => { throw new Error("Secret PRF outputs must never be serialized"); }) };
}
async function twoBackups() {
  const first = await enrollVaultPasskey(root, scope);
  const otherId = new Uint8Array(32).fill(7);
  create.mockResolvedValue(credential(true, true, otherId));
  get.mockResolvedValue(credential(true, true, otherId));
  const second = await enrollVaultPasskey(root, scope);
  get.mockClear();
  return { first, second, otherId };
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
    expect(get).toHaveBeenCalledTimes(1);
    const confirmation = get.mock.calls[0][0].publicKey;
    expect(confirmation.rpId).toBe("iou.example");
    expect(confirmation.userVerification).toBe("required");
    expect(confirmation.allowCredentials).toEqual([{ type: "public-key", id: id.buffer }]);
    expect(confirmation.extensions.prf.eval.first).toEqual(create.mock.calls[0][0].publicKey.extensions.prf.eval.first);
    expect(confirmation.extensions.prf.evalByCredential).toBeUndefined();
    expect(await unlockVaultPasskey(backup, scope)).toEqual(root);
    expect(get).toHaveBeenCalledTimes(2);
    const unlock = get.mock.calls[1][0].publicKey;
    expect(unlock.allowCredentials).toEqual(confirmation.allowCredentials);
    expect(unlock.extensions.prf.eval).toEqual(confirmation.extensions.prf.eval);
    expect(unlock.extensions.prf.evalByCredential).toBeUndefined();
    expect(created.toJSON).not.toHaveBeenCalled();
    expect(root).toEqual(new Uint8Array(32).fill(8));
  });
  it("evaluates after creation when the provider reports PRF support without a result", async () => {
    create.mockResolvedValue(credential(false, true));
    await enrollVaultPasskey(root, scope);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0].publicKey.userVerification).toBe("required");
  });
  it("does not treat ordinary passkey support as PRF support", async () => {
    create.mockResolvedValue(credential(false, false));
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/did not confirm encryption support/);
    expect(get).not.toHaveBeenCalled();
    create.mockResolvedValue(credential(false, true)); get.mockResolvedValue(credential(false, true));
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/IOU-PASSKEY\/PRF-NO-RESULT/);
  });
  it("does not accept creation PRF output when a later assertion returns no PRF", async () => {
    const created = credential();
    const asserted = credential(false, true);
    create.mockResolvedValue(created); get.mockResolvedValue(asserted);
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/IOU-PASSKEY\/PRF-NO-RESULT/);
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(created.toJSON).not.toHaveBeenCalled();
    expect(asserted.toJSON).not.toHaveBeenCalled();
  });
  it("rejects different creation and subsequent assertion PRF secrets without publishing a backup", async () => {
    get.mockResolvedValue(credential(true, true, id, new Uint8Array(32).fill(42)));
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(root).toEqual(new Uint8Array(32).fill(8));
  });
  it("does not retry a denied assertion even when creation already returned PRF", async () => {
    const denied = new DOMException("User cancelled", "NotAllowedError");
    get.mockRejectedValueOnce(denied);
    await expect(enrollVaultPasskey(root, scope)).rejects.toBe(denied);
    expect(get).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
  it("rejects the wrong credential during enrollment confirmation", async () => {
    get.mockResolvedValue(credential(true, true, new Uint8Array(32).fill(9)));
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/wrong credential/);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([0, 31, 33])("rejects a %i-byte PRF result without saving a backup", async (length) => {
    const invalid = credential();
    invalid.getClientExtensionResults = () => ({ prf: { enabled: true, results: { first: new Uint8Array(length).buffer } } });
    create.mockResolvedValue(invalid);
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/Invalid passkey PRF result/);
    expect(get).not.toHaveBeenCalled();
    expect(invalid.toJSON).not.toHaveBeenCalled();
  });
  it("keeps browser cancellation intact and does not fall back after cancelled PRF evaluation", async () => {
    const denied = new DOMException("User cancelled", "NotAllowedError");
    create.mockRejectedValueOnce(denied);
    await expect(enrollVaultPasskey(root, scope)).rejects.toBe(denied);
    expect(get).not.toHaveBeenCalled();
    create.mockResolvedValueOnce(credential(false, true));
    get.mockResolvedValueOnce(null);
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow(/cancelled/);
    expect(create).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledOnce();
  });
  it("reports absent PRF without blaming a provider, retrying, or suggesting a recovery code", async () => {
    const backup = await enrollVaultPasskey(root, scope);
    get.mockClear();
    get.mockResolvedValueOnce(credential(false, true));
    await expect(unlockVaultPasskey(backup, scope)).rejects.toThrow("The selected passkey returned no encryption result (PRF) in this browser. Your account keys were not reset. [IOU-PASSKEY/PRF-NO-RESULT] [output=results-absent; attachment=unknown]");
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([
    { extensions: {}, attachment: "platform", shape: "prf-absent", reportedAttachment: "platform" },
    { extensions: { prf: {} }, attachment: "cross-platform", shape: "results-absent", reportedAttachment: "cross-platform" },
    { extensions: { prf: { results: {} } }, attachment: null, shape: "first-absent", reportedAttachment: "unknown" },
  ])("reports only the $shape structure from one extension inspection", async ({ extensions, attachment, shape, reportedAttachment }) => {
    const backup = await enrollVaultPasskey(root, scope);
    const inspect = vi.fn(() => extensions);
    const asserted = { ...credential(), authenticatorAttachment: attachment, getClientExtensionResults: inspect };
    get.mockClear(); get.mockResolvedValue(asserted);
    await expect(unlockVaultPasskey(backup, scope)).rejects.toThrow(`[IOU-PASSKEY/PRF-NO-RESULT] [output=${shape}; attachment=${reportedAttachment}]`);
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
    expect(asserted.toJSON).not.toHaveBeenCalled();
  });
  it("never exposes extension values or unrecognized attachment text in the diagnostic", async () => {
    const backup = await enrollVaultPasskey(root, scope);
    const sensitive = "DO-NOT-DISCLOSE-EXTENSION-DATA";
    const serialize = vi.fn(() => { throw new Error("Extension data must not be serialized"); });
    const inspect = vi.fn(() => ({ prf: { results: { second: secret.buffer }, privateValue: sensitive, toJSON: serialize }, unrelated: root.buffer, toJSON: serialize }));
    const asserted = { ...credential(), authenticatorAttachment: sensitive, getClientExtensionResults: inspect };
    get.mockClear(); get.mockResolvedValue(asserted);
    let message = "";
    try { await unlockVaultPasskey(backup, scope); }
    catch (error) { message = (error as Error).message; }
    expect(message).toBe("The selected passkey returned no encryption result (PRF) in this browser. Your account keys were not reset. [IOU-PASSKEY/PRF-NO-RESULT] [output=first-absent; attachment=unknown]");
    for (const value of [sensitive, backup.credentialId, backup.prfSalt, vaultB64(root), vaultB64(secret)]) expect(message).not.toContain(value);
    expect(serialize).not.toHaveBeenCalled();
    expect(asserted.toJSON).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("reads creation extension results once before rejecting missing support confirmation", async () => {
    const inspect = vi.fn(() => ({}));
    create.mockResolvedValue({ ...credential(), getClientExtensionResults: inspect });
    await expect(enrollVaultPasskey(root, scope)).rejects.toThrow("Passkey creation did not confirm encryption support (PRF) in this browser. No passkey backup was saved.");
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled();
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
    const { first, second, otherId } = await twoBackups();
    get.mockResolvedValue(credential(true, true, otherId));
    const foreign = { ...first, rpId: "old.example" };
    expect(await unlockVaultPasskeys([first, foreign, second], scope)).toEqual(root);
    expect(get).toHaveBeenCalledTimes(1);
    const options = get.mock.calls[0][0].publicKey;
    expect(options.allowCredentials).toHaveLength(2);
    expect(Object.keys(options.extensions.prf.evalByCredential)).toEqual([first.credentialId, second.credentialId]);
    expect(new Uint8Array(options.extensions.prf.evalByCredential[second.credentialId].first)).toHaveLength(32);
  });
  it("uses plain eval for the only eligible backup even when foreign-domain backups exist", async () => {
    const first = await enrollVaultPasskey(root, scope);
    get.mockClear();
    get.mockImplementation(async ({ publicKey }) => credential(Boolean(publicKey.extensions.prf.eval)));
    expect(await unlockVaultPasskeys([{ ...first, rpId: "old.example" }, first], scope)).toEqual(root);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][0].publicKey.extensions.prf.evalByCredential).toBeUndefined();
  });
  it.each(["DataView", "Uint32Array"])("accepts the exact PRF byte range from a %s without serializing it", async (kind) => {
    const backup = await enrollVaultPasskey(root, scope);
    const bytes = new Uint8Array(48).fill(7);
    bytes.set(secret, 8);
    const first = kind === "DataView" ? new DataView(bytes.buffer, 8, 32) : new Uint32Array(8).fill(0x29292929);
    const asserted = { ...credential(), getClientExtensionResults: () => ({ prf: { results: { first } } }) };
    get.mockResolvedValue(asserted); get.mockClear();
    expect(await unlockVaultPasskey(backup, scope)).toEqual(root);
    expect(get).toHaveBeenCalledTimes(1);
    expect(asserted.toJSON).not.toHaveBeenCalled();
  });
  it("evaluates only the selected credential once if a successful multi-credential assertion omitted PRF", async () => {
    const { first, second, otherId } = await twoBackups();
    get.mockResolvedValueOnce(credential(false, true, otherId));
    get.mockResolvedValueOnce(credential(true, true, otherId));
    expect(await unlockVaultPasskeys([first, second], scope)).toEqual(root);
    expect(get).toHaveBeenCalledTimes(2);
    const selection = get.mock.calls[0][0].publicKey;
    const evaluation = get.mock.calls[1][0].publicKey;
    expect(selection.allowCredentials).toHaveLength(2);
    expect(evaluation.allowCredentials).toEqual([{ type: "public-key", id: otherId.buffer }]);
    expect(evaluation.rpId).toBe("iou.example");
    expect(evaluation.userVerification).toBe("required");
    expect(evaluation.extensions.prf.eval.first).toEqual(selection.extensions.prf.evalByCredential[second.credentialId].first);
    expect(evaluation.extensions.prf.evalByCredential).toBeUndefined();
  });
  it("stops after one selected-credential evaluation if PRF is still absent", async () => {
    const { first, second, otherId } = await twoBackups();
    get.mockResolvedValue(credential(false, true, otherId));
    await expect(unlockVaultPasskeys([first, second], scope)).rejects.toThrow(/IOU-PASSKEY\/PRF-NO-RESULT/);
    expect(get).toHaveBeenCalledTimes(2);
  });
  it.each(["denied", "null", "wrong credential", "malformed PRF", "decryption failure"])("does not retry multi-credential %s", async (failure) => {
    const { first, second, otherId } = await twoBackups();
    if (failure === "denied") get.mockRejectedValueOnce(new DOMException("User cancelled", "NotAllowedError"));
    else if (failure === "null") get.mockResolvedValueOnce(null);
    else if (failure === "wrong credential") get.mockResolvedValueOnce(credential(true, true, new Uint8Array(32).fill(9)));
    else if (failure === "malformed PRF") get.mockResolvedValueOnce(credential(true, true, otherId, new Uint8Array(31)));
    else get.mockResolvedValueOnce(credential(true, true, otherId, new Uint8Array(32).fill(42)));
    await expect(unlockVaultPasskeys([first, second], scope)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each(["denied", "null", "wrong credential", "malformed PRF", "decryption failure"])("does not retry the selected-credential evaluation after %s", async (failure) => {
    const { first, second, otherId } = await twoBackups();
    get.mockResolvedValueOnce(credential(false, true, otherId));
    if (failure === "denied") get.mockRejectedValueOnce(new DOMException("User cancelled", "NotAllowedError"));
    else if (failure === "null") get.mockResolvedValueOnce(null);
    else if (failure === "wrong credential") get.mockResolvedValueOnce(credential(true, true, id));
    else if (failure === "malformed PRF") get.mockResolvedValueOnce(credential(true, true, otherId, new Uint8Array(31)));
    else get.mockResolvedValueOnce(credential(true, true, otherId, new Uint8Array(32).fill(42)));
    await expect(unlockVaultPasskeys([first, second], scope)).rejects.toThrow();
    expect(get).toHaveBeenCalledTimes(2);
  });
  it("validates single-backup salt and duplicate multi-backup IDs before a provider prompt", async () => {
    const backup = await enrollVaultPasskey(root, scope);
    get.mockClear();
    await expect(unlockVaultPasskey({ ...backup, prfSalt: vaultB64(new Uint8Array(31)) }, scope)).rejects.toThrow(/salt/);
    await expect(unlockVaultPasskeys([backup, backup], scope)).rejects.toThrow(/Duplicate passkey backup/);
    expect(get).not.toHaveBeenCalled();
  });
});
