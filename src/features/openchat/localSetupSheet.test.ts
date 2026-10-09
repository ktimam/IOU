import { describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { IDL } from "@dfinity/candid";
import { idlFactory } from "../../backend/declarations";
import { encryptName, encryptWithSheetKey } from "../crypto/devVetkd";
import { encodePairSlot } from "../templates/pairTemplates";
import { loadLocalSetupSheet } from "./localSetupSheet";

const owner = Principal.selfAuthenticating(new Uint8Array([1, 2, 3]));
const other = Principal.selfAuthenticating(new Uint8Array([4, 5, 6]));
const sheetId = "0000000000000001", pairId = "0000000000000002";
const service = idlFactory({ IDL }) as IDL.ServiceClass;
function wireResult<T>(method: "get_sheet" | "get_pair" | "get_my_pairs", value: T): T {
  const resultTypes = service._fields.find(([name]) => name === method)![1].retTypes;
  return IDL.decode(resultTypes, IDL.encode(resultTypes, [value]))[0] as T;
}
async function fixture() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const template = { id: "private-type", name: "Custom choice", direction: "debt" as const, txn_type: "iou" as const,
    keywords: ["custom-keyword"], fee_percent: 12, rev: 1, updatedAt: 1 };
  const sealed = await encryptWithSheetKey(key, encodePairSlot([template], []));
  const accountName = await encryptName(key, "Chosen account"), sheetName = await encryptName(key, "Chosen sheet");
  const pair = { id: pairId, members: [owner, other], invite_code: "test", created_at: 1n, archived_at: [] as bigint[],
    member_a_name_enc: [], member_a_name_iv: [], member_b_name_enc: [], member_b_name_iv: [],
    templates_a_enc: [sealed.ciphertext], templates_a_iv: [sealed.iv], templates_b_enc: [] as Uint8Array[], templates_b_iv: [] as Uint8Array[],
    name_enc: [accountName.enc], name_iv: [accountName.iv] };
  const sheet = { id: sheetId, pair_id: pairId, state: { Active: null }, member_a: owner, member_b: other,
    closing_window_days: 1, last_entry_at: [], wrapped_key_a: new Uint8Array(), wrapped_key_b: new Uint8Array(), created_at: 1n,
    closed_at: [], closing_balances_key: [], closing_balances_enc: [], closing_balances_iv: [],
    name_enc: [sheetName.enc], name_iv: [sheetName.iv] };
  const summary = { id: pairId, other_principal: other, active_sheet_id: [sheetId], archived_sheet_count: 0, created_at: 1n,
    archived_at: [] as bigint[], name_enc: [accountName.enc], name_iv: [accountName.iv], other_name_enc: [], other_name_iv: [] };
  const summaries = [summary];
  const actor = { get_sheet: vi.fn(async () => wireResult("get_sheet", [sheet])), get_pair: vi.fn(async () => wireResult("get_pair", [pair])),
    get_my_pairs: vi.fn(async () => wireResult("get_my_pairs", summaries)), set_chat_sheet_link: vi.fn(), set_pair_templates: vi.fn() };
  return { actor, pair, sheet, summary, summaries, key, options: { actor, principal: owner.toText(), sheetId, defaultCurrency: "EGP",
    unwrapFor: vi.fn(async () => key), assertCurrent: vi.fn() } };
}
describe("read-only private chat sheet setup snapshot", () => {
  it("decrypts both Type slots and names using the existing key without exporting private keys or fee configuration", async () => {
    const f = await fixture(), result = await loadLocalSetupSheet(f.options);
    expect(wireResult("get_pair", [f.pair])[0]).not.toHaveProperty("active_sheet_id");
    expect(f.actor.get_my_pairs).toHaveBeenCalledExactlyOnceWith();
    expect(result).toMatchObject({ sheetId, pairId, label: "Chosen account — Chosen sheet", processorContext: { defaultCurrency: "EGP",
      types: [{ id: "private-type", name: "Custom choice", direction: "debt", txn_type: "iou", keywords: ["custom-keyword"] }] } });
    expect(JSON.stringify(result)).not.toContain("fee_percent");
    expect(f.options.unwrapFor).toHaveBeenCalledExactlyOnceWith(sheetId);
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(f.actor.set_pair_templates).not.toHaveBeenCalled();
  });
  it.each(["sheet-member", "pair-member", "sheet-rotation", "no-active-sheet", "archived", "summary-archived", "summary-missing", "summary-duplicate", "summary-other-pair"])("rejects unavailable %s before key recovery", async reason => {
    const f = await fixture();
    if (reason === "sheet-member") f.sheet.member_a = other;
    if (reason === "pair-member") f.pair.members = [other, other];
    if (reason === "sheet-rotation") f.summary.active_sheet_id = ["0000000000000003"];
    if (reason === "no-active-sheet") f.summary.active_sheet_id = [];
    if (reason === "archived") f.pair.archived_at = [1n];
    if (reason === "summary-archived") f.summary.archived_at = [1n];
    if (reason === "summary-missing") f.summaries.splice(0);
    if (reason === "summary-duplicate") f.summaries.push({ ...f.summary });
    if (reason === "summary-other-pair") f.summary.id = "0000000000000003";
    await expect(loadLocalSetupSheet(f.options)).rejects.toThrow(/sheet|account/i);
    expect(f.options.unwrapFor).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("rechecks the current summary on every preview/share instead of retaining the picker snapshot", async () => {
    const f = await fixture();
    await expect(loadLocalSetupSheet(f.options)).resolves.toMatchObject({ sheetId });
    f.summary.active_sheet_id = ["0000000000000003"];
    await expect(loadLocalSetupSheet(f.options)).rejects.toThrow("active sheet changed");
    expect(f.actor.get_my_pairs).toHaveBeenCalledTimes(2);
    expect(f.options.unwrapFor).toHaveBeenCalledTimes(1);
  });
  it.each(["wrong-key", "unreadable-partner"])("does not silently share partial Type vocabulary on %s", async reason => {
    const f = await fixture();
    if (reason === "wrong-key") f.options.unwrapFor.mockResolvedValue(new Uint8Array(32));
    else f.pair.templates_b_enc = [new Uint8Array([1, 2])];
    await expect(loadLocalSetupSheet(f.options)).rejects.toThrow("Types could not be read");
  });
  it("stops on a session change after the sheet read without reading account metadata or a key", async () => {
    const f = await fixture(); let current = true;
    f.actor.get_sheet.mockImplementationOnce(async () => { current = false; return [f.sheet]; });
    await expect(loadLocalSetupSheet({ ...f.options, assertCurrent: () => { if (!current) throw new Error("session changed"); } })).rejects.toThrow("session changed");
    expect(f.actor.get_pair).not.toHaveBeenCalled(); expect(f.options.unwrapFor).not.toHaveBeenCalled();
  });
  it("stops on a session change after the fresh summary read without recovering a key", async () => {
    const f = await fixture(); let current = true;
    f.actor.get_my_pairs.mockImplementationOnce(async () => { current = false; return wireResult("get_my_pairs", f.summaries); });
    await expect(loadLocalSetupSheet({ ...f.options, assertCurrent: () => { if (!current) throw new Error("session changed"); } })).rejects.toThrow("session changed");
    expect(f.options.unwrapFor).not.toHaveBeenCalled();
  });
});
