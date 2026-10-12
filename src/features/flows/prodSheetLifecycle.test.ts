import { beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { createSheetForPair } from "./createSheet";
import { decryptName } from "../crypto/devVetkd";
import { createRandomSheet, readVaultSheetKey, LegacySheetRecoveryRequiredError, migrateLegacySheetKey } from "../crypto/vaultSheets";
import { accountWrappingKeyId, openSheetKeyEnvelope, vaultB64 } from "../crypto/accountVaultCrypto";

const local = vi.hoisted(() => ({ keypairs: new Map<string, any>(), paid: vi.fn() }));
vi.mock("../crypto/accountVault", async (original) => ({
  ...await original<typeof import("../crypto/accountVault")>(),
  getAccountVaultSheetKeypair: async (_actor: unknown, scope: { principal: string }) => {
    if (!local.keypairs.has(scope.principal)) throw new Error("Account vault locked");
    return local.keypairs.get(scope.principal);
  },
  loadAccountVaultSheetKeypair: async (_actor: unknown, scope: { principal: string }) => {
    if (!local.keypairs.has(scope.principal)) throw new Error("Account vault locked");
    return local.keypairs.get(scope.principal);
  },
}));
vi.mock("../crypto/prodVetkd", async (original) => ({
  ...await original<typeof import("../crypto/prodVetkd")>(),
  prepareProdSheetKey: vi.fn(async () => ({})),
  deriveProdSheetKey: (...args: unknown[]) => local.paid(...args),
}));
const A = "aaaaa-aa", B = "rrkah-fqaaa-aaaaa-aaaaq-cai", ANON = "2vxsx-fae";
const principal = (text: string) => Principal.fromText(text);
const identity = { getPrincipal: () => principal(A) } as any;
const runtime = { isProdVetkd: () => true, createRandomSheet };
const opts = { pairId: "pair-one", closingDays: 60, name: "  August  " };
async function keypair() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const publicKeyB64 = vaultB64(publicBytes);
  return { ...kp, publicKeyB64, keyId: await accountWrappingKeyId(publicBytes) };
}
function server(shared = true) {
  const pair: any = { id: opts.pairId, members: [principal(A), principal(shared ? B : ANON)], active_sheet_id: [] };
  const sheets = new Map<string, any>();
  let viewer = A;
  const actor = {
    // Pair and PairSummary are different Candid types: only the summary has
    // active_sheet_id. Keep mocks faithful so lost-response recovery is real.
    get_pair: vi.fn(async () => [{ id: pair.id, members: pair.members }]),
    get_my_pairs: vi.fn(async () => [pair]),
    get_account_wrapping_key: vi.fn(async (p: Principal) => {
      const kp = local.keypairs.get(p.toText());
      return kp ? [{ key_id: kp.keyId, public_key: Array.from(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) }] : [];
    }),
    create_sheet_v2: vi.fn(async (req: any) => {
      const sheet = { ...req, id: "sheet-" + sheets.size, member_a: principal(A), member_b: principal(shared ? B : ANON) };
      sheets.set(sheet.id, sheet); pair.active_sheet_id = [sheet.id]; return { Ok: sheet };
    }),
    get_sheet_key_info: vi.fn(async (id: string) => ({ Ok: { scheme: sheets.get(id)?.scheme ?? "random-v2", key_id: sheets.get(id)?.key_id } })),
    get_sheet: vi.fn(async (id: string) => sheets.has(id) ? [sheets.get(id)] : []),
    get_sheet_wrapped_key: vi.fn(async (id: string) => [sheets.get(id)?.[viewer === A ? "wrapped_key_a" : "wrapped_key_b"]]),
    set_sheet_wrapped_key: vi.fn(async (id: string, _keyId: string, wrapped: number[]) => { sheets.get(id).wrapped_key_a = wrapped; return { Ok: null }; }),
    create_sheet: vi.fn(),
    vetkd_wrap_sheet_key: vi.fn(),
    vetkd_wrap_consumer_key: vi.fn(),
  };
  return { actor, pair, sheets, viewAs: (p: string) => { viewer = p; } };
}
beforeEach(async () => { local.keypairs.clear(); local.paid.mockReset(); local.keypairs.set(A, await keypair()); local.keypairs.set(B, await keypair()); });
describe("production sheets use locally generated, online-encrypted keys", () => {
  it("creates name and both member envelopes atomically without any VetKD call", async () => {
    const { actor, viewAs } = server();
    const result = await createSheetForPair(actor, identity, opts, runtime);
    expect(actor.create_sheet).not.toHaveBeenCalled();
    expect(actor.create_sheet_v2).toHaveBeenCalledOnce();
    const req = actor.create_sheet_v2.mock.calls[0][0];
    expect(req.name_enc[0].length).toBeGreaterThan(16);
    expect(await decryptName(result.K_sheet, new Uint8Array(req.name_iv[0]), new Uint8Array(req.name_enc[0]))).toBe("August");
    expect(await readVaultSheetKey(actor, A, result.sheet.id)).toEqual(result.K_sheet);
    viewAs(B);
    expect(await readVaultSheetKey(actor, B, result.sheet.id)).toEqual(result.K_sheet);
    expect(actor.vetkd_wrap_sheet_key).not.toHaveBeenCalled();
    expect(actor.vetkd_wrap_consumer_key).not.toHaveBeenCalled();
    expect(local.paid).not.toHaveBeenCalled();
  });
  it("uses independent fresh random sheet keys while retaining the same account wrapping key", async () => {
    const { actor } = server(false);
    const one = await createRandomSheet(actor, A, opts), two = await createRandomSheet(actor, A, { ...opts, name: "Next" });
    expect(one.K_sheet).not.toEqual(two.K_sheet);
    expect(one.sheet.key_id).not.toBe(two.sheet.key_id);
    expect(two.sheet.wrapped_key_b).toEqual([]);
    expect(local.paid).not.toHaveBeenCalled();
  });
  it("fails before creation if a real partner has not set up an account vault", async () => {
    const { actor } = server(); local.keypairs.delete(B);
    await expect(createRandomSheet(actor, A, opts)).rejects.toThrow(/partner.*setup/);
    expect(actor.create_sheet_v2).not.toHaveBeenCalled();
  });
  it("rejects a moved or corrupt envelope instead of paying or inventing a new key", async () => {
    const { actor, sheets } = server();
    const { sheet } = await createRandomSheet(actor, A, opts);
    const encoded = new TextDecoder().decode(new Uint8Array(sheet.wrapped_key_a));
    const kp = local.keypairs.get(A);
    await expect(openSheetKeyEnvelope(encoded, kp.privateKey, {
      version: 1, pairId: "another-pair", keyId: sheet.key_id, recipientPrincipal: A, recipientKeyId: kp.keyId,
    })).rejects.toThrow();
    sheets.get(sheet.id).wrapped_key_a = [1, 2, 3];
    await expect(readVaultSheetKey(actor, A, sheet.id)).rejects.toThrow(/missing or damaged/);
    expect(local.paid).not.toHaveBeenCalled();
  });
  it("reconciles a committed create whose response was lost, never issues another create", async () => {
    const { actor } = server(false);
    const create = actor.create_sheet_v2.getMockImplementation()!;
    actor.create_sheet_v2.mockImplementationOnce(async (req) => { await create(req); throw new Error("response lost"); });
    const result = await createRandomSheet(actor, A, opts);
    expect(result.sheet.id).toBe("sheet-0");
    expect(actor.create_sheet_v2).toHaveBeenCalledOnce();
    expect(await readVaultSheetKey(actor, A, result.sheet.id)).toEqual(result.K_sheet);
  });
  it("does not interpret an unrelated active sheet as a successful ambiguous create", async () => {
    const { actor, pair, sheets } = server(false);
    pair.active_sheet_id = ["old"]; sheets.set("old", { key_id: "unrelated" });
    actor.create_sheet_v2.mockRejectedValueOnce(new Error("network failure"));
    await expect(createRandomSheet(actor, A, opts)).rejects.toThrow("network failure");
    expect(actor.create_sheet_v2).toHaveBeenCalledOnce();
  });
  it("requires explicit legacy migration, preserves the old key, and never pays again once wrapped", async () => {
    const { actor, sheets } = server(false);
    const oldKey = new Uint8Array(32).fill(77);
    sheets.set("legacy", { id: "legacy", pair_id: opts.pairId, key_id: "legacy", scheme: "vetkd-v1", wrapped_key_a: [5] });
    await expect(readVaultSheetKey(actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(local.paid).not.toHaveBeenCalled();
    local.paid.mockImplementation(async () => oldKey.slice());
    await migrateLegacySheetKey(actor, A, "legacy");
    expect(local.paid).toHaveBeenCalledOnce();
    expect(await readVaultSheetKey(actor, A, "legacy")).toEqual(oldKey);
    await migrateLegacySheetKey(actor, A, "legacy");
    expect(local.paid).toHaveBeenCalledOnce();
  });
  it("never automatically retries an ambiguous legacy derivation", async () => {
    const { actor, sheets } = server(false);
    sheets.set("legacy", { id: "legacy", pair_id: opts.pairId, key_id: "legacy", scheme: "vetkd-v1", wrapped_key_a: [5] });
    local.paid.mockRejectedValue(new Error("unknown outcome"));
    await expect(migrateLegacySheetKey(actor, A, "legacy")).rejects.toThrow("unknown outcome");
    expect(local.paid).toHaveBeenCalledOnce();
    expect(actor.set_sheet_wrapped_key).not.toHaveBeenCalled();
  });
});
