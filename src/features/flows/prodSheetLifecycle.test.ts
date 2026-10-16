import { beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { createSheetForPair } from "./createSheet";
import { decryptName, encryptName, encryptEntryPayload } from "../crypto/devVetkd";
import { createRandomSheet, readVaultSheetKey, LegacySheetRecoveryRequiredError, LegacySheetBackupPendingError, migrateLegacySheetKey } from "../crypto/vaultSheets";
import { accountWrappingKeyId, openSheetKeyEnvelope, vaultB64 } from "../crypto/accountVaultCrypto";
import { clearAccountVaultMemory } from "../crypto/accountVault";

const local = vi.hoisted(() => ({ keypairs: new Map<string, any>(), paid: vi.fn(), legacy: vi.fn(), prepare: vi.fn() }));
vi.mock("../crypto/devVetkd", async (original) => ({
  ...await original<typeof import("../crypto/devVetkd")>(),
  loadExistingLegacySheetKey: (...args: unknown[]) => local.legacy(...args),
}));
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
  prepareProdSheetKey: (...args: unknown[]) => local.prepare(...args),
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
    list_entries: vi.fn(async (id: string) => ({ entries: sheets.get(id)?.entries ?? [], next_cursor: [] as bigint[] })),
    set_sheet_wrapped_key: vi.fn(async (id: string, _keyId: string, wrapped: number[]) => { sheets.get(id).wrapped_key_a = wrapped; return { Ok: null }; }),
    create_sheet: vi.fn(),
    vetkd_wrap_sheet_key: vi.fn(),
    vetkd_wrap_consumer_key: vi.fn(),
  };
  return { actor, pair, sheets, viewAs: (p: string) => { viewer = p; } };
}
beforeEach(async () => {
  clearAccountVaultMemory(); local.keypairs.clear(); local.paid.mockReset();
  local.legacy.mockReset().mockResolvedValue(null); local.prepare.mockReset().mockResolvedValue({});
  local.keypairs.set(A, await keypair()); local.keypairs.set(B, await keypair());
});
async function addLegacySheet(state: ReturnType<typeof server>, key: Uint8Array, id = "legacy") {
  const name = await encryptName(key, "Original older sheet");
  const sheet = { id, pair_id: opts.pairId, key_id: id, scheme: "vetkd-v1", wrapped_key_a: [5], name_enc: [name.enc], name_iv: [name.iv], entries: [] as any[] };
  state.sheets.set(id, sheet);
  return sheet;
}
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
    const state = server(false), { actor } = state;
    const oldKey = new Uint8Array(32).fill(77);
    await addLegacySheet(state, oldKey);
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
    const state = server(false), { actor } = state;
    await addLegacySheet(state, new Uint8Array(32).fill(77));
    local.paid.mockRejectedValue(new Error("unknown outcome"));
    await expect(migrateLegacySheetKey(actor, A, "legacy")).rejects.toThrow("unknown outcome");
    expect(local.paid).toHaveBeenCalledOnce();
    expect(actor.set_sheet_wrapped_key).not.toHaveBeenCalled();
  });
  it("automatically secures an authenticated live cached key without derivation or changing encrypted data", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77);
    const sheet = await addLegacySheet(state, oldKey), before = structuredClone(sheet);
    const result = await readVaultSheetKey(state.actor, A, "legacy", oldKey);
    expect(result).toEqual(oldKey); expect(result).not.toBe(oldKey);
    expect({ ...sheet, wrapped_key_a: before.wrapped_key_a }).toEqual(before);
    expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
    expect(await readVaultSheetKey(state.actor, A, "legacy")).toEqual(oldKey);
    expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
    expect(local.paid).not.toHaveBeenCalled(); expect(local.prepare).not.toHaveBeenCalled();
  });
  it("authenticates a cached key against an original entry when the sheet has no name", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(17);
    const sheet = await addLegacySheet(state, oldKey); sheet.name_enc = []; sheet.name_iv = [];
    const encrypted = await encryptEntryPayload(new TextEncoder().encode("original entry"), oldKey);
    sheet.entries.push({ entry_key: Array.from(encrypted.entryKey), iv: Array.from(encrypted.iv), ciphertext: Array.from(encrypted.ciphertext) });
    expect(await readVaultSheetKey(state.actor, A, "legacy", oldKey)).toEqual(oldKey);
    expect(state.actor.list_entries).toHaveBeenCalledWith("legacy", [], 100);
    expect(local.paid).not.toHaveBeenCalled();
  });
  it("does not overwrite a legacy slot using a wrong or unproven cached key", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77);
    const sheet = await addLegacySheet(state, oldKey);
    await expect(readVaultSheetKey(state.actor, A, "legacy", new Uint8Array(32).fill(44))).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    sheet.name_enc = []; sheet.name_iv = [];
    await expect(readVaultSheetKey(state.actor, A, "legacy", oldKey)).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled(); expect(sheet.wrapped_key_a).toEqual([5]);
    expect(local.paid).not.toHaveBeenCalled();
  });
  it("automatically backs up a successfully unwrapped original device key without VetKD", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77);
    await addLegacySheet(state, oldKey);
    const owned = oldKey.slice(); local.legacy.mockResolvedValueOnce(owned);
    expect(await readVaultSheetKey(state.actor, A, "legacy")).toEqual(oldKey);
    expect(local.legacy).toHaveBeenCalledWith(A, new Uint8Array([5]));
    expect(owned.every(byte => byte === 0)).toBe(true);
    expect(local.paid).not.toHaveBeenCalled(); expect(local.prepare).not.toHaveBeenCalled();
  });
  it("rejects historical placeholder wrapper/name key A and secures authoritative entry key B only after explicit recovery", async () => {
    const state = server(false), placeholder = new Uint8Array(32).fill(10), actual = new Uint8Array(32).fill(20);
    const sheet = await addLegacySheet(state, placeholder);
    const entry = await encryptEntryPayload(new TextEncoder().encode("actual original entry"), actual);
    sheet.entries.push({ entry_key: Array.from(entry.entryKey), iv: Array.from(entry.iv), ciphertext: Array.from(entry.ciphertext) });
    local.legacy.mockImplementation(async () => placeholder.slice());
    const before = structuredClone(sheet);
    await expect(readVaultSheetKey(state.actor, A, "legacy", placeholder)).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled(); expect(local.paid).not.toHaveBeenCalled();
    local.paid.mockImplementation(async () => actual.slice());
    await migrateLegacySheetKey(state.actor, A, "legacy");
    expect(await readVaultSheetKey(state.actor, A, "legacy")).toEqual(actual);
    expect({ ...sheet, wrapped_key_a: before.wrapped_key_a }).toEqual(before);
    expect(local.paid).toHaveBeenCalledOnce(); expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
    expect(await decryptName(actual, new Uint8Array(sheet.name_iv[0]), new Uint8Array(sheet.name_enc[0]))).toBe("");
  });
  it("fails closed when original entries use mixed keys even if the name matches", async () => {
    const state = server(false), first = new Uint8Array(32).fill(10), second = new Uint8Array(32).fill(20);
    const sheet = await addLegacySheet(state, first);
    for (const key of [first, second]) {
      const entry = await encryptEntryPayload(new TextEncoder().encode("entry"), key);
      sheet.entries.push({ entry_key: Array.from(entry.entryKey), iv: Array.from(entry.iv), ciphertext: Array.from(entry.ciphertext) });
    }
    local.legacy.mockImplementation(async () => first.slice());
    await expect(readVaultSheetKey(state.actor, A, "legacy", first)).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    local.paid.mockImplementation(async () => second.slice());
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toThrow(/could not decrypt/);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled(); expect(local.paid).toHaveBeenCalledOnce();
  });
  it("checks later entry pages and historical versions instead of trusting an earlier matching entry", async () => {
    const state = server(false), first = new Uint8Array(32).fill(10), second = new Uint8Array(32).fill(20);
    await addLegacySheet(state, first);
    const rows = [];
    for (const key of [first, second]) {
      const entry = await encryptEntryPayload(new TextEncoder().encode("entry"), key);
      rows.push({ entry_key: Array.from(entry.entryKey), iv: Array.from(entry.iv), ciphertext: Array.from(entry.ciphertext) });
    }
    state.actor.list_entries.mockResolvedValueOnce({ entries: [rows[0]], next_cursor: [1n] });
    state.actor.list_entries.mockResolvedValueOnce({ entries: [rows[1]], next_cursor: [] });
    await expect(readVaultSheetKey(state.actor, A, "legacy", first)).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(state.actor.list_entries).toHaveBeenCalledWith("legacy", [1n], 100);
    state.actor.list_entries.mockResolvedValueOnce({ entries: [{ ...rows[0], history: [[rows[1]]] }], next_cursor: [] });
    await expect(readVaultSheetKey(state.actor, A, "legacy", first)).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled(); expect(local.paid).not.toHaveBeenCalled();
  });
  it("uses a valid online envelope before any conflicting cached key", async () => {
    const state = server(false);
    const result = await createRandomSheet(state.actor, A, opts);
    expect(await readVaultSheetKey(state.actor, A, result.sheet.id, new Uint8Array(32).fill(1))).toEqual(result.K_sheet);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled(); expect(local.legacy).not.toHaveBeenCalled();
  });
  it.each(["iou-sheet-envelope-v1:broken", "iou-sheet-envelope-v2:unknown", "binary-modern"])("never overwrites a corrupt modern envelope (%s) or invokes paid fallback", async (format) => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77);
    const sheet = await addLegacySheet(state, oldKey);
    sheet.wrapped_key_a = format === "binary-modern" ? [...new TextEncoder().encode("iou-sheet-envelope-v1:"), 255] : Array.from(new TextEncoder().encode(format));
    await expect(readVaultSheetKey(state.actor, A, "legacy", oldKey)).rejects.toThrow();
    await expect(migrateLegacySheetKey(state.actor, A, "legacy", oldKey)).rejects.toThrow();
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled(); expect(local.paid).not.toHaveBeenCalled();
  });
  it("coalesces concurrent free migrations and returns independent owned copies", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    const [a, b] = await Promise.all([readVaultSheetKey(state.actor, A, "legacy", oldKey), readVaultSheetKey(state.actor, A, "legacy", oldKey)]);
    expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
    a.fill(0); expect(b).toEqual(oldKey); expect(oldKey.every(byte => byte === 77)).toBe(true);
    expect(local.paid).not.toHaveBeenCalled();
  });
  it("coalesces concurrent explicit migrations into one paid derivation", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice());
    await Promise.all([migrateLegacySheetKey(state.actor, A, "legacy"), migrateLegacySheetKey(state.actor, A, "legacy")]);
    expect(local.paid).toHaveBeenCalledOnce(); expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
  });
  it("shares an ambiguous paid failure with concurrent callers instead of automatically retrying it", async () => {
    const state = server(false); await addLegacySheet(state, new Uint8Array(32).fill(77));
    local.paid.mockRejectedValueOnce(new Error("paid outcome unknown"));
    const results = await Promise.allSettled([migrateLegacySheetKey(state.actor, A, "legacy"), migrateLegacySheetKey(state.actor, A, "legacy")]);
    expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
    expect(local.paid).toHaveBeenCalledOnce(); expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled();
  });
  it("rechecks free recovery immediately before a paid call", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.prepare.mockImplementationOnce(async () => { local.legacy.mockResolvedValueOnce(oldKey.slice()); return {}; });
    await migrateLegacySheetKey(state.actor, A, "legacy");
    expect(local.paid).not.toHaveBeenCalled(); expect(await readVaultSheetKey(state.actor, A, "legacy")).toEqual(oldKey);
  });
  it("reconciles a committed backup with a lost response without writing or paying again", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice());
    const set = state.actor.set_sheet_wrapped_key.getMockImplementation()!;
    state.actor.set_sheet_wrapped_key.mockImplementationOnce(async (...args) => { await set(...args); throw new Error("lost response"); });
    await migrateLegacySheetKey(state.actor, A, "legacy");
    await migrateLegacySheetKey(state.actor, A, "legacy");
    expect(local.paid).toHaveBeenCalledOnce(); expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
  });
  it("retains a validated recovered key for same-session backup retry without repaying", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice());
    state.actor.set_sheet_wrapped_key.mockRejectedValueOnce(new Error("offline"));
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetBackupPendingError);
    expect(await readVaultSheetKey(state.actor, A, "legacy")).toEqual(oldKey);
    expect(local.paid).toHaveBeenCalledOnce(); expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledTimes(2);
  });
  it("offers a free backup retry after a pre-write network failure", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementationOnce(async () => {
      state.actor.get_sheet.mockRejectedValueOnce(new Error("offline before backup"));
      return oldKey.slice();
    });
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetBackupPendingError);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled();
    await migrateLegacySheetKey(state.actor, A, "legacy");
    expect(local.paid).toHaveBeenCalledOnce(); expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce();
  });
  it("preserves a corrupt modern readback as an integrity error instead of offering overwrite", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); const sheet = await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice());
    state.actor.set_sheet_wrapped_key.mockImplementationOnce(async () => {
      sheet.wrapped_key_a = Array.from(new TextEncoder().encode("iou-sheet-envelope-v1:corrupt"));
      return { Ok: null };
    });
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toThrow(/damaged/);
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toThrow(/damaged/);
    expect(state.actor.set_sheet_wrapped_key).toHaveBeenCalledOnce(); expect(local.paid).toHaveBeenCalledOnce();
  });
  it("does not share a retained recovered key with another principal", async () => {
    const state = server(), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice()); state.actor.set_sheet_wrapped_key.mockRejectedValueOnce(new Error("offline"));
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetBackupPendingError);
    state.viewAs(B);
    await expect(readVaultSheetKey(state.actor, B, "legacy")).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(local.paid).toHaveBeenCalledOnce();
  });
  it("never treats an unverified or different backup as a successful migration", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice());
    state.actor.set_sheet_wrapped_key.mockResolvedValueOnce({ Ok: null });
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetBackupPendingError);
    expect(local.paid).toHaveBeenCalledOnce();
    await migrateLegacySheetKey(state.actor, A, "legacy");
    expect(local.paid).toHaveBeenCalledOnce();
  });
  it("does not pay without verifiable original ciphertext or persist a wrongly derived legacy key", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); const sheet = await addLegacySheet(state, oldKey);
    local.paid.mockResolvedValueOnce(new Uint8Array(32).fill(44));
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toThrow(/could not decrypt.*original content/);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled();
    sheet.name_enc = []; sheet.name_iv = [];
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toThrow(/no original encrypted content/);
    expect(local.paid).toHaveBeenCalledOnce();
  });
  it("wipes retained recovered keys on logout instead of restoring them into another session", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    local.paid.mockImplementation(async () => oldKey.slice()); state.actor.set_sheet_wrapped_key.mockRejectedValueOnce(new Error("offline"));
    await expect(migrateLegacySheetKey(state.actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetBackupPendingError);
    clearAccountVaultMemory();
    await expect(readVaultSheetKey(state.actor, A, "legacy")).rejects.toBeInstanceOf(LegacySheetRecoveryRequiredError);
    expect(local.paid).toHaveBeenCalledOnce();
  });
  it("does not write a late paid result after account switch", async () => {
    const state = server(false), oldKey = new Uint8Array(32).fill(77); await addLegacySheet(state, oldKey);
    let finish!: (key: Uint8Array) => void;
    local.paid.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = migrateLegacySheetKey(state.actor, A, "legacy");
    await vi.waitFor(() => expect(finish).toBeDefined());
    clearAccountVaultMemory(); const late = oldKey.slice(); finish(late);
    await expect(pending).rejects.toThrow(/session changed/);
    expect(late.every(byte => byte === 0)).toBe(true);
    expect(state.actor.set_sheet_wrapped_key).not.toHaveBeenCalled();
  });
});
