/** Browser-side plaintext backup orchestration. No identities or encryption keys enter the file. */
import { sha256 } from "@noble/hashes/sha256";
import { decryptEntryPayload, decryptWithSheetKey, encryptWithSheetKey } from "../crypto/devVetkd";
import { decodeClosingBalances } from "../entries/closingBalances";
import { addEntryBatch, type EntryBatchActor } from "../entries/batchImport";
import { decodeEntry, type EntryPayload } from "../entries/types";
import { decryptSlotWithStatus, myMemberIndex } from "../templates/pairTemplatesActor";
import { encodePairSlot, mergePairTemplates, visibleTemplates } from "../templates/pairTemplates";
import {
  buildSheetBackup, planSheetImport, SHEET_BACKUP_LIMITS,
  type SheetBackup, type SheetBackupEntry, type SheetImportPlan,
} from "./backupFormat";

export interface BackupActor extends EntryBatchActor {
  get_sheet(id: string): Promise<any>;
  get_pair(id: string): Promise<any>;
  list_entries(id: string, cursor: [] | [bigint], limit: number): Promise<any>;
  set_pair_templates(id: string, ciphertext: number[], iv: number[]): Promise<unknown>;
}
export interface BackupContext {
  actor: BackupActor;
  sheetId: string;
  principal: string;
  sheetKey: Uint8Array;
  /** Throws when actor, principal, selected sheet, session or component lifetime changed. */
  assertCurrent: () => void;
}
export interface ExportSheetBackupOptions extends BackupContext {
  backendCanisterId: string;
  exportedAt?: number;
}
export interface ImportSheetBackupOptions extends BackupContext { backup: SheetBackup }
export interface SheetBackupImportPreview {
  backupId: string;
  accountName: string;
  sheetName: string;
  typeCount: number;
  activeEntryCount: number;
  skippedDeletedCount: number;
  auditHistoryCount: number;
  resumedEntryCount: number;
  remainingEntryCount: number;
  limitations: readonly string[];
}
export interface SheetBackupImportResult {
  importedEntryCount: number;
  replayedEntryCount: number;
  totalActiveEntries: number;
  typeCount: number;
}

const encoder = new TextEncoder();
const U64_MAX = (1n << 64n) - 1n;
const MAX_WIRE_BYTES = 64 * 1024 * 1024;
const BATCH_BYTES = 256 * 1024;
function fail(message: string): never { throw new Error(message); }
function opt<T>(value: [] | [T]): T | null {
  if (!Array.isArray(value) || value.length > 1) fail("Invalid optional backend field; backup stopped.");
  return value.length ? value[0] : null;
}
function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (!Array.isArray(value) || value.some(v => !Number.isInteger(v) || v < 0 || v > 255)) fail("Invalid encrypted bytes; backup stopped.");
  return new Uint8Array(value);
}
function principalText(value: any): string { return typeof value?.toText === "function" ? value.toText() : String(value); }
function ns(value: unknown): string {
  if (typeof value !== "bigint" || value < 0n || value > U64_MAX) fail("Invalid exact backend timestamp or identifier.");
  return value.toString();
}
function optionalNs(value: [] | [bigint]): string | null { const result = opt(value); return result === null ? null : ns(result); }
function canonical(value: any): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Uint8Array) return canonical(Array.from(value));
  if (typeof value?.toText === "function") return JSON.stringify(value.toText());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function fingerprint(value: unknown): string { return Array.from(sha256(encoder.encode(canonical(value))), b => b.toString(16).padStart(2, "0")).join(""); }
function context(options: BackupContext): void {
  options.assertCurrent();
  if (!/^[0-9a-f]{16}$/.test(options.sheetId) || !options.principal || options.principal === "2vxsx-fae" ||
    !(options.sheetKey instanceof Uint8Array) || options.sheetKey.length !== 32) fail("Invalid signed-in sheet backup context.");
}
async function checked<T>(o: BackupContext, operation: () => Promise<T>): Promise<T> {
  o.assertCurrent(); const result = await operation(); o.assertCurrent(); return result;
}
async function readContext(o: BackupContext) {
  context(o);
  const sheet = opt<any>(await checked(o, () => o.actor.get_sheet(o.sheetId)));
  if (!sheet || sheet.id !== o.sheetId || ![sheet.member_a, sheet.member_b].some(p => principalText(p) === o.principal)) fail("The selected sheet is not available to this user.");
  const pair = opt<any>(await checked(o, () => o.actor.get_pair(sheet.pair_id)));
  const memberIndex = pair && myMemberIndex(pair, o.principal);
  if (!pair || pair.id !== sheet.pair_id || memberIndex == null) fail("The selected IOU account is not available to this user.");
  return { sheet, pair, memberIndex };
}
async function readRecords(o: BackupContext, pairId: string): Promise<any[]> {
  const result: any[] = [];
  let cursor: [] | [bigint] = [];
  let previous = U64_MAX + 1n;
  let wireBytes = 0;
  for (;;) {
    const page = await checked(o, () => o.actor.list_entries(o.sheetId, cursor, 200));
    if (!page || !Array.isArray(page.entries) || page.entries.length > 200) fail("Invalid entry page; backup stopped.");
    for (const entry of page.entries) {
      ns(entry.id);
      if (entry.id <= 0n || entry.id >= previous || entry.sheet_id !== o.sheetId || entry.pair_id !== pairId) fail("Incomplete or inconsistent entry pagination; backup stopped.");
      previous = entry.id;
      wireBytes += encoder.encode(canonical(entry)).byteLength;
      if (wireBytes > MAX_WIRE_BYTES || result.length >= SHEET_BACKUP_LIMITS.entries) fail("Sheet exceeds backup resource limits.");
      result.push(entry);
    }
    const next = opt<bigint>(page.next_cursor);
    if (next === null) return result;
    if (!page.entries.length || typeof next !== "bigint" || next !== previous || (cursor.length && next >= cursor[0])) fail("Incomplete or inconsistent entry pagination; backup stopped.");
    cursor = [next];
  }
}
async function decryptPayload(o: BackupContext, row: any): Promise<EntryPayload> {
  const clear = await checked(o, () => decryptEntryPayload(bytes(row.entry_key), bytes(row.iv), bytes(row.ciphertext), o.sheetKey));
  return decodeEntry(clear);
}
async function decryptRecords(o: BackupContext, rows: any[]): Promise<SheetBackupEntry[]> {
  const result: SheetBackupEntry[] = [];
  let totalHistory = 0;
  for (const row of rows) {
    const history = opt<any[]>(row.history) ?? [];
    if (!Array.isArray(history) || history.length > SHEET_BACKUP_LIMITS.historyPerEntry || (totalHistory += history.length) > SHEET_BACKUP_LIMITS.totalHistory) fail("Entry history exceeds backup limits.");
    const versions = [];
    for (const version of history) versions.push({ replacedAtNs: ns(version.replaced_at), payload: await decryptPayload(o, version) });
    result.push({
      id: ns(row.id), authorPrincipal: principalText(row.created_by), createdAtNs: ns(row.created_at_server),
      updatedAtNs: optionalNs(row.updated_at_server), deletedAtNs: optionalNs(row.deleted_at),
      payload: await decryptPayload(o, row), history: versions,
    });
  }
  return result.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1);
}
async function readSlots(o: BackupContext, pair: any) {
  const a = await checked(o, () => decryptSlotWithStatus(o.sheetKey, pair.templates_a_enc, pair.templates_a_iv));
  const b = await checked(o, () => decryptSlotWithStatus(o.sheetKey, pair.templates_b_enc, pair.templates_b_iv));
  if (!a.readable || !b.readable) fail("Private Types could not be read completely; backup/import stopped.");
  return [a.payload, b.payload] as const;
}
async function name(o: BackupContext, encrypted: any, iv: any): Promise<string> {
  const e = opt<any>(encrypted); const i = opt<any>(iv);
  if (e === null && i === null) return "";
  if (e === null || i === null) fail("Encrypted name is incomplete; backup stopped.");
  return new TextDecoder("utf-8", { fatal: true }).decode(await checked(o, () => decryptWithSheetKey(o.sheetKey, bytes(i), bytes(e))));
}

/** Two complete read passes detect observed concurrent changes; there is no backend snapshot API. */
export async function exportSheetBackup(o: ExportSheetBackupOptions): Promise<SheetBackup> {
  const initial = await readContext(o);
  const rows = await readRecords(o, initial.pair.id);
  const slots = await readSlots(o, initial.pair);
  const types = visibleTemplates(mergePairTemplates(slots[0].templates, slots[1].templates))
    .map(({ rev: _rev, updatedAt: _updatedAt, deleted: _deleted, ...type }) => type);
  const { sheet, pair } = initial;
  const closingKey = opt<any>(sheet.closing_balances_key);
  const closingEnc = opt<any>(sheet.closing_balances_enc);
  const closingIv = opt<any>(sheet.closing_balances_iv);
  if ([closingKey, closingEnc, closingIv].some(v => v !== null) && [closingKey, closingEnc, closingIv].some(v => v === null)) fail("Closing balance snapshot is incomplete.");
  const closingBalances = closingKey === null ? null : decodeClosingBalances(await checked(o, () => decryptEntryPayload(bytes(closingKey), bytes(closingIv), bytes(closingEnc), o.sheetKey)))
    .map(row => ({ currency: row.currency, amount_minor: row.direction === "credit" ? row.amount_minor : -row.amount_minor }));
  const backup = buildSheetBackup({
    exportedAt: o.exportedAt ?? Date.now(),
    source: { backendCanisterId: o.backendCanisterId, accountId: pair.id, sheetId: sheet.id, exporterPrincipal: o.principal },
    accountName: await name(o, pair.name_enc, pair.name_iv), sheetName: await name(o, sheet.name_enc, sheet.name_iv),
    metadata: {
      state: "Active" in sheet.state ? "active" : "Closed" in sheet.state ? "closed" : fail("Invalid sheet state."),
      closingWindowDays: sheet.closing_window_days, createdAtNs: ns(sheet.created_at), closedAtNs: optionalNs(sheet.closed_at),
      accountArchivedAtNs: optionalNs(pair.archived_at), lastEntryAtNs: optionalNs(sheet.last_entry_at), closingBalances,
    }, types, entries: await decryptRecords(o, rows),
  });
  const final = await readContext(o);
  const finalRows = await readRecords(o, pair.id);
  if (fingerprint(initial) !== fingerprint(final) || fingerprint(rows) !== fingerprint(finalRows)) fail("Sheet changed during export. No partial backup was produced; try again.");
  o.assertCurrent();
  return backup;
}

function chunks(plan: SheetImportPlan) {
  const result: typeof plan.entries[] = [];
  let chunk: typeof plan.entries = []; let size = 0;
  for (const entry of plan.entries) {
    const rowSize = encoder.encode(JSON.stringify(entry.payload)).byteLength + 16 + 32 + 12;
    if (rowSize - 44 > 64_000) fail("Imported entry exceeds encrypted backend limits.");
    if (chunk.length === 32 || size + rowSize > BATCH_BYTES) { result.push(chunk); chunk = []; size = 0; }
    chunk.push(entry); size += rowSize;
  }
  if (chunk.length) result.push(chunk);
  return result;
}
function importedTemplates(o: ImportSheetBackupOptions, plan: SheetImportPlan) {
  return plan.types.map(type => ({ ...type, rev: 1, updatedAt: o.backup.exportedAt }));
}
async function inspectTarget(o: ImportSheetBackupOptions, plan: SheetImportPlan) {
  const state = await readContext(o);
  if (!("Active" in state.sheet.state) || opt(state.pair.archived_at) !== null) fail("Import requires an active sheet in an active account.");
  const slots = await readSlots(o, state.pair);
  const own = slots[state.memberIndex]; const other = slots[1 - state.memberIndex];
  const desired = importedTemplates(o, plan);
  if (other.templates.length || other.dismissed.length || own.dismissed.length ||
    (own.templates.length && canonical(own.templates) !== canonical(desired))) fail("Destination contains unrelated or changed Types. Choose a new empty account and sheet.");
  const expected = new Map(plan.entries.map(row => [row.payload.draft_id, row.payload]));
  const existing = new Set<string>();
  const rows = await readRecords(o, state.pair.id);
  for (const row of rows) {
    const payload = await decryptPayload(o, row);
    const draftId = payload.draft_id;
    if (!draftId || !expected.has(draftId) || existing.has(draftId) || principalText(row.created_by) !== o.principal ||
      opt(row.deleted_at) !== null || (opt<any[]>(row.history)?.length ?? 0) !== 0 || opt(row.updated_at_server) !== null ||
      canonical(payload) !== canonical(expected.get(draftId))) fail("Destination contains unrelated or changed entries. Import stopped without overwriting them.");
    existing.add(draftId);
  }
  for (const chunk of chunks(plan)) {
    const count = chunk.filter(row => existing.has(row.payload.draft_id!)).length;
    if (count !== 0 && count !== chunk.length) fail("An earlier import batch is incomplete or changed. Inspect the destination before retrying.");
  }
  return { ...state, existing, typesPresent: own.templates.length > 0 };
}
function preview(plan: SheetImportPlan, resumedEntryCount: number): SheetBackupImportPreview {
  return { backupId: plan.backupId, accountName: plan.accountName, sheetName: plan.sheetName, typeCount: plan.types.length,
    activeEntryCount: plan.summary.currentEntries, skippedDeletedCount: plan.summary.deletedEntries,
    auditHistoryCount: plan.summary.historyVersions, resumedEntryCount, remainingEntryCount: plan.entries.length - resumedEntryCount,
    limitations: plan.limitations };
}
export async function previewSheetBackupImport(o: ImportSheetBackupOptions): Promise<SheetBackupImportPreview> {
  const plan = planSheetImport(o.backup);
  const state = await inspectTarget(o, plan);
  return preview(plan, state.existing.size);
}

/** Receipt identities are stable per exact file and fixed batch, independent of randomized ciphertext.
 * This does not turn the whole import into one transaction or prevent unrelated concurrent writers. */
export async function importSheetBackup(o: ImportSheetBackupOptions): Promise<SheetBackupImportResult> {
  const plan = planSheetImport(o.backup);
  let state = await inspectTarget(o, plan);
  let importedEntryCount = 0;
  if (plan.types.length && !state.typesPresent) {
    const sealed = await checked(o, () => encryptWithSheetKey(o.sheetKey, encodePairSlot(importedTemplates(o, plan))));
    if (sealed.ciphertext.length > 64_000) fail("Imported Types exceed encrypted backend limits.");
    state = await inspectTarget(o, plan);
    if (!state.typesPresent) await checked(o, () => o.actor.set_pair_templates(state.pair.id, Array.from(sealed.ciphertext), Array.from(sealed.iv)));
  }
  for (const chunk of chunks(plan)) {
    state = await inspectTarget(o, plan);
    if (chunk.every(row => state.existing.has(row.payload.draft_id!))) continue;
    // Domain-separated migration ID never reuses a chat message/relay identity.
    const handle = sha256(encoder.encode(`iou-sheet-backup-batch-v1\0${plan.backupId}\0${chunk.map(row => row.sourceEntryId).join(",")}`));
    const messageHandle = btoa(String.fromCharCode(...handle)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const result = await checked(o, () => addEntryBatch({ actor: o.actor, sheetId: o.sheetId, sheetKey: o.sheetKey,
      payloads: chunk.map(row => row.payload), messageHandle, relayId: "unused-backup-domain", beforeMutate: o.assertCurrent }));
    if (result.accepted_count !== chunk.length) fail("Import receipt differs from the reviewed batch. Inspect the destination before retrying.");
    if (!result.replayed) importedEntryCount += result.accepted_count;
  }
  const final = await inspectTarget(o, plan);
  if (final.existing.size !== plan.entries.length || (plan.types.length > 0 && !final.typesPresent)) fail("Import verification is incomplete. Retry the same file to resume safely.");
  o.assertCurrent();
  return { importedEntryCount, replayedEntryCount: final.existing.size - importedEntryCount,
    totalActiveEntries: final.existing.size, typeCount: plan.types.length };
}
