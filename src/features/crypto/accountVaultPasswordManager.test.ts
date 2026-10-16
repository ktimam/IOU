import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managerRecoveryAvailable, readManagedRecoveryCredential, saveManagedRecoveryCredential } from "./accountVaultPasswordManager";
import { vaultB64Url } from "./accountVaultCrypto";

const id = "IOU encryption recovery:account-a";
const secret = "IOU1-" + vaultB64Url(new Uint8Array(32).fill(31));
const get = vi.fn();
const store = vi.fn();
const construct = vi.fn();
const serialize = vi.fn(() => { throw new Error("Do not serialize recovery credentials"); });
class PasswordCredentialFixture {
  readonly type = "password";
  readonly id: string;
  readonly password: string;
  readonly name: string;
  readonly toJSON = serialize;
  constructor(data: { id: string; password: string; name: string }) {
    construct(data);
    this.id = data.id; this.password = data.password; this.name = data.name;
    Object.freeze(this);
  }
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("PasswordCredential", PasswordCredentialFixture);
  vi.stubGlobal("navigator", { credentials: { get, store } });
  get.mockResolvedValue(new PasswordCredentialFixture({ id, password: secret, name: "IOU encryption recovery" }));
  store.mockImplementation(async (credential) => credential);
  construct.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe("ordinary password-manager recovery adapter", () => {
  it("only checks availability without accessing credentials", () => {
    expect(managerRecoveryAvailable()).toBe(true);
    expect(construct).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled();
  });
  it.each(["insecure", "missing navigator", "missing credentials", "missing get", "missing store", "missing constructor"])("fails closed when %s", async (missing) => {
    if (missing === "insecure") vi.stubGlobal("isSecureContext", false);
    if (missing === "missing navigator") vi.stubGlobal("navigator", undefined);
    if (missing === "missing credentials") vi.stubGlobal("navigator", {});
    if (missing === "missing get") vi.stubGlobal("navigator", { credentials: { store } });
    if (missing === "missing store") vi.stubGlobal("navigator", { credentials: { get } });
    if (missing === "missing constructor") vi.stubGlobal("PasswordCredential", undefined);
    expect(managerRecoveryAvailable()).toBe(false);
    await expect(saveManagedRecoveryCredential(id, secret)).rejects.toMatchObject({ code: "MANAGER_UNAVAILABLE" });
    await expect(readManagedRecoveryCredential(id)).rejects.toMatchObject({ code: "MANAGER_UNAVAILABLE" });
    expect(construct).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled();
  });
  it("stores only the exact supplied account and makes no verification or network request", async () => {
    const fetch = vi.fn(); const localStorage = { setItem: vi.fn() };
    vi.stubGlobal("fetch", fetch); vi.stubGlobal("localStorage", localStorage);
    await expect(saveManagedRecoveryCredential(id, secret)).resolves.toBeUndefined();
    expect(construct).toHaveBeenCalledExactlyOnceWith({ id, password: secret, name: "IOU encryption recovery" });
    expect(store).toHaveBeenCalledTimes(1);
    expect(store.mock.calls[0][0]).toBeInstanceOf(PasswordCredentialFixture);
    expect(get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(localStorage.setItem).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
  });
  it("does not treat store's return value as proof that the entry was saved", async () => {
    store.mockResolvedValue(null);
    await expect(saveManagedRecoveryCredential(id, secret)).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled(); expect(store).toHaveBeenCalledTimes(1);
  });
  it("retrieves an exact-account readonly credential with required mediation", async () => {
    expect(await readManagedRecoveryCredential(id)).toBe(secret);
    expect(get).toHaveBeenCalledExactlyOnceWith({ password: true, mediation: "required" });
    expect(store).not.toHaveBeenCalled(); expect(construct).not.toHaveBeenCalled(); expect(serialize).not.toHaveBeenCalled();
  });
  it("rejects wrong-account selection before accessing its secret", async () => {
    const password = vi.fn(() => { throw new Error("Wrong-account password must not be read"); });
    get.mockResolvedValue({ type: "password", id: "other-account", get password() { return password(); } });
    await expect(readManagedRecoveryCredential(id)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    expect(password).not.toHaveBeenCalled(); expect(get).toHaveBeenCalledTimes(1); expect(store).not.toHaveBeenCalled();
  });
  it.each(["public-key", "federated", undefined])("rejects a %s credential even with matching id", async (type) => {
    get.mockResolvedValue({ type, id, password: secret });
    await expect(readManagedRecoveryCredential(id)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each(["", " ", "a\n", "a".repeat(2049)])("rejects invalid account IDs before prompting", async (invalidId) => {
    await expect(saveManagedRecoveryCredential(invalidId, secret)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    await expect(readManagedRecoveryCredential(invalidId)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    expect(construct).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled();
  });
  const invalidSecrets = ["", "ordinary-password", secret + " ", " " + secret, secret + "=", "IOU1-" + "A".repeat(42), "IOU1-" + "A".repeat(44), "IOU1-" + "A".repeat(42) + "B", "a".repeat(129)];
  it.each(invalidSecrets)("rejects malformed secret %s before saving or after retrieving", async (invalidSecret) => {
    await expect(saveManagedRecoveryCredential(id, invalidSecret)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    expect(construct).not.toHaveBeenCalled(); expect(store).not.toHaveBeenCalled();
    get.mockResolvedValue({ type: "password", id, password: invalidSecret });
    await expect(readManagedRecoveryCredential(id)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 123, null, {}, new Uint8Array(32)])("rejects nonstring returned secrets", async (password) => {
    get.mockResolvedValue({ type: "password", id, password });
    await expect(readManagedRecoveryCredential(id)).rejects.toMatchObject({ code: "MANAGER_INVALID_CREDENTIAL" });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("rejects dismissed retrieval without retries or side effects", async () => {
    get.mockResolvedValue(null);
    await expect(readManagedRecoveryCredential(id)).rejects.toMatchObject({ code: "MANAGER_CANCELLED" });
    expect(get).toHaveBeenCalledTimes(1); expect(store).not.toHaveBeenCalled();
  });
  it.each(["NotAllowedError", "AbortError", "NotSupportedError", "SecurityError", "Error"])("sanitizes %s without leaking provider details or retrying", async (name) => {
    const error = new Error(secret + " " + id); error.name = name;
    const code = ["NotAllowedError", "AbortError"].includes(name) ? "MANAGER_CANCELLED" : ["NotSupportedError", "SecurityError"].includes(name) ? "MANAGER_UNAVAILABLE" : "MANAGER_FAILED";
    get.mockRejectedValue(error); store.mockRejectedValue(error);
    for (const operation of [() => readManagedRecoveryCredential(id), () => saveManagedRecoveryCredential(id, secret)]) {
      let failure: unknown;
      try { await operation(); } catch (caught) { failure = caught; }
      expect(failure).toMatchObject({ code });
      expect((failure as Error).message).not.toContain(secret); expect((failure as Error).message).not.toContain(id);
      expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    }
    expect(get).toHaveBeenCalledTimes(1); expect(store).toHaveBeenCalledTimes(1); expect(serialize).not.toHaveBeenCalled();
  });
  it("sanitizes a constructor failure before calling store", async () => {
    class FailingPasswordCredential { constructor() { throw new Error(secret); } }
    vi.stubGlobal("PasswordCredential", FailingPasswordCredential);
    await expect(saveManagedRecoveryCredential(id, secret)).rejects.toMatchObject({ code: "MANAGER_FAILED" });
    expect(store).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled();
  });
});
