import { buildEntryPayload } from "../entries/entryMath";
import { decodeEntry, encodeEntry, type EntryPayload } from "../entries/types";
import { templateToInitial } from "../templates/templateBase";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { isLocalImportId, parseLocalImportPayload, type LocalImportDraft } from "./localImportHandoff";

/** Explicit user selection may change these visible controls; never infer a private Type by id. */
export function applyLocalImportType(row: LocalImportDraft, selectedId: string, templates: readonly TxnTemplate[]): LocalImportDraft {
  if (!selectedId) return row;
  const matches = templates.filter((item) => item.id === selectedId);
  if (matches.length !== 1) throw new Error("The selected Type is not available in this IOU account.");
  const selected = matches[0];
  return { ...row, kind: selected.txn_type, direction: selected.direction };
}

/** Build the exact final encrypted payload preview. Never guess missing dates or currencies. */
export function prepareLocalImportReview(options: {
  rows: readonly LocalImportDraft[];
  selectedTypeIds: readonly (string | null)[];
  templates: readonly TxnTemplate[];
  importId: string;
}): readonly EntryPayload[] {
  if (!isLocalImportId(options.importId) || options.selectedTypeIds.length !== options.rows.length) {
    throw new Error("Invalid import review context.");
  }
  const checked = parseLocalImportPayload({ entries: options.rows.map((row) => ({ ...row })) });
  if (!checked) throw new Error("Check every amount, currency, date, direction and note before reviewing.");
  return Object.freeze(checked.entries.map((row, index) => {
    if (!row.date) throw new Error(`Choose the date for entry ${index + 1}; IOU will not guess it.`);
    const selectedId = options.selectedTypeIds[index];
    if (selectedId === null) throw new Error(`Choose a current Type or explicitly select None for entry ${index + 1}.`);
    const matches = selectedId ? options.templates.filter((item) => item.id === selectedId) : [];
    if (selectedId && matches.length !== 1) throw new Error("The selected Type is not available in this IOU account.");
    const template = matches[0];
    const defaults = template ? templateToInitial(template, Date.parse(`${row.date}T00:00:00Z`)) : undefined;
    const built = buildEntryPayload({
      amountStr: String(row.amount), currency: row.currency, direction: row.direction,
      note: row.note ?? "", dateYmd: row.date, txnType: row.kind,
      feePercent: defaults?.fee?.percent ?? 0,
      feeFixedStr: String((defaults?.fee?.fixed_minor ?? 0) / 100),
      feeFixedCurrency: defaults?.fee?.fixed_currency ?? row.currency,
      schedule: defaults?.schedule?.map((item) => ({ date: new Date(item.due_ts).toISOString().slice(0, 10), percent: item.percent })) ?? [{ date: row.date, percent: 100 }],
      draftId: `local:${options.importId}:${index}`,
    });
    if (!built.ok) throw new Error(built.error);
    // Existing storage decoder rejects malformed schedule/fee/date/default data. JSON cloning also
    // removes only undefined implementation properties, so the preview is the exact stored object.
    const payload = decodeEntry(encodeEntry(built.payload));
    if (payload.schedule) { payload.schedule.forEach(Object.freeze); Object.freeze(payload.schedule); }
    if (payload.fee) Object.freeze(payload.fee);
    return Object.freeze(payload);
  }));
}
