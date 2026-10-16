import { describe, expect, it } from "vitest";
import { createLocalImportSaveLock, localImportRecipient, localImportSheetDrafts, setLocalImportReviewDate } from "./localImportSheet";
import { encodeIouDeliveryContext, localDeliveryBase64Url } from "./localImportEncryption";
import type { EntryPayload } from "../entries/types";

const context = { principal: "synthetic-user", backendHost: "http://localhost:4943", backendCanisterId: "synthetic-backend", pairId: "0000000000000001", sheetId: "0000000000000002" };
const importId = "B".repeat(42) + "A";
const row = { amount: 44.45, currency: "USD", date: "2026-10-06", direction: "debt" as const, kind: "iou" as const, note: "Synthetic review" };
const encoded = encodeIouDeliveryContext(context);

describe("addressed IOU sheet selection", () => {
  it("decodes only canonical routing for this signed-in recipient/backend", () => {
    expect(localImportRecipient(encoded, context)).toEqual(context);
  });
  it.each([
    { principal: "another-user" }, { backendHost: "https://another.example" }, { backendCanisterId: "another-backend" },
  ])("rejects a different recipient context %j", change => {
    expect(() => localImportRecipient(encoded, { ...context, ...change })).toThrow(/linked in OpenChat/);
  });
  it.each(["!", "A", "AA", localDeliveryBase64Url(new TextEncoder().encode('[1,"synthetic-user"]'))])("rejects malformed metadata %s", input => {
    expect(() => localImportRecipient(input, context)).toThrow();
  });
  it("does not accept noncanonical extra context fields or invalid sheet IDs", () => {
    const encode = (value: unknown) => localDeliveryBase64Url(new TextEncoder().encode(JSON.stringify(value)));
    expect(() => localImportRecipient(encode([1, context.principal, context.backendHost, context.backendCanisterId, context.pairId, context.sheetId, "extra"]), context)).toThrow();
    expect(() => localImportRecipient(encode([1, context.principal, context.backendHost, context.backendCanisterId, context.pairId, "../other"]), context)).toThrow();
  });
});

describe("normal PR review defaults", () => {
  it("preserves reviewed fields and stable row IDs for the existing EntryForm", () => {
    const [draft] = localImportSheetDrafts([row], [], importId);
    expect(draft.initial).toMatchObject({ amount_minor: 4445, currency: "USD", direction: "debt", txn_type: "iou", note: row.note, ts: Date.parse("2026-10-06T00:00:00Z"), draft_id: `local:${importId}:0` });
    expect(draft.summary).toContain("You owe");
    expect(draft.summary).toContain("2026-10-06");
  });
  it("uses current Type fees without overriding the sender-reviewed direction", () => {
    const type = { id: "own", name: "My Type", direction: "credit" as const, txn_type: "iou" as const, keywords: [], fee_percent: 10, rev: 1, updatedAt: 1 };
    const [draft] = localImportSheetDrafts([{ ...row, amount: 100, typeId: "own", typeName: "My Type" }], [type], importId);
    expect(draft.initial).toMatchObject({ amount_minor: 9000, direction: "debt", fee: { gross_amount_minor: 10000, percent: 10 } });
  });
  it("keeps multi-entry order and stable individual IDs for BatchConfirmModal", () => {
    const drafts = localImportSheetDrafts([row, { ...row, amount: 22.22 }], [], importId);
    expect(drafts.map(draft => draft.initial.amount_minor)).toEqual([4445, 2222]);
    expect(drafts.map(draft => draft.draftId)).toEqual([`local:${importId}:0`, `local:${importId}:1`]);
  });
  it("does not guess a missing date or silently apply an unknown Type", () => {
    const { date: _date, ...missing } = row;
    const [draft] = localImportSheetDrafts([missing], [], importId);
    expect(draft.initial).not.toHaveProperty("ts");
    expect(draft.initial).not.toHaveProperty("schedule");
    expect(draft.reviewDate).toEqual({});
    expect(draft.initial).toMatchObject({ amount_minor: 4445, currency: "USD", note: row.note });
    expect(() => localImportSheetDrafts([{ ...row, typeId: "missing", typeName: "Missing" }], [], importId)).toThrow(/Reconnect IOU/);
  });
  it("keeps incomplete rows in a mixed batch and only resolves Type dates after explicit correction", () => {
    const type = { id: "own", name: "My Type", direction: "credit" as const, txn_type: "iou" as const,
      fee_percent: 10, schedule: [{ offset_days: 2, percent: 40 }, { offset_days: 0, percent: 60, anchor: "start_of_next_month" as const }] };
    const { date: _date, ...missing } = row;
    const drafts = localImportSheetDrafts([row, { ...missing, amount: 100, typeId: type.id, typeName: type.name }], [type], importId);
    expect(drafts).toHaveLength(2);
    expect(drafts[1].initial).toMatchObject({ amount_minor: 9000, fee: { gross_amount_minor: 10000 }, draft_id: `local:${importId}:1` });
    expect(drafts[1].initial).not.toHaveProperty("ts");
    const corrected = setLocalImportReviewDate(drafts[1], "2026-12-30");
    expect(corrected.initial).toMatchObject({ ts: Date.UTC(2026, 11, 30), schedule: [
      { due_ts: Date.UTC(2027, 0, 1), percent: 40 }, { due_ts: Date.UTC(2027, 0, 1), percent: 60 }],
      amount_minor: 9000, direction: "debt", draft_id: `local:${importId}:1` });
    expect(setLocalImportReviewDate(corrected, "").initial).not.toHaveProperty("ts");
    expect(drafts[1].initial).not.toHaveProperty("ts");
    expect(() => setLocalImportReviewDate(drafts[1], "2026-02-30")).toThrow(/valid date/);
    expect(() => setLocalImportReviewDate(drafts[1], "0000-01-01")).toThrow(/valid date/);
  });
  it("rejects invalid amount, currency, date or context rather than dropping a row", () => {
    for (const change of [{ amount: -1 }, { currency: "" }, { date: "2026-02-30" }]) {
      expect(() => localImportSheetDrafts([row, { ...row, ...change }], [], importId)).toThrow();
    }
    expect(() => localImportSheetDrafts([row], [], "invalid")).toThrow();
  });
  it("rejects ambiguous Type IDs equally for dated and undated review", () => {
    const selected = { id: "same", name: "Matched", direction: "credit" as const, txn_type: "iou" as const, fee_percent: 10 };
    const templates = [{ ...selected, name: "Other", fee_percent: 50 }, selected];
    const { date: _date, ...missing } = row;
    for (const input of [row, missing]) {
      expect(() => localImportSheetDrafts([{ ...input, typeId: "same", typeName: "Matched" }], templates, importId)).toThrow(/Type/);
    }
  });
});

describe("final save retry lock", () => {
  const initial = () => localImportSheetDrafts([row], [], importId)[0].initial as EntryPayload;
  it("reuses the same request and entry identities, with no hidden caller-supplied identity", () => {
    const lock = createLocalImportSaveLock(importId, 1);
    const result = lock([{ ...initial(), draft_id: "foreign", import_message_id: "foreign" }]);
    expect(result[0]).toMatchObject({ draft_id: `local:${importId}:0`, import_message_id: importId });
    expect(lock([initial()])).toEqual(result);
  });
  it("rejects changed retries and count changes after an unknown outcome", () => {
    const lock = createLocalImportSaveLock(importId, 1);
    lock([initial()]);
    expect(() => lock([{ ...initial(), note: "Changed" }])).toThrow(/save was already attempted/);
    expect(() => lock([])).toThrow(/entry count changed/);
  });
  it("copies inputs, so later edits cannot mutate an already reviewed attempt", () => {
    const payload = { ...initial() }, lock = createLocalImportSaveLock(importId, 1);
    const [locked] = lock([payload]);
    payload.note = "Later edit";
    expect(locked.note).toBe(row.note);
    expect(() => lock([payload])).toThrow();
  });
  it("refuses an incomplete date before locking, then allows the same corrected entry", () => {
    const { date: _date, ...missing } = row;
    const [draft] = localImportSheetDrafts([missing], [], importId), lock = createLocalImportSaveLock(importId, 1);
    expect(() => lock([draft.initial as EntryPayload])).toThrow(/invalid entry payload/);
    const corrected = setLocalImportReviewDate(draft, "2026-10-07").initial as EntryPayload;
    expect(lock([corrected])[0]).toMatchObject({ ts: Date.UTC(2026, 9, 7), import_message_id: importId });
  });
});
