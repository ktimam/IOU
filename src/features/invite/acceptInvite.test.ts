import { describe, expect, it, vi } from "vitest";
import { acceptInviteForSheet } from "./acceptInvite";
import { deriveUserKeypair, newSheetKey, recoverSheetKey, wrapSheetKey } from "../crypto/devVetkd";
import { b64uEncode } from "../flows/inviteLink";

const local = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage ??= {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => { local.set(key, value); },
  removeItem: (key: string) => { local.delete(key); }, clear: () => local.clear(),
  key: (index: number) => [...local.keys()][index] ?? null, get length() { return local.size; },
};
describe("acceptInviteForSheet", () => {
  it("routes production through the encrypted invitation without development keys or VetKD", async () => {
    const actor = { accept_invite: vi.fn(), vetkd_wrap_key: vi.fn() };
    const key = newSheetKey();
    const acceptVaultInvite = vi.fn(async () => ({ K_sheet: key }));
    const dev = vi.fn(async () => { throw new Error("dev keys forbidden"); });
    const invite = { code: "invite", sheetId: "sheet-1", inviteSecretB64u: b64uEncode(newSheetKey()) };
    expect(await acceptInviteForSheet(actor, "alice", invite, { isProdVetkd: () => true, acceptVaultInvite, deriveUserKeypair: dev, wrapSheetKey })).toEqual({ K_sheet: key });
    expect(acceptVaultInvite).toHaveBeenCalledWith(actor, "alice", invite, expect.any(Function));
    expect(dev).not.toHaveBeenCalled();
    expect(actor.vetkd_wrap_key).not.toHaveBeenCalled();
  });
  it("does not hide encrypted-invitation failures as successful membership", async () => {
    const actor = { accept_invite: vi.fn() };
    const acceptVaultInvite = vi.fn(async () => { throw new Error("damaged envelope"); });
    await expect(acceptInviteForSheet(actor, "alice", { code: "c", sheetId: "s" }, { isProdVetkd: () => true, acceptVaultInvite, deriveUserKeypair, wrapSheetKey })).rejects.toThrow("damaged envelope");
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });
  it("keeps the development self-wrap flow unchanged", async () => {
    const principal = "dev-partner"; const key = newSheetKey();
    const actor = { accept_invite: vi.fn(async () => undefined) };
    const acceptVaultInvite = vi.fn(async () => { throw new Error("production path forbidden"); });
    const result = await acceptInviteForSheet(actor, principal, { code: "dev", sheetId: "sheet", keyB64u: b64uEncode(key) }, { isProdVetkd: () => false, acceptVaultInvite, deriveUserKeypair, wrapSheetKey });
    expect(result.K_sheet).toEqual(key);
    const args = actor.accept_invite.mock.calls[0] as unknown as [string, { wrapped_key_for_partner: number[] }[], number[]];
    const pair = await deriveUserKeypair(principal);
    expect(await recoverSheetKey(new Uint8Array(args[1][0].wrapped_key_for_partner), pair)).toEqual(key);
    expect(new TextDecoder().decode(new Uint8Array(args[2]))).toBe(pair.publicKeyB64);
    expect(acceptVaultInvite).not.toHaveBeenCalled();
  });
  it("rejects malformed development invitations before consuming them", async () => {
    const actor = { accept_invite: vi.fn() };
    await expect(acceptInviteForSheet(actor, "dev", { code: "c", sheetId: "s" }, { isProdVetkd: () => false, acceptVaultInvite: vi.fn(), deriveUserKeypair, wrapSheetKey })).rejects.toThrow(/missing the sheet key/);
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });
});
