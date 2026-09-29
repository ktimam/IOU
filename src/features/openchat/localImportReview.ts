import { buildEntryPayload } from "../entries/entryMath";
import { decodeEntry, encodeEntry, type EntryPayload } from "../entries/types";
import { templateToInitial } from "../templates/templateBase";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { isLocalImportId, parseLocalImportPayload, type LocalImportDraft } from "./localImportHandoff";

/** Receiver-only interaction state. Never include these flags in the imported or encrypted DTO. */
export interface LocalImportReviewRow {
  row: LocalImportDraft;
  selectedTypeId: string | null;
  directionEdited?: true;
  directionBeforeType?: LocalImportDraft["direction"];
}

export function initializeLocalImportReviewRow(row: LocalImportDraft, templates: readonly TxnTemplate[]): LocalImportReviewRow {
  const matches = row.typeId ? templates.filter((item) => item.id === row.typeId && item.name === row.typeName) : [];
  // The incoming DTO contains the final reviewed direction, not its value before a processor
  // matched a Type. Do not invent that missing history or reapply a possibly changed default.
  return { row: { ...row }, selectedTypeId: row.typeId ? matches.length === 1 ? row.typeId : null : "" };
}

/** A manual direction is authoritative across later Type choices, as in IOU's original card. */
export function editLocalImportDirection(state: LocalImportReviewRow, direction: LocalImportDraft["direction"]): LocalImportReviewRow {
  const { directionBeforeType: _previous, ...rest } = state;
  return { ...rest, row: { ...state.row, direction }, directionEdited: true };
}

/** Apply only a current account-local Type; restore only a receiver-observed prior direction. */
export function applyLocalImportType(state: LocalImportReviewRow, selectedId: string, templates: readonly TxnTemplate[]): LocalImportReviewRow {
  const matches = templates.filter((item) => item.id === selectedId);
  if (selectedId && matches.length !== 1) throw new Error("The selected Type is not available in this IOU account.");
  const { directionBeforeType, ...rest } = state;
  const row = directionBeforeType !== undefined && !state.directionEdited
    ? { ...state.row, direction: directionBeforeType } : state.row;
  if (!selectedId) return { ...rest, row, selectedTypeId: "" };
  const selected = matches[0];
  return {
    ...rest, selectedTypeId: selectedId,
    // Saved-Type defaults must not overwrite the extracted or manually edited kind.
    row: { ...row, ...(!state.directionEdited ? { direction: selected.direction } : {}) },
    ...(!state.directionEdited ? { directionBeforeType: row.direction } : {}),
  };
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
