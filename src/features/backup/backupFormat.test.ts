import { describe, expect, it } from "vitest";
import { Principal } from "@dfinity/principal";
import { computeBalances, orientPayload } from "../entries/balance";
import type { EntryPayload } from "../entries/types";
import {
  buildSheetBackup, parseSheetBackup, planSheetImport, serializeSheetBackup,
  SHEET_BACKUP_LIMITS, SHEET_BACKUP_WARNING, type SheetBackup, type SheetBackupInput,
} from "./backupFormat";

const exporter = Principal.selfAuthenticating(new Uint8Array([1, 2, 3])).toText();
const partner = Principal.selfAuthenticating(new Uint8Array([4, 5, 6])).toText();
const now = Date.parse("2026-10-08T09:31:22.456Z");
const ns = "1791451882456123456";

function payload(): EntryPayload {
  return {
    ts: Date.parse("2026-08-14T21:47:13.789Z"), kind: "expense", currency: "EUR",
    amount_minor: 7_200, direction: "credit", note: "ملاحظة | Aug 14–21, exact source note",
    txn_type: "iou", schedule: [
      { due_ts: Date.parse("2026-08-19T13:20:01.234Z"), percent: 25 },
      { due_ts: Date.parse("2026-09-06T02:03:04.567Z"), percent: 75 },
    ],
    fee: { gross_amount_minor: 10_000, percent: 20, fixed_minor: 800 },
    convert: { from_currency: "USD", from_amount_minor: 12_000, to_currency: "EUR",
      to_amount_minor: 10_000, rate: 0.8333333333333334, rate_source: "manual", rate_fetched_at: now },
    draft_id: "old-draft", import_message_id: "old-chat-handle",
  };
}
function input(): SheetBackupInput {
  return {
    exportedAt: now,
    source: { backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai", accountId: "account_1", sheetId: "sheet_1", exporterPrincipal: exporter },
    accountName: "Shared account", sheetName: "Summer ledger",
    metadata: { state: "active", closingWindowDays: 365, createdAtNs: ns, closedAtNs: null,
      accountArchivedAtNs: null, lastEntryAtNs: ns, closingBalances: null },
    types: [{ id: "old-type", name: "Travel", direction: "debt", txn_type: "iou", currency: "EUR",
      amount_minor: 12_900, fee_percent: 5, fee_fixed_minor: 50, fee_fixed_currency: "USD",
      schedule: [{ offset_days: 7, percent: 20 }, { offset_days: 0, anchor: "start_of_next_month", percent: 80 }],
      note: "custom default", keywords: ["stay", "journey"] }],
    entries: [
      { id: "18446744073709551615", authorPrincipal: exporter, createdAtNs: ns, updatedAtNs: ns,
        deletedAtNs: null, payload: payload(), history: [{ replacedAtNs: ns, payload: { ...payload(), note: "original revision" } }] },
      { id: "2", authorPrincipal: partner, createdAtNs: ns, updatedAtNs: null,
        deletedAtNs: null, payload: { ts: now, kind: "payment", currency: "USD", amount_minor: 1_234,
          direction: "debt", note: "partner paid", txn_type: "settlement" }, history: [] },
      { id: "3", authorPrincipal: exporter, createdAtNs: ns, updatedAtNs: null,
        deletedAtNs: ns, payload: { ...payload(), note: "deleted but archived" }, history: [] },
    ],
  };
}
function backup(): SheetBackup { return buildSheetBackup(input()); }
function changed(mutator: (value: any) => void): string {
  const value = JSON.parse(serializeSheetBackup(backup())); mutator(value); return JSON.stringify(value);
}

describe("unencrypted sheet backup format", () => {
  it("round-trips all current values, full timestamps, Types, deleted rows and history", () => {
    const value = backup();
    expect(parseSheetBackup(serializeSheetBackup(value))).toEqual(value);
    expect(value.entries[0].createdAtNs).toBe(ns);
    expect(value.entries[0].payload).toEqual(payload());
    expect(value.entries[0].history[0].payload.note).toBe("original revision");
    expect(value.entries[2].deletedAtNs).toBe(ns);
    expect(value.types).toEqual(input().types);
    expect(value.protection).toBe("unencrypted");
    expect(SHEET_BACKUP_WARNING).toMatch(/anyone with this file/i);
  });

  it("retains closed/archived sheet and closing-balance metadata without importing that state", () => {
    const source = input();
    source.metadata = { ...source.metadata, state: "closed", closedAtNs: ns, accountArchivedAtNs: ns,
      closingBalances: [{ currency: "USD", amount_minor: -1234 }] };
    const value = buildSheetBackup(source);
    expect(parseSheetBackup(serializeSheetBackup(value)).metadata).toEqual(source.metadata);
    const plan = planSheetImport(value);
    expect(plan).not.toHaveProperty("metadata");
    expect(plan.limitations.join(" ")).toMatch(/archival state and closing balances are not recreated/);
  });

  it("plans current records only, flips other-author directions and preserves balance/value semantics", () => {
    const original = backup();
    const before = structuredClone(original);
    const plan = planSheetImport(original);
    expect(plan.summary).toEqual({ currentEntries: 2, deletedEntries: 1, historyVersions: 1, types: 1 });
    expect(plan.entries.map(row => row.sourceAuthor)).toEqual(["exporter", "other"]);
    expect(plan.entries.map(row => row.payload.direction)).toEqual(["credit", "credit"]);
    const viewed = original.entries.filter(row => row.deletedAtNs === null)
      .map(row => orientPayload(row.payload, row.authorPrincipal === original.source.exporterPrincipal));
    expect(computeBalances(plan.entries.map(row => row.payload))).toEqual(computeBalances(viewed));
    expect(plan.entries[0].payload).toMatchObject({ ts: payload().ts, note: payload().note,
      fee: payload().fee, schedule: payload().schedule, convert: payload().convert });
    expect(original).toEqual(before);
  });

  it("uses stable content-scoped new draft/Type IDs and does not carry chat dedupe or author attestations", () => {
    const value = backup();
    const plan = planSheetImport(value);
    expect(planSheetImport(parseSheetBackup(serializeSheetBackup(value)))).toEqual(plan);
    expect(plan.backupId).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.entries[0].payload.draft_id).toBe(`backup:${plan.backupId}:${value.entries[0].id}`);
    expect(plan.entries[0].payload).not.toHaveProperty("import_message_id");
    expect(plan.entries[0]).not.toHaveProperty("authorPrincipal");
    expect(plan.entries[0]).not.toHaveProperty("createdAtNs");
    expect(plan.types[0]).toEqual({ ...value.types[0], id: plan.typeIdMap[0].targetId });
    expect(plan.types[0].id).not.toBe(value.types[0].id);
    expect(plan.types[0].id.length).toBeLessThanOrEqual(128);
    expect(plan.typeIdMap[0].sourceId).toBe(value.types[0].id);
    const altered = parseSheetBackup(changed(row => { row.entries[0].payload.note = "edited file"; }));
    expect(planSheetImport(altered).backupId).not.toBe(plan.backupId);
    expect(plan.limitations.join(" ")).toMatch(/unverified archive metadata/);
  });

  it("fingerprints object-key ordering consistently", () => {
    const value = backup();
    const reordered = Object.fromEntries(Object.entries(value).reverse());
    expect(planSheetImport(parseSheetBackup(JSON.stringify(reordered))).backupId).toBe(planSheetImport(value).backupId);
  });

  it("preserves foreign fixed-fee values and flips their complete entry perspective", () => {
    const source = input();
    source.entries[0].authorPrincipal = partner;
    source.entries[0].payload.fee = { gross_amount_minor: 9_000, percent: 20, fixed_minor: 321, fixed_currency: "USD" };
    expect(planSheetImport(buildSheetBackup(source)).entries[0].payload).toMatchObject({
      direction: "debt", amount_minor: 7_200, fee: source.entries[0].payload.fee,
    });
  });

  it.each([
    ["unsupported version", (v: any) => { v.version = 2; }],
    ["unsupported format", (v: any) => { v.format = "arbitrary"; }],
    ["false encryption claim", (v: any) => { v.protection = "encrypted"; }],
    ["credentials", (v: any) => { v.credentials = "secret"; }],
    ["key in source", (v: any) => { v.source.privateKey = "secret"; }],
    ["key in record", (v: any) => { v.entries[0].entry_key = [1, 2]; }],
    ["key in payload", (v: any) => { v.entries[0].payload.key = "secret"; }],
    ["unknown nested field", (v: any) => { v.entries[0].payload.fee.token = "secret"; }],
    ["unknown history field", (v: any) => { v.entries[0].history[0].signature = "false proof"; }],
    ["invalid principal", (v: any) => { v.source.exporterPrincipal = "not-a-principal"; }],
    ["anonymous author", (v: any) => { v.entries[0].authorPrincipal = "2vxsx-fae"; }],
    ["management principal", (v: any) => { v.source.backendCanisterId = "aaaaa-aa"; }],
    ["unsafe id", (v: any) => { v.source.sheetId = "../sheet"; }],
    ["numeric nanosecond precision loss", (v: any) => { v.entries[0].createdAtNs = Number(ns); }],
    ["u64 overflow", (v: any) => { v.entries[0].id = "18446744073709551616"; }],
    ["noncanonical u64", (v: any) => { v.entries[0].id = "01"; }],
    ["duplicate entry", (v: any) => { v.entries.push(v.entries[0]); }],
    ["duplicate Type", (v: any) => { v.types.push(v.types[0]); }],
    ["missing history", (v: any) => { delete v.entries[0].history; }],
    ["inconsistent state", (v: any) => { v.metadata.state = "closed"; }],
    ["invalid closing amount", (v: any) => { v.metadata.closingBalances = [{ currency: "USD", amount_minor: 1.5 }]; }],
  ])("rejects %s atomically", (_label, mutate) => {
    expect(() => parseSheetBackup(changed(mutate))).toThrow(/Invalid sheet backup/);
  });

  it.each([
    ["fractional minor amount", (p: any) => { p.amount_minor = 1.1; }],
    ["unsafe amount", (p: any) => { p.amount_minor = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative amount", (p: any) => { p.amount_minor = -1; }],
    ["zero amount", (p: any) => { p.amount_minor = 0; }],
    ["fee-net mismatch", (p: any) => { p.fee.percent = 10; }],
    ["invalid date", (p: any) => { p.ts = 8_640_000_000_000_001; }],
    ["incomplete schedule", (p: any) => { p.schedule[0].percent = 1; }],
    ["invalid direction", (p: any) => { p.direction = "owed"; }],
    ["invalid currency", (p: any) => { p.currency = "USDT"; }],
    ["invalid conversion", (p: any) => { p.convert.rate = 0; }],
    ["nested unknown schedule field", (p: any) => { p.schedule[0].password = "secret"; }],
  ])("rejects %s in current AND archived payloads", (_label, mutate) => {
    expect(() => parseSheetBackup(changed(v => mutate(v.entries[0].payload)))).toThrow();
    expect(() => parseSheetBackup(changed(v => mutate(v.entries[0].history[0].payload)))).toThrow();
  });

  it.each([
    ["invalid amount", (v: any) => { v.amount_minor = -1; }],
    ["missing name", (v: any) => { v.name = ""; }],
    ["unknown Type fields", (v: any) => { v.seed = "secret"; }],
    ["unknown schedule fields", (v: any) => { v.schedule[0].extra = 1; }],
    ["invalid schedule sum", (v: any) => { v.schedule[0].percent = 1; }],
    ["bad keyword", (v: any) => { v.keywords = ["x".repeat(65)]; }],
    ["settlement with fees", (v: any) => { v.txn_type = "settlement"; }],
  ])("rejects %s in Types", (_label, mutate) => {
    expect(() => parseSheetBackup(changed(v => mutate(v.types[0])))).toThrow();
  });

  it("rejects malformed JSON, dangerous keys, missing fields and oversized input", () => {
    expect(() => parseSheetBackup("{")).toThrow();
    expect(() => parseSheetBackup("[]")).toThrow();
    const text = serializeSheetBackup(backup());
    expect(() => parseSheetBackup(text.replace('"source":{', '"source":{"__proto__":{},'))).toThrow();
    expect(() => parseSheetBackup(" ".repeat(SHEET_BACKUP_LIMITS.bytes + 1))).toThrow();
    expect(() => parseSheetBackup("é".repeat(SHEET_BACKUP_LIMITS.bytes / 2 + 1))).toThrow(/too large/);
  });

  it("enforces record, history, Type and payload bounds without dropping excess data", () => {
    const source = input();
    source.entries = Array.from({ length: SHEET_BACKUP_LIMITS.entries + 1 }, () => source.entries[0]);
    expect(() => buildSheetBackup(source)).toThrow(/entry count/);
    expect(() => parseSheetBackup(changed(v => { v.entries[0].history = Array(101).fill(v.entries[0].history[0]); }))).toThrow(/history count/);
    expect(() => parseSheetBackup(changed(v => { v.types = Array(101).fill(v.types[0]); }))).toThrow(/Type count/);
    expect(() => parseSheetBackup(changed(v => { v.entries[0].payload.note = "x".repeat(64_000); }))).toThrow(/payload is too large/);
  });

  it("supports an empty sheet without fabricating an entry or Type", () => {
    const source = input(); source.entries = []; source.types = [];
    expect(planSheetImport(buildSheetBackup(source)).summary).toEqual({ currentEntries: 0, deletedEntries: 0, historyVersions: 0, types: 0 });
  });

  it("rejects an import if remapped Types exceed the encrypted destination slot", () => {
    const source = input();
    source.types = Array.from({ length: 30 }, (_, index) => ({
      id: String(index), name: "T", direction: "credit", txn_type: "iou", note: "x".repeat(2_000),
    }));
    const original = buildSheetBackup(source);
    expect(() => planSheetImport(original)).toThrow(/destination slot size/);
    expect(original.types).toEqual(source.types);
  });
});
