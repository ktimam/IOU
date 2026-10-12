import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountVaultPayload, openAccountVaultKeypair, vaultB64, type AccountVaultScope } from "./accountVaultCrypto";
const mocked = vi.hoisted(() => ({ keypair: vi.fn(), info: vi.fn() }));
vi.mock("./accountVault", async (original) => ({ ...await original<typeof import("./accountVault")>(), getAccountVaultSheetKeypair: mocked.keypair }));
vi.mock("./vaultSheets", async (original) => ({ ...await original<typeof import("./vaultSheets")>(), sheetKeyInfo: mocked.info }));
vi.mock("../auth/config", () => ({ host: "https://icp-api.io", canisterId: "canister-a" }));
import { acceptVaultInvite, createVaultInvite, openVaultInvite, sealVaultInvite, type VaultInviteContext } from "./vaultInvites";
import { clearAccountVaultMemory, openSheetKeyEnvelope } from "./accountVault";

const context: VaultInviteContext = { host: "https://icp-api.io", canisterId: "canister-a", pairId: "pair", keyId: "key", sheetId: "sheet", code: "code" };
const scope: AccountVaultScope = { principal: "alice", host: context.host, canisterId: context.canisterId };
const key = new Uint8Array(32).fill(29);
async function recipient() {
  const root = new Uint8Array(32).fill(3);
  const pair = await openAccountVaultKeypair(await createAccountVaultPayload(root, scope), root, scope);
  mocked.keypair.mockResolvedValue(pair); return pair;
}
beforeEach(() => { vi.clearAllMocks(); clearAccountVaultMemory(); mocked.info.mockResolvedValue({ scheme: "random-v2", key_id: "key" }); });
describe("production encrypted invitations", () => {
  it("roundtrips only with its independent secret and exact deployment/sheet/code context", async () => {
    const sealed = await sealVaultInvite(key, context);
    expect(sealed.inviteSecretB64u).toHaveLength(43);
    expect(new TextDecoder().decode(new Uint8Array(sealed.envelope))).not.toContain(vaultB64(key));
    expect(await openVaultInvite(sealed.envelope, sealed.inviteSecretB64u, context)).toEqual(key);
    for (const field of ["host", "canisterId", "pairId", "keyId", "sheetId", "code"] as const) {
      await expect(openVaultInvite(sealed.envelope, sealed.inviteSecretB64u, { ...context, [field]: "other" })).rejects.toThrow();
    }
    const another = await sealVaultInvite(key, context);
    await expect(openVaultInvite(sealed.envelope, another.inviteSecretB64u, context)).rejects.toThrow();
    const corrupt = JSON.parse(new TextDecoder().decode(new Uint8Array(sealed.envelope)));
    corrupt.ciphertext = vaultB64(new Uint8Array(48));
    await expect(openVaultInvite(new TextEncoder().encode(JSON.stringify(corrupt)), sealed.inviteSecretB64u, context)).rejects.toThrow();
  });
  it("publishes only ciphertext and context; the secret is returned solely for the link fragment", async () => {
    const actor = { get_sheet: vi.fn(async () => [{ pair_id: "pair" }]), issue_invite: vi.fn(async () => "code"), set_sheet_invite_envelope: vi.fn(async () => ({ Ok: null })), vetkd_wrap_key: vi.fn() };
    const invite = await createVaultInvite(actor, "alice", "sheet", key);
    const args = actor.set_sheet_invite_envelope.mock.calls[0] as unknown as [string, string, number[]];
    expect(args.slice(0, 2)).toEqual(["code", "sheet"]);
    expect(JSON.stringify(args)).not.toContain(invite.inviteSecretB64u);
    expect(await openVaultInvite(args[2], invite.inviteSecretB64u!, context)).toEqual(key);
    expect(invite.keyB64u).toBeUndefined();
    expect(actor.vetkd_wrap_key).not.toHaveBeenCalled();
  });
  it("decrypts before accepting and stores a nonempty recipient-bound self-wrap", async () => {
    const pair = await recipient(); const sealed = await sealVaultInvite(key, context);
    const actor = { get_sheet_invite_envelope: vi.fn(async () => ({ Ok: { pair_id: "pair", key_id: "key", envelope: sealed.envelope } })), accept_invite: vi.fn(async () => undefined), vetkd_wrap_key: vi.fn(), get_sheet_key_info: vi.fn() };
    const result = await acceptVaultInvite(actor, "alice", { code: "code", sheetId: "sheet", inviteSecretB64u: sealed.inviteSecretB64u });
    expect(result.K_sheet).toEqual(key);
    const args = actor.accept_invite.mock.calls[0] as unknown as [string, { wrapped_key_for_partner: number[] }[], number[]];
    const wrapped = new TextDecoder().decode(new Uint8Array(args[1][0].wrapped_key_for_partner));
    expect(await openSheetKeyEnvelope(wrapped, pair.privateKey, { version: 1, pairId: "pair", keyId: "key", recipientPrincipal: "alice", recipientKeyId: pair.keyId })).toEqual(key);
    expect(args[2]).toHaveLength(65);
    expect(actor.vetkd_wrap_key).not.toHaveBeenCalled();
    expect(actor.get_sheet_key_info).not.toHaveBeenCalled();
  });
  it("rejects legacy/raw-key links and corrupted envelopes before consuming the invite", async () => {
    await recipient(); const sealed = await sealVaultInvite(key, context);
    const actor = { get_sheet_invite_envelope: vi.fn(async () => ({ Ok: { pair_id: "other", key_id: "key", envelope: sealed.envelope } })), accept_invite: vi.fn() };
    await expect(acceptVaultInvite(actor, "alice", { code: "code", sheetId: "sheet" })).rejects.toThrow(/older invite/);
    await expect(acceptVaultInvite(actor, "alice", { code: "code", sheetId: "sheet", keyB64u: "raw", inviteSecretB64u: sealed.inviteSecretB64u })).rejects.toThrow(/older invite/);
    expect(mocked.keypair).not.toHaveBeenCalled();
    await expect(acceptVaultInvite(actor, "alice", { code: "code", sheetId: "sheet", inviteSecretB64u: sealed.inviteSecretB64u })).rejects.toThrow(/context/);
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });
  it("does not accept using stale work after logout during envelope retrieval", async () => {
    await recipient(); const sealed = await sealVaultInvite(key, context);
    const actor = { get_sheet_invite_envelope: vi.fn(async () => { clearAccountVaultMemory(); return { Ok: { pair_id: "pair", key_id: "key", envelope: sealed.envelope } }; }), accept_invite: vi.fn() };
    await expect(acceptVaultInvite(actor, "alice", { code: "code", sheetId: "sheet", inviteSecretB64u: sealed.inviteSecretB64u })).rejects.toThrow(/session changed/);
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });
  it("honors the page's unmount guard before committing membership", async () => {
    await recipient(); const sealed = await sealVaultInvite(key, context); let mounted = true;
    const actor = { get_sheet_invite_envelope: vi.fn(async () => { mounted = false; return { Ok: { pair_id: "pair", key_id: "key", envelope: sealed.envelope } }; }), accept_invite: vi.fn() };
    await expect(acceptVaultInvite(actor, "alice", { code: "code", sheetId: "sheet", inviteSecretB64u: sealed.inviteSecretB64u }, () => { if (!mounted) throw new Error("unmounted"); })).rejects.toThrow(/unmounted/);
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });
});
