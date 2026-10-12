import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ info: vi.fn(), wrap: vi.fn() }));
vi.mock("../crypto/devVetkd", async (original) => ({ ...await original<typeof import("../crypto/devVetkd")>(), isProdVetkd: () => true }));
vi.mock("../crypto/vaultSheets", () => ({ sheetKeyInfo: mocks.info, wrapSheetKeyForMember: mocks.wrap }));
import { grantPartnerAccess } from "./grantPartnerAccess";
import { clearAccountVaultMemory } from "../crypto/accountVault";
beforeEach(() => { vi.clearAllMocks(); mocks.info.mockResolvedValue({ scheme: "random-v2", key_id: "key" }); mocks.wrap.mockResolvedValue([1, 2, 3]); });
function setup() {
  const actor = { grant_partner_access: vi.fn(async () => 1n), vetkd_wrap_key: vi.fn() };
  const key = new Uint8Array(32).fill(18);
  const options = { actor, identity: { getPrincipal: () => ({ toText: () => "alice" }) }, pairId: "pair", partnerPrincipalText: "aaaaa-aa", activeSheetId: "sheet", getKSheet: vi.fn(async () => key) };
  return { actor, key, options };
}
describe("production partner access grant", () => {
  it("wraps the existing key with canonical sheet metadata and never sends an empty slot", async () => {
    const { actor, key, options } = setup();
    expect(await grantPartnerAccess(options)).toBe(1);
    expect(mocks.wrap).toHaveBeenCalledWith(actor, key, "pair", "key", "aaaaa-aa");
    expect(actor.grant_partner_access).toHaveBeenCalledWith("pair", expect.anything(), [{ sheet_id: "sheet", wrapped_key_for_partner: [1, 2, 3] }]);
    expect(actor.vetkd_wrap_key).not.toHaveBeenCalled();
    expect(key[0]).toBe(18); // caller's cache is not mutated
  });
  it("does not grant membership if the recipient has not published a wrapping key", async () => {
    const { actor, options } = setup(); mocks.wrap.mockRejectedValue(new Error("finish account encryption setup"));
    await expect(grantPartnerAccess(options)).rejects.toThrow(/setup/);
    expect(actor.grant_partner_access).not.toHaveBeenCalled();
  });
  it("propagates legacy migration requirements without a paid fallback", async () => {
    const { actor, options } = setup(); mocks.info.mockResolvedValue({ scheme: "vetkd-v1", key_id: "sheet" });
    options.getKSheet.mockRejectedValue(new Error("explicit legacy migration required"));
    await expect(grantPartnerAccess(options)).rejects.toThrow(/migration/);
    expect(actor.grant_partner_access).not.toHaveBeenCalled(); expect(actor.vetkd_wrap_key).not.toHaveBeenCalled();
  });
  it("rejects stale asynchronous work after logout", async () => {
    const { actor, options } = setup(); mocks.wrap.mockImplementation(async () => { clearAccountVaultMemory(); return [1, 2]; });
    await expect(grantPartnerAccess(options)).rejects.toThrow(/session changed/);
    expect(actor.grant_partner_access).not.toHaveBeenCalled();
  });
});
