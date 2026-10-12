import { describe, expect, it, vi } from "vitest";
const vault = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../crypto/devVetkd", async (original) => ({ ...await original<typeof import("../crypto/devVetkd")>(), isProdVetkd: () => true }));
vi.mock("../crypto/vaultAccess", () => ({ requireAccountRoot: vault.read }));
import { encryptProfileName, persistEncryptedProfileName, synchronizeProfileName } from "./profileName";
describe("production profile uses the cached historical account root", () => {
  it("opens historical ciphertext without any paid derivation or rewriting the profile", async () => {
    const root = new Uint8Array(32).fill(39), copy = root.slice();
    const encrypted = await encryptProfileName("My existing name", root);
    vault.read.mockResolvedValueOnce(copy);
    const actor = {
      get_my_user: vi.fn(async () => [{ wrapped_display_name: encrypted.wrappedDisplayName, display_name_iv: encrypted.displayNameIv }]),
      set_display_name: vi.fn(), vetkd_public_key: vi.fn(), vetkd_wrap_consumer_key: vi.fn(),
    };
    expect(await synchronizeProfileName(actor, "alice", "")).toEqual({ use: "My existing name" });
    expect(actor.set_display_name).not.toHaveBeenCalled();
    expect(actor.vetkd_public_key).not.toHaveBeenCalled();
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
    expect(copy.every((byte) => byte === 0)).toBe(true);
    expect(root[0]).toBe(39);
  });
  it("a locked vault cannot silently recover or overwrite encrypted profile data", async () => {
    vault.read.mockRejectedValueOnce(new Error("Unlock account encryption"));
    const actor = { get_my_user: vi.fn(), get_account_vault: vi.fn(), set_display_name: vi.fn(), vetkd_wrap_consumer_key: vi.fn() };
    await expect(persistEncryptedProfileName(actor, "alice", "New name")).rejects.toThrow("Unlock");
    expect(actor.set_display_name).not.toHaveBeenCalled();
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
  });
});
