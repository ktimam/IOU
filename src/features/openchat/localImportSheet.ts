import type { EntryPayload } from "../entries/types";
import { decodeEntry, encodeEntry } from "../entries/types";
import { formatMinor } from "../entries/balance";
import type { ParsedDraft } from "../entries/draft";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { encodeIouDeliveryContext, localDeliveryDecode, type IouDeliveryContext } from "./localImportEncryption";
import { initializeLocalImportReviewRow, prepareLocalImportReview } from "./localImportReview";
import type { LocalImportDraft } from "./localImportHandoff";

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
  const reviewed = rows.map(row => initializeLocalImportReviewRow(row, templates));
  if (rows.some(row => !row.date)) throw new LocalImportReviewError("A date is missing. Set a date in the OpenChat card and send it again; nothing was saved in IOU.");
  if (reviewed.some(row => row.selectedTypeId === null)) throw new LocalImportReviewError("The card's Type is no longer available in this account. Reconnect IOU in OpenChat and create a new proposal; nothing was saved.");
  const payloads = prepareLocalImportReview({ rows, selectedTypeIds: reviewed.map(row => row.selectedTypeId), templates, importId });
  return payloads.map((payload, index) => ({
    initial: payload,
    draftId: `local:${importId}:${index}`,
    summary: `${formatMinor(payload.fee?.gross_amount_minor ?? payload.amount_minor, payload.currency)} · ${payload.direction === "debt" ? "You owe" : "Owed to you"} · ${new Date(payload.ts).toISOString().slice(0, 10)}${payload.note ? ` · ${payload.note}` : ""}`,
  }));
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
