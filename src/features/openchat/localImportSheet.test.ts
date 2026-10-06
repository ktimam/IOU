import { describe, expect, it } from "vitest";
import { createLocalImportSaveLock, localImportRecipient, localImportSheetDrafts } from "./localImportSheet";
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
    expect(() => localImportSheetDrafts([{ ...row, date: undefined }], [], importId)).toThrow(/date/);
    expect(() => localImportSheetDrafts([{ ...row, typeId: "missing", typeName: "Missing" }], [], importId)).toThrow(/Reconnect IOU/);
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
});
