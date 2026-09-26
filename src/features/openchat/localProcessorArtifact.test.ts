import { describe, expect, it } from "vitest";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext, parseLocalProcessorContext } from "./localProcessorContext";

describe("standalone IOU local processor export", () => {
  it("normalizes a raw image and composes the full source range into the visible note", () => {
    expect(processLocalArtifactRequest({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", input: {
      operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 6, 3), candidates: [{
        heading: "Reservation", total_text: "Total Payout $1,912.15", dates: ["Sun, Jul 19", "Thu, Aug 6"], kind: "iou",
      }],
    } })).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 1912.15, currency: "USD", direction: "credit", kind: "iou", date: "2026-07-19",
      note: "Reservation | From Sun, Jul 19 to Thu, Aug 6",
    }] });
  });
  it("does not transmit raw source or arbitrary fields and rejects wrong actions", () => {
    const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", input: {
      operation: "normalize", modality: "text", text: "owe 20 USD", candidates: [{
        amount: 20, currency: "USD", kind: "iou", direction: "debt", note: "Lunch", message: "owe 20 USD", hidden: "secret",
      }],
    } };
    expect(processLocalArtifactRequest(request)).toEqual({ kind: "candidates", candidates: [{
      amount: 20, currency: "USD", kind: "iou", direction: "debt", note: "Lunch",
    }] });
    expect(processLocalArtifactRequest({ ...request, actionId: "other" })).toEqual({ kind: "error" });
  });
  it("exports explicit config without legacy delivery permissions/endpoints", () => {
    const catalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "a".repeat(64), byteLength: 1234 });
    expect(catalog.apps[0].actions[0].definition).not.toHaveProperty("endpoint");
    expect(catalog.apps[0]).not.toHaveProperty("surfaces");
    expect(catalog.apps[0].actions[0].definition.responseSchema).toHaveProperty("x-openchat-image-prompt-by-model");
    expect(catalog.apps[0].actions[0].handoff).toEqual({ kind: "wrapped-list", field: "entries" });
    expect(() => createIouLocalAppPackage("https://iou.example/openchat/import?payload=private", { sha256: "a".repeat(64), byteLength: 1234 })).toThrow();
  });
  it("uses only the explicitly exported private account vocabulary and currency", () => {
    const context = createLocalProcessorContext([{ id: "t1", name: "Stay", keywords: ["booking"], direction: "debt", txn_type: "iou", fee_percent: 50 }], "EGP");
    expect(JSON.stringify(context)).not.toContain("fee");
    expect(Object.isFrozen(context.types[0])).toBe(true);
    const result = processLocalArtifactRequest({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context, input: {
      operation: "normalize", modality: "text", text: "booking 20", candidates: [{ kind: "iou", amount: 20, note: "booking" }],
    } });
    expect(result).toMatchObject({ kind: "candidates", candidates: [{ amount: 20, currency: "EGP", direction: "debt", typeId: "t1", typeName: "Stay" }] });
    expect((result as { candidates: unknown[] }).candidates[0]).not.toHaveProperty("date");
    const catalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "a".repeat(64), byteLength: 1234 }, { processorContext: context, recipientLabel: "Sheet to review" });
    expect(catalog.apps[0].recipientLabel).toBe("Sheet to review");
    expect(catalog.apps[0].actions[0].processorContext).toEqual(context);
    const publicCatalog = createIouLocalAppPackage("http://localhost:3000/openchat/import", { sha256: "a".repeat(64), byteLength: 1234 });
    expect(publicCatalog.apps[0].actions[0]).not.toHaveProperty("processorContext");
  });
  it("rejects unknown private context fields, duplicate types and oversized vocabulary", () => {
    const context = { version: 1, types: [{ id: "t1", name: "Stay", keywords: [], direction: "debt", txn_type: "iou" }] };
    expect(parseLocalProcessorContext({ ...context, accountKey: "secret" })).toBeUndefined();
    expect(parseLocalProcessorContext({ ...context, types: [...context.types, ...context.types] })).toBeUndefined();
    expect(parseLocalProcessorContext({ ...context, defaultCurrency: "invalid" })).toBeUndefined();
    expect(parseLocalProcessorContext({ ...context, types: [{ ...context.types[0], keywords: ["x".repeat(129)] }] })).toBeUndefined();
  });
});
