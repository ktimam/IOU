/**
 * Portable, deliberately UNENCRYPTED sheet snapshots. This module never reads storage,
 * authenticates, decrypts, calls a canister, or writes a destination sheet.
 * Historical authors and server times are archive data, never import authority.
 */
import { Principal } from "@dfinity/principal";
import { sha256 } from "@noble/hashes/sha256";
import { orientPayload } from "../entries/balance";
import { decodeEntry, type EntryPayload } from "../entries/types";
import { decodePairSlotStrict, encodePairSlot } from "../templates/pairTemplates";
import type { TxnTemplate } from "../templates/TemplatesContext";

export const SHEET_BACKUP_FORMAT = "iou-sheet-backup";
export const SHEET_BACKUP_VERSION = 1;
export const SHEET_BACKUP_LIMITS = Object.freeze({
  bytes: 16 * 1024 * 1024,
  entries: 10_000,
  historyPerEntry: 100,
  totalHistory: 50_000,
  types: 100,
  // Backend ciphertext limit minus AES-GCM tag; never truncate a valid source payload.
  payloadBytes: 63_984,
  nameLength: 1_000,
});
export const SHEET_BACKUP_WARNING =
  "Unencrypted backup: anyone with this file can read its names, Types, entries and history. It contains no authentication credentials or encryption keys.";
export const SHEET_IMPORT_LIMITATIONS = Object.freeze([
  "Only current non-deleted entries are recreated. Deleted entries and edit history remain in the backup file, not the new ledger.",
  "Imported entries are new records authored by the importing account, with new IDs, encryption keys and server timestamps. Original authors and timestamps are unverified archive metadata, not restored attestations.",
  "Directions are converted to the exporting user's view. Existing source sheets and records are not changed.",
  "Types receive new IDs and belong to the destination account. Source account membership, chat links, pending cards, archival state and closing balances are not recreated.",
] as const);

export interface SheetBackupEntry {
  id: string;
  authorPrincipal: string;
  createdAtNs: string;
  updatedAtNs: string | null;
  deletedAtNs: string | null;
  /** Original author's direction, including in every archived history version. */
  payload: EntryPayload;
  history: { replacedAtNs: string; payload: EntryPayload }[];
}

export interface SheetBackup {
  format: typeof SHEET_BACKUP_FORMAT;
  version: typeof SHEET_BACKUP_VERSION;
  protection: "unencrypted";
  exportedAt: number;
  source: {
    backendCanisterId: string;
    accountId: string;
    sheetId: string;
    exporterPrincipal: string;
  };
  accountName: string;
  sheetName: string;
  metadata: {
    state: "active" | "closed";
    closingWindowDays: number;
    createdAtNs: string;
    closedAtNs: string | null;
    accountArchivedAtNs: string | null;
    lastEntryAtNs: string | null;
    closingBalances: { currency: string; amount_minor: number }[] | null;
  };
  /** Visible merged definitions, without slot revisions, dismissed cards or tombstones. */
  types: TxnTemplate[];
  entries: SheetBackupEntry[];
}

export type SheetBackupInput = Omit<SheetBackup, "format" | "version" | "protection">;
export interface SheetImportPlan {
  backupId: string;
  accountName: string;
  sheetName: string;
  closingWindowDays: number;
  types: TxnTemplate[];
  typeIdMap: { sourceId: string; targetId: string }[];
  entries: { sourceEntryId: string; sourceAuthor: "exporter" | "other"; payload: EntryPayload }[];
  summary: { currentEntries: number; deletedEntries: number; historyVersions: number; types: number };
  limitations: readonly string[];
}

export class SheetBackupError extends Error {
  constructor(message: string) { super(message); this.name = "SheetBackupError"; }
}

const encoder = new TextEncoder();
const U64_MAX = (1n << 64n) - 1n;
const ENTRY_FIELDS = ["ts", "kind", "currency", "amount_minor", "direction", "note", "txn_type", "schedule", "fee", "convert", "draft_id", "import_message_id"];
const TEMPLATE_FIELDS = ["id", "name", "direction", "txn_type", "currency", "amount_minor", "fee_percent", "fee_fixed_minor", "fee_fixed_currency", "schedule", "note", "keywords"];

function fail(label: string): never { throw new SheetBackupError(`Invalid sheet backup: ${label}.`); }
function record(value: unknown, fields: readonly string[], required: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some(key => !fields.includes(key)) ||
    required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) fail(label);
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  return record(value, fields, fields, label);
}
function text(value: unknown, max: number, label: string, nonempty = false): string {
  if (typeof value !== "string" || value.length > max || (nonempty && !value.trim())) fail(label);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) fail(label);
  return value;
}
function date(value: unknown, label: string): number {
  const result = integer(value, 0, 8_640_000_000_000_000, label);
  if (!Number.isFinite(new Date(result).getTime())) fail(label);
  return result;
}
function u64(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > U64_MAX) fail(label);
  return value;
}
function nullableU64(value: unknown, label: string): string | null { return value === null ? null : u64(value, label); }
function id(value: unknown, label: string): string {
  const result = text(value, 128, label, true);
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail(label);
  return result;
}
function principal(value: unknown, label: string): string {
  const result = text(value, 63, label, true);
  try {
    if (Principal.fromText(result).toText() !== result || result === "2vxsx-fae" || result === "aaaaa-aa") fail(label);
  } catch { fail(label); }
  return result;
}
function list(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(label);
  return value;
}

/** A deep canonical encoding makes fingerprints independent of JSON object key ordering. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function fingerprint(value: unknown): string {
  return Array.from(sha256(encoder.encode(canonical(value))), byte => byte.toString(16).padStart(2, "0")).join("");
}

function entryPayload(value: unknown): EntryPayload {
  const p = record(value, ENTRY_FIELDS, ["ts", "kind", "currency", "amount_minor", "direction", "note"], "entry fields");
  // decodeEntry owns the existing monetary, date, fee-net and schedule-sum invariants.
  // Exact nested fields prevent credentials/unknown extensions hitchhiking in an archive.
  if (p.schedule !== undefined) for (const portion of list(p.schedule, 100, "entry schedule")) exact(portion, ["due_ts", "percent"], "entry schedule fields");
  if (p.fee !== undefined) record(p.fee, ["percent", "fixed_minor", "fixed_currency", "gross_amount_minor"], ["percent", "gross_amount_minor"], "entry fee fields");
  if (p.convert !== undefined) exact(p.convert, ["from_currency", "from_amount_minor", "to_currency", "to_amount_minor", "rate", "rate_source", "rate_fetched_at"], "entry conversion fields");
  if (p.draft_id !== undefined) text(p.draft_id, 1_024, "draft identifier");
  if (p.import_message_id !== undefined) text(p.import_message_id, 1_024, "import identifier");
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.byteLength > SHEET_BACKUP_LIMITS.payloadBytes) fail("entry payload is too large");
  try { return decodeEntry(bytes); } catch { fail("entry amount, date, direction, fee, schedule or conversion"); }
}

function templates(value: unknown): TxnTemplate[] {
  const rows = list(value, SHEET_BACKUP_LIMITS.types, "Type count");
  const ids = new Set<string>();
  const candidates = rows.map(raw => {
    const t = record(raw, TEMPLATE_FIELDS, ["id", "name", "direction", "txn_type"], "Type fields");
    const typeId = text(t.id, 128, "Type identifier", true);
    if (ids.has(typeId)) fail("duplicate Type identifier");
    ids.add(typeId);
    if (t.schedule !== undefined) for (const portion of list(t.schedule, 100, "Type schedule")) record(portion, ["offset_days", "percent", "anchor"], ["offset_days", "percent"], "Type schedule fields");
    return { ...t, rev: 1, updatedAt: 0 };
  });
  const decoded = decodePairSlotStrict(encoder.encode(JSON.stringify({ v: 2, templates: candidates, dismissed: [] })));
  if (!decoded || decoded.templates.length !== rows.length) fail("Type definitions or encrypted-slot size limit");
  return decoded.templates.map(({ rev: _rev, updatedAt: _updatedAt, deleted: _deleted, ...type }) => type);
}

function validate(value: unknown): SheetBackup {
  const root = exact(value, ["format", "version", "protection", "exportedAt", "source", "accountName", "sheetName", "metadata", "types", "entries"], "top-level fields");
  if (root.format !== SHEET_BACKUP_FORMAT || root.version !== SHEET_BACKUP_VERSION || root.protection !== "unencrypted") fail("unsupported format, version or protection");
  const source = exact(root.source, ["backendCanisterId", "accountId", "sheetId", "exporterPrincipal"], "source fields");
  const metadata = exact(root.metadata, ["state", "closingWindowDays", "createdAtNs", "closedAtNs", "accountArchivedAtNs", "lastEntryAtNs", "closingBalances"], "sheet metadata fields");
  if (metadata.state !== "active" && metadata.state !== "closed") fail("sheet state");
  const closedAtNs = nullableU64(metadata.closedAtNs, "sheet closing timestamp");
  if ((metadata.state === "active") !== (closedAtNs === null)) fail("sheet closing state");
  const balanceCurrencies = new Set<string>();
  const closingBalances = metadata.closingBalances === null ? null : list(metadata.closingBalances, 256, "closing balances").map(raw => {
    const balance = exact(raw, ["currency", "amount_minor"], "closing balance fields");
    const currency = text(balance.currency, 3, "closing balance currency");
    if (!/^[A-Za-z]{3}$/.test(currency) || balanceCurrencies.has(currency.toUpperCase())) fail("closing balance currency");
    balanceCurrencies.add(currency.toUpperCase());
    return { currency, amount_minor: integer(balance.amount_minor, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, "closing balance amount") };
  });
  let historyCount = 0;
  const entryIds = new Set<string>();
  const entries = list(root.entries, SHEET_BACKUP_LIMITS.entries, "entry count").map(raw => {
    const entry = exact(raw, ["id", "authorPrincipal", "createdAtNs", "updatedAtNs", "deletedAtNs", "payload", "history"], "entry record fields");
    const entryId = u64(entry.id, "source entry identifier");
    if (entryIds.has(entryId)) fail("duplicate source entry identifier");
    entryIds.add(entryId);
    const history = list(entry.history, SHEET_BACKUP_LIMITS.historyPerEntry, "entry history count").map(rawVersion => {
      if (++historyCount > SHEET_BACKUP_LIMITS.totalHistory) fail("total history count");
      const version = exact(rawVersion, ["replacedAtNs", "payload"], "history fields");
      return { replacedAtNs: u64(version.replacedAtNs, "history timestamp"), payload: entryPayload(version.payload) };
    });
    return {
      id: entryId,
      authorPrincipal: principal(entry.authorPrincipal, "entry author principal"),
      createdAtNs: u64(entry.createdAtNs, "entry server timestamp"),
      updatedAtNs: nullableU64(entry.updatedAtNs, "entry update timestamp"),
      deletedAtNs: nullableU64(entry.deletedAtNs, "entry deletion timestamp"),
      payload: entryPayload(entry.payload), history,
    };
  });
  return {
    format: SHEET_BACKUP_FORMAT, version: SHEET_BACKUP_VERSION, protection: "unencrypted",
    exportedAt: date(root.exportedAt, "export timestamp"),
    source: {
      backendCanisterId: principal(source.backendCanisterId, "backend canister identifier"),
      accountId: id(source.accountId, "source account identifier"),
      sheetId: id(source.sheetId, "source sheet identifier"),
      exporterPrincipal: principal(source.exporterPrincipal, "exporting principal"),
    },
    accountName: text(root.accountName, SHEET_BACKUP_LIMITS.nameLength, "account name"),
    sheetName: text(root.sheetName, SHEET_BACKUP_LIMITS.nameLength, "sheet name"),
    metadata: {
      state: metadata.state,
      closingWindowDays: integer(metadata.closingWindowDays, 30, 730, "closing window"),
      createdAtNs: u64(metadata.createdAtNs, "sheet creation timestamp"), closedAtNs,
      accountArchivedAtNs: nullableU64(metadata.accountArchivedAtNs, "account archive timestamp"),
      lastEntryAtNs: nullableU64(metadata.lastEntryAtNs, "last-entry timestamp"), closingBalances,
    },
    types: templates(root.types), entries,
  };
}

/** Input must include all successfully decrypted current/deleted rows AND all history versions.
 * The collecting adapter must fail on unreadable records or incomplete pagination, not omit them.
 */
export function buildSheetBackup(input: SheetBackupInput): SheetBackup {
  const value = validate({ ...input, format: SHEET_BACKUP_FORMAT, version: SHEET_BACKUP_VERSION, protection: "unencrypted" });
  if (encoder.encode(JSON.stringify(value)).byteLength > SHEET_BACKUP_LIMITS.bytes) fail("file is too large");
  return value;
}

export function parseSheetBackup(textValue: string): SheetBackup {
  if (typeof textValue !== "string" || textValue.length > SHEET_BACKUP_LIMITS.bytes ||
    encoder.encode(textValue).byteLength > SHEET_BACKUP_LIMITS.bytes) fail("file is too large");
  let parsed: unknown;
  try { parsed = JSON.parse(textValue); } catch { fail("JSON syntax"); }
  return validate(parsed);
}

export function serializeSheetBackup(backup: SheetBackup): string {
  const validated = validate(backup);
  const serialized = JSON.stringify(validated);
  if (encoder.encode(serialized).byteLength > SHEET_BACKUP_LIMITS.bytes) fail("file is too large");
  return serialized;
}

/** No actor calls: caller must preview/approve, check destination eligibility and encrypt writes.
 * The content fingerprint is idempotency scope, NOT a signature or proof of source ownership.
 */
export function planSheetImport(input: SheetBackup): SheetImportPlan {
  const backup = parseSheetBackup(serializeSheetBackup(input));
  const backupId = fingerprint(backup);
  const typeIdMap = backup.types.map((type, index) => ({ sourceId: type.id, targetId: `backup-${backupId.slice(0, 40)}-${index}` }));
  const types = backup.types.map((type, index) => ({ ...type, id: typeIdMap[index].targetId }));
  // Ensure remapping cannot make otherwise valid Types exceed the destination slot's limit.
  const slotBytes = encodePairSlot(types.map(type => ({ ...type, rev: 1, updatedAt: backup.exportedAt })));
  // The backend's 64,000-byte ciphertext cap includes the 16-byte AES-GCM tag.
  if (slotBytes.byteLength > 63_984 || !decodePairSlotStrict(slotBytes)) fail("remapped Types exceed destination slot size");
  const entries = backup.entries.filter(entry => entry.deletedAtNs === null).map(entry => {
    const sameAuthor = entry.authorPrincipal === backup.source.exporterPrincipal;
    const { draft_id: _oldDraft, import_message_id: _oldMessage, ...payload } = orientPayload(entry.payload, sameAuthor);
    const imported = { ...payload, draft_id: `backup:${backupId}:${entry.id}` };
    return { sourceEntryId: entry.id, sourceAuthor: sameAuthor ? "exporter" as const : "other" as const, payload: entryPayload(imported) };
  });
  return {
    backupId, accountName: backup.accountName, sheetName: backup.sheetName,
    closingWindowDays: backup.metadata.closingWindowDays, types, typeIdMap, entries,
    summary: {
      currentEntries: entries.length,
      deletedEntries: backup.entries.length - entries.length,
      historyVersions: backup.entries.reduce((count, entry) => count + entry.history.length, 0),
      types: types.length,
    },
    limitations: SHEET_IMPORT_LIMITATIONS,
  };
}
