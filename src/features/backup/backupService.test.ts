import { describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { buildSheetBackup, planSheetImport, type SheetBackup } from "./backupFormat";
import { exportSheetBackup, importSheetBackup, previewSheetBackupImport, type BackupActor } from "./backupService";
import { decryptEntryPayload, decryptWithSheetKey, encryptEntryPayload, encryptName, encryptWithSheetKey } from "../crypto/devVetkd";
import { encodePairSlot } from "../templates/pairTemplates";
import { decodeEntry, type EntryPayload } from "../entries/types";

const principal = Principal.selfAuthenticating(new Uint8Array(32).fill(1)).toText();
const partner = Principal.selfAuthenticating(new Uint8Array(32).fill(2)).toText();
const backend = Principal.fromUint8Array(new Uint8Array([1, 1])).toText();
const sheetId = "abcdef0123456789";
const pairId = "0123456789abcdef";
const key = new Uint8Array(32).fill(9);
const encoder = new TextEncoder();
const text = (v: Uint8Array) => new TextDecoder().decode(v);
const payload = (amount = 100): EntryPayload => ({ ts: 1_000, kind: "expense", currency: "USD", amount_minor: amount, direction: "credit", note: "private note", txn_type: "iou" });
const type = { id: "source-type", name: "User-defined type", direction: "debt" as const, txn_type: "iou" as const, keywords: ["private keyword"] };
function backup(count = 1, overrides: Partial<SheetBackup> = {}): SheetBackup {
  return buildSheetBackup({
    exportedAt: 2_000, source: { backendCanisterId: backend, accountId: "sourceaccount", sheetId: "sourcesheet", exporterPrincipal: principal },
    accountName: "Source account", sheetName: "Source sheet",
    metadata: { state: "active", closingWindowDays: 365, createdAtNs: "1234567890123456789", closedAtNs: null, accountArchivedAtNs: null, lastEntryAtNs: null, closingBalances: null },
    types: [type], entries: Array.from({ length: count }, (_, index) => ({
      id: String(index + 1), authorPrincipal: principal, createdAtNs: "1234567890123456789", updatedAtNs: null, deletedAtNs: null,
      payload: payload(index + 1), history: [],
    })), ...overrides,
  });
}
async function encryptedRow(id: bigint, p: EntryPayload = payload(), author = principal) {
  const encrypted = await encryptEntryPayload(encoder.encode(JSON.stringify(p)), key);
  return { id, pair_id: pairId, sheet_id: sheetId, created_by: author, created_at_server: 1234567890123456789n,
    updated_at_server: [], deleted_at: [], history: [], entry_key: encrypted.entryKey, iv: encrypted.iv, ciphertext: encrypted.ciphertext } as any;
}
function fixture() {
  const sheet: any = { id: sheetId, pair_id: pairId, member_a: principal, member_b: "2vxsx-fae", state: { Active: null }, closing_window_days: 365,
    created_at: 1234567890123456789n, closed_at: [], last_entry_at: [], name_enc: [], name_iv: [], closing_balances_key: [], closing_balances_enc: [], closing_balances_iv: [] };
  const pair: any = { id: pairId, members: [principal, "2vxsx-fae"], archived_at: [], name_enc: [], name_iv: [],
    templates_a_enc: [], templates_a_iv: [], templates_b_enc: [], templates_b_iv: [] };
  const rows: any[] = [];
  const receipts = new Map<string, bigint[]>();
  let attempts = 0;
  let failBefore = 0;
  let failAfter = 0;
  const actor = {
    get_sheet: vi.fn(async () => [structuredClone(sheet)]),
    get_pair: vi.fn(async () => [structuredClone(pair)]),
    list_entries: vi.fn(async (_id: string, cursor: [] | [bigint], limit: number) => {
      const filtered = rows.filter(row => !cursor.length || row.id < cursor[0]).sort((a, b) => a.id > b.id ? -1 : 1);
      return { entries: structuredClone(filtered.slice(0, limit)), next_cursor: filtered.length > limit ? [filtered[limit - 1].id] : [] };
    }),
    set_pair_templates: vi.fn(async (_id: string, ciphertext: number[], iv: number[]) => { pair.templates_a_enc = [ciphertext]; pair.templates_a_iv = [iv]; }),
    add_entry_batch: vi.fn(async (request: Parameters<BackupActor["add_entry_batch"]>[0]) => {
      attempts++;
      if (attempts === failBefore) throw new Error("injected before commit");
      const receiptKey = request.import_id.join(",");
      const replay = receipts.get(receiptKey);
      if (replay) return { entry_ids: replay, replayed: true };
      const ids: bigint[] = [];
      for (const row of request.entries) {
        const id = BigInt(rows.length + 1); ids.push(id);
        rows.push({ id, pair_id: pairId, sheet_id: sheetId, created_by: principal, created_at_server: 8n,
          updated_at_server: [], deleted_at: [], history: [], ...structuredClone(row) });
      }
      receipts.set(receiptKey, ids);
      if (attempts === failAfter) throw new Error("injected unknown outcome");
      return { entry_ids: ids, replayed: false };
    }),
  };
  const options = { actor, sheetId, principal, sheetKey: key, assertCurrent: vi.fn() };
  return { sheet, pair, rows, actor, options, failBefore: (n: number) => { failBefore = n; }, failAfter: (n: number) => { failAfter = n; } };
}
async function setTypes(f: ReturnType<typeof fixture>, types: any[], slot: "a" | "b" = "a") {
  const sealed = await encryptWithSheetKey(key, encodePairSlot(types));
  f.pair[`templates_${slot}_enc`] = [sealed.ciphertext]; f.pair[`templates_${slot}_iv`] = [sealed.iv];
}
async function decode(row: any) { return decodeEntry(await decryptEntryPayload(new Uint8Array(row.entry_key), new Uint8Array(row.iv), new Uint8Array(row.ciphertext), key)); }

describe("sheet backup export", () => {
  it("exports exact timestamps, deleted rows and history, visible private Types and decrypted names without keys", async () => {
    const f = fixture();
    const row = await encryptedRow(9007199254740993n, payload(), partner);
    const version = await encryptedRow(1n, payload(50));
    row.history = [[{ ...version, replaced_at: 1234567890123456788n }]];
    row.deleted_at = [1234567890123456790n]; f.rows.push(row);
    const accountName = await encryptName(key, "Private account");
    f.pair.name_enc = [accountName.enc]; f.pair.name_iv = [accountName.iv];
    const sheetName = await encryptName(key, "Private sheet");
    f.sheet.name_enc = [sheetName.enc]; f.sheet.name_iv = [sheetName.iv];
    await setTypes(f, [{ ...type, rev: 2, updatedAt: 1 }]);
    const result = await exportSheetBackup({ ...f.options, backendCanisterId: backend, exportedAt: 2_000 });
    expect(result.accountName).toBe("Private account"); expect(result.sheetName).toBe("Private sheet");
    expect(result.entries[0]).toMatchObject({ id: "9007199254740993", authorPrincipal: partner, createdAtNs: "1234567890123456789", deletedAtNs: "1234567890123456790", payload: payload() });
    expect(result.entries[0].history[0]).toEqual({ replacedAtNs: "1234567890123456788", payload: payload(50) });
    expect(result.types).toEqual([type]);
    expect(JSON.stringify(result)).not.toMatch(/ciphertext|entry_key|sheetKey|templates_a|invite_code/);
    expect(f.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("reads every page twice and detects changes instead of exporting a partial snapshot", async () => {
    const f = fixture();
    for (let i = 1; i <= 201; i++) f.rows.push(await encryptedRow(BigInt(i), payload(i)));
    expect((await exportSheetBackup({ ...f.options, backendCanisterId: backend })).entries).toHaveLength(201);
    expect(f.actor.list_entries).toHaveBeenCalledTimes(4);
    f.actor.get_sheet.mockImplementationOnce(async () => [structuredClone(f.sheet)]).mockImplementationOnce(async () => [{ ...f.sheet, last_entry_at: [9n] }]);
    await expect(exportSheetBackup({ ...f.options, backendCanisterId: backend })).rejects.toThrow("changed during export");
  });
  it.each(["entry", "history", "name", "types"])("fails closed on unreadable %s instead of omitting it", async bad => {
    const f = fixture(); const row = await encryptedRow(1n); f.rows.push(row);
    if (bad === "entry") row.ciphertext[0] ^= 1;
    if (bad === "history") row.history = [[{ ...await encryptedRow(2n), ciphertext: [1], replaced_at: 3n }]];
    if (bad === "name") { f.sheet.name_enc = [[1]]; f.sheet.name_iv = [[1]]; }
    if (bad === "types") { f.pair.templates_a_enc = [[1]]; f.pair.templates_a_iv = [[1]]; }
    await expect(exportSheetBackup({ ...f.options, backendCanisterId: backend })).rejects.toThrow();
  });
  it("rejects looping or mismatched pagination", async () => {
    const f = fixture(); const row = await encryptedRow(1n);
    f.actor.list_entries.mockResolvedValue({ entries: [row], next_cursor: [2n] });
    await expect(exportSheetBackup({ ...f.options, backendCanisterId: backend })).rejects.toThrow("pagination");
  });
  it("archives encrypted closing balances and closed metadata without converting them to new entries", async () => {
    const f = fixture(); f.sheet.state = { Closed: null }; f.sheet.closed_at = [1234567890123456790n];
    const sealed = await encryptEntryPayload(encoder.encode(JSON.stringify([{ currency: "USD", amount_minor: 70, direction: "debt" }])), key);
    f.sheet.closing_balances_key = [sealed.entryKey]; f.sheet.closing_balances_enc = [sealed.ciphertext]; f.sheet.closing_balances_iv = [sealed.iv];
    const result = await exportSheetBackup({ ...f.options, backendCanisterId: backend });
    expect(result.metadata).toMatchObject({ state: "closed", closedAtNs: "1234567890123456790", closingBalances: [{ currency: "USD", amount_minor: -70 }] });
    expect(result.entries).toEqual([]);
  });
});

describe("sheet backup import", () => {
  it("previews without mutation, then re-encrypts 65 rows in stable 32/32/1 chunks; same-file rerun writes no duplicates", async () => {
    const f = fixture(); const file = backup(65);
    const options = { ...f.options, backup: file };
    const preview = await previewSheetBackupImport(options);
    expect(preview).toMatchObject({ activeEntryCount: 65, remainingEntryCount: 65, resumedEntryCount: 0, typeCount: 1 });
    expect(f.actor.set_pair_templates).not.toHaveBeenCalled(); expect(f.actor.add_entry_batch).not.toHaveBeenCalled();
    expect(await importSheetBackup(options)).toEqual({ importedEntryCount: 65, replayedEntryCount: 0, totalActiveEntries: 65, typeCount: 1 });
    expect(f.actor.add_entry_batch.mock.calls.map(([r]) => r.entries.length)).toEqual([32, 32, 1]);
    expect(await decode(f.rows[0])).toEqual(planSheetImport(file).entries[0].payload);
    expect(text(new Uint8Array(f.rows[0].ciphertext))).not.toContain("private note");
    const slot = JSON.parse(text(await decryptWithSheetKey(key, new Uint8Array(f.pair.templates_a_iv[0]), new Uint8Array(f.pair.templates_a_enc[0]))));
    expect(slot.templates[0].id).toMatch(/^backup-/); expect(slot.templates[0].keywords).toEqual(type.keywords);
    expect(await importSheetBackup(options)).toEqual({ importedEntryCount: 0, replayedEntryCount: 65, totalActiveEntries: 65, typeCount: 1 });
    expect(f.actor.add_entry_batch).toHaveBeenCalledTimes(3); expect(f.actor.set_pair_templates).toHaveBeenCalledTimes(1);
  });
  it.each(["before", "after"])("resumes after failure %s batch commit without duplicate entries", async stage => {
    const f = fixture(); const options = { ...f.options, backup: backup(33) };
    if (stage === "before") f.failBefore(2); else f.failAfter(1);
    await expect(importSheetBackup(options)).rejects.toThrow("injected");
    expect(f.rows).toHaveLength(32);
    const result = await importSheetBackup(options);
    expect(f.rows).toHaveLength(33); expect(result.importedEntryCount).toBe(1); expect(result.replayedEntryCount).toBe(32);
    expect(new Set((await Promise.all(f.rows.map(decode))).map(p => p.draft_id)).size).toBe(33);
  });
  it("preserves financial fields, flips partner direction, and archives rather than recreates deleted/history data", async () => {
    const f = fixture(); const file = backup(2);
    file.entries[0].authorPrincipal = partner;
    file.entries[0].payload = { ...payload(90), fee: { percent: 10, gross_amount_minor: 100 }, schedule: [{ due_ts: 9_000, percent: 100 }],
      convert: { from_currency: "EUR", from_amount_minor: 50, to_currency: "USD", to_amount_minor: 100, rate: 2, rate_source: "manual", rate_fetched_at: 1_000 } };
    file.entries[0].history = [{ replacedAtNs: "1", payload: payload(5) }]; file.entries[1].deletedAtNs = "9";
    expect(await previewSheetBackupImport({ ...f.options, backup: file })).toMatchObject({ activeEntryCount: 1, skippedDeletedCount: 1, auditHistoryCount: 1 });
    await importSheetBackup({ ...f.options, backup: file });
    expect(await decode(f.rows[0])).toMatchObject({ ...file.entries[0].payload, direction: "debt" });
    expect(f.rows[0].created_by).toBe(principal); expect(f.rows[0].history).toEqual([]); expect(f.rows).toHaveLength(1);
  });
  it("replays the same backend receipt even when a retry re-encrypts after stale reads", async () => {
    const f = fixture(); const options = { ...f.options, backup: backup(1, { types: [] }) };
    f.failAfter(1);
    await expect(importSheetBackup(options)).rejects.toThrow("unknown outcome");
    // Model a stale query response; the authoritative update receipt must still prevent duplication.
    f.actor.list_entries.mockResolvedValueOnce({ entries: [], next_cursor: [] }).mockResolvedValueOnce({ entries: [], next_cursor: [] });
    const result = await importSheetBackup(options);
    expect(result).toMatchObject({ importedEntryCount: 0, replayedEntryCount: 1, totalActiveEntries: 1 });
    const first = f.actor.add_entry_batch.mock.calls[0][0]; const second = f.actor.add_entry_batch.mock.calls[1][0];
    expect(second.import_id).toEqual(first.import_id);
    expect(second.entries[0].ciphertext).not.toEqual(first.entries[0].ciphertext);
    expect(f.rows).toHaveLength(1);
  });
  it("splits by encrypted byte limits as well as row count", async () => {
    const f = fixture(); const file = backup(5, { types: [] });
    file.entries.forEach(e => { e.payload.note = "x".repeat(62_000); });
    await importSheetBackup({ ...f.options, backup: file });
    expect(f.actor.add_entry_batch.mock.calls.map(([r]) => r.entries.length)).toEqual([4, 1]);
  });
  it.each(["unknown", "changed", "duplicate", "author", "deleted", "history", "updated"])("rejects target %s entries, even with matching draft IDs", async bad => {
    const f = fixture(); const file = backup(); const planned = planSheetImport(file).entries[0].payload;
    const row = await encryptedRow(1n, bad === "unknown" ? payload() : bad === "changed" ? { ...planned, amount_minor: 999 } : planned);
    if (bad === "author") row.created_by = partner;
    if (bad === "deleted") row.deleted_at = [1n];
    if (bad === "history") row.history = [[{ ...row, replaced_at: 1n }]];
    if (bad === "updated") row.updated_at_server = [1n];
    f.rows.push(row); if (bad === "duplicate") f.rows.push({ ...row, id: 2n });
    await expect(importSheetBackup({ ...f.options, backup: file })).rejects.toThrow("unrelated or changed entries");
    expect(f.actor.add_entry_batch).not.toHaveBeenCalled(); expect(f.actor.set_pair_templates).not.toHaveBeenCalled();
  });
  it("rejects a partially present atomic chunk and unrelated Types without writing", async () => {
    const f = fixture(); const file = backup(2); f.rows.push(await encryptedRow(1n, planSheetImport(file).entries[0].payload));
    await expect(importSheetBackup({ ...f.options, backup: file })).rejects.toThrow("batch is incomplete");
    f.rows.length = 0; await setTypes(f, [{ ...type, rev: 1, updatedAt: 0 }]);
    await expect(importSheetBackup({ ...f.options, backup: file })).rejects.toThrow("unrelated or changed Types");
    expect(f.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("rejects closed, archived, nonmember and wrong-id target sheets", async () => {
    for (const mutate of [(f: ReturnType<typeof fixture>) => { f.sheet.state = { Closed: null }; },
      (f: ReturnType<typeof fixture>) => { f.pair.archived_at = [1n]; },
      (f: ReturnType<typeof fixture>) => { f.sheet.member_a = partner; },
      (f: ReturnType<typeof fixture>) => { f.sheet.id = "bad"; }]) {
      const f = fixture(); mutate(f); await expect(importSheetBackup({ ...f.options, backup: backup() })).rejects.toThrow();
      expect(f.actor.set_pair_templates).not.toHaveBeenCalled(); expect(f.actor.add_entry_batch).not.toHaveBeenCalled();
    }
  });
  it("aborts on auth change after Types write before any entry write", async () => {
    const f = fixture(); let current = true;
    const original = f.actor.set_pair_templates.getMockImplementation()!;
    f.actor.set_pair_templates.mockImplementation(async (...args) => { await original(...args); current = false; });
    await expect(importSheetBackup({ ...f.options, backup: backup(), assertCurrent: () => { if (!current) throw new Error("session changed"); } })).rejects.toThrow("session changed");
    expect(f.actor.add_entry_batch).not.toHaveBeenCalled();
  });
  it("stops before a second batch if an unrelated writer changes the target", async () => {
    const f = fixture(); const original = f.actor.add_entry_batch.getMockImplementation()!;
    f.actor.add_entry_batch.mockImplementation(async request => {
      const result = await original(request);
      f.rows.push(await encryptedRow(1000n, payload(999)));
      return result;
    });
    await expect(importSheetBackup({ ...f.options, backup: backup(33, { types: [] }) })).rejects.toThrow("unrelated or changed entries");
    expect(f.actor.add_entry_batch).toHaveBeenCalledTimes(1);
    expect(f.rows).toHaveLength(33);
  });
  it("requires no account creation or source mutation, and leaves chosen destination names untouched", async () => {
    const f = fixture(); const n = await encryptName(key, "Chosen destination"); f.sheet.name_enc = [n.enc]; f.sheet.name_iv = [n.iv];
    const before = structuredClone(f.sheet);
    await importSheetBackup({ ...f.options, backup: backup(0, { types: [] }) });
    expect(f.sheet).toEqual(before); expect(f.actor.add_entry_batch).not.toHaveBeenCalled();
  });
});
