import type { EntryPayload } from "../entries/types";
import { decodeEntry, encodeEntry } from "../entries/types";
import { formatMinor, netAfterFee } from "../entries/balance";
import type { ParsedDraft } from "../entries/draft";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { encodeIouDeliveryContext, localDeliveryDecode, type IouDeliveryContext } from "./localImportEncryption";
import { initializeLocalImportReviewRow, prepareLocalImportReview } from "./localImportReview";
import { isLocalImportId, parseLocalImportPayload, type LocalImportDraft } from "./localImportHandoff";
import { resolveTemplateSchedule, templateToInitial } from "../templates/templateBase";

/** Only these locally-authored correction messages are safe to show verbatim. */
export class LocalImportReviewError extends Error {}

/** Routing metadata is untrusted until membership and authenticated decryption also pass. */
export function localImportRecipient(encoded: string, expected: Pick<IouDeliveryContext, "principal" | "backendHost" | "backendCanisterId">): IouDeliveryContext {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(localDeliveryDecode(encoded, 1, 1536)));
  if (!Array.isArray(value) || value.length !== 6 || value[0] !== 1 || value.slice(1).some(item => typeof item !== "string")) {
    throw new Error("This draft has an invalid IOU destination. Reconnect it in OpenChat.");
  }
  const [, principal, backendHost, backendCanisterId, pairId, sheetId] = value as [number, string, string, string, string, string];
  const context = { principal, backendHost, backendCanisterId, pairId, sheetId };
  if (encodeIouDeliveryContext(context) !== encoded || principal !== expected.principal ||
      backendHost !== expected.backendHost || backendCanisterId !== expected.backendCanisterId) {
    throw new Error("Sign in to the IOU account linked in OpenChat. This draft cannot be opened in another account.");
  }
  return Object.freeze(context);
}

/** Feed the existing EntryForm/BatchConfirmModal without reparsing reviewed text or guessing dates. */
export function localImportSheetDrafts(rows: readonly LocalImportDraft[], templates: readonly TxnTemplate[], importId: string): ParsedDraft[] {
  const checked = parseLocalImportPayload({ entries: rows.map(row => ({ ...row })) });
  if (!checked || !isLocalImportId(importId)) throw new LocalImportReviewError("The received entries are invalid. Nothing was saved.");
  const reviewed = checked.entries.map(row => initializeLocalImportReviewRow(row, templates));
  if (reviewed.some(row => row.selectedTypeId === null)) throw new LocalImportReviewError("The card's Type is no longer available in this account. Reconnect IOU in OpenChat and create a new proposal; nothing was saved.");
  return reviewed.map(({ row, selectedTypeId }, index) => {
    const draftId = `local:${importId}:${index}`;
    if (row.date) {
      const payload = prepareLocalImportReview({ rows: [row], selectedTypeIds: [selectedTypeId], templates, importId })[0];
      return { initial: { ...payload, draft_id: draftId }, draftId,
        summary: `${formatMinor(payload.fee?.gross_amount_minor ?? payload.amount_minor, payload.currency)} · ${payload.direction === "debt" ? "You owe" : "Owed to you"} · ${row.date}${payload.note ? ` · ${payload.note}` : ""}` };
    }
    const matches = selectedTypeId ? templates.filter(item => item.id === selectedTypeId) : [];
    if (selectedTypeId && matches.length !== 1) throw new LocalImportReviewError("The selected Type is not available in this IOU account.");
    const template = matches[0];
    // Fees do not depend on a date. Do not call the template's default-today schedule
    // resolver for an incomplete import; keep its relative schedule for explicit review.
    const defaults = template ? templateToInitial({ ...template, schedule: undefined }) : undefined;
    const gross = Math.round(row.amount * 100);
    const fee = row.kind === "iou" && defaults?.fee ? { ...defaults.fee, gross_amount_minor: gross } : undefined;
    const fixed = fee?.fixed_currency && fee.fixed_currency !== row.currency ? 0 : fee?.fixed_minor ?? 0;
    return { initial: {
      kind: row.kind === "iou" ? "expense" : "payment", txn_type: row.kind,
      currency: row.currency, direction: row.direction, note: row.note ?? "", draft_id: draftId,
      amount_minor: fee ? netAfterFee(gross, fee.percent, fixed) : gross, ...(fee ? { fee } : {}),
    }, draftId, reviewDate: { ...(row.kind === "iou" && template?.txn_type === "iou" && template.schedule?.length
      ? { schedule: template.schedule.map(portion => ({ ...portion })) } : {}) },
    summary: `${formatMinor(gross, row.currency)} · ${row.direction === "debt" ? "You owe" : "Owed to you"}${row.note ? ` · ${row.note}` : ""}` };
  });
}

/** Batch correction preserves every row/ID and never defaults an absent date to today. */
export function setLocalImportReviewDate(draft: ParsedDraft, date: string): ParsedDraft {
  if (!draft.reviewDate) throw new Error("This entry does not need a missing-date correction.");
  const { ts: _ts, schedule: _schedule, ...initial } = draft.initial;
  if (!date) return { ...draft, initial };
  const ts = Date.parse(`${date}T00:00:00Z`);
  if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(ts) || new Date(ts).toISOString().slice(0, 10) !== date) {
    throw new Error("Choose a valid date for this entry.");
  }
  const payload = decodeEntry(encodeEntry({ ...initial, ts, ...(initial.txn_type === "iou" ? {
    schedule: draft.reviewDate.schedule?.length ? resolveTemplateSchedule(draft.reviewDate.schedule, ts) : [{ due_ts: ts, percent: 100 }],
  } : {}) } as EntryPayload));
  return { ...draft, initial: payload };
}

/** The sheet owns presentation; the authenticated receiver owns transport and exact-ID saving. */
export type LocalSheetImport = Readonly<{
  sheetId: string;
  pairId: string;
  importId: string;
  drafts: readonly ParsedDraft[];
  ready: boolean;
  saved: boolean;
  notice: string;
  assertCurrent: () => void;
  save: (payloads: readonly EntryPayload[]) => Promise<void>;
  dismiss: () => void;
}>;

/** Lock final entry contents before an attempted write; changed retries are never sent. */
export function createLocalImportSaveLock(importId: string, count: number) {
  let canonical: string | undefined;
  return (input: readonly EntryPayload[]): EntryPayload[] => {
    if (input.length !== count) throw new Error("The reviewed entry count changed. Nothing was sent.");
    const payloads = input.map((payload, index) => decodeEntry(encodeEntry({
      ...payload, draft_id: `local:${importId}:${index}`, import_message_id: importId,
    })));
    const next = JSON.stringify(payloads);
    if (canonical !== undefined && canonical !== next) {
      throw new Error("A save was already attempted. Check the sheet and retry only the same reviewed fields; do not create another proposal.");
    }
    canonical = next;
    return payloads;
  };
}
