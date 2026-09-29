import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext, parseLocalProcessorContext } from "./localProcessorContext";

describe("standalone IOU local processor export", () => {
  it("ships the verified compiled processor with the same kind-preserving behavior", () => {
    const source = readFileSync(new URL("../../../public/openchat/local-processor-v1.js", import.meta.url));
    const metadata = JSON.parse(readFileSync(new URL("../../../public/openchat/local-processor-v1.sha256.json", import.meta.url), "utf8"));
    const catalog = JSON.parse(readFileSync(new URL("../../../public/openchat/local-app-v1.json", import.meta.url), "utf8"));
    expect(createHash("sha256").update(source).digest("hex")).toBe(metadata.sha256);
    expect(source.byteLength).toBe(metadata.byteLength);
    expect(catalog.apps[0].processor).toEqual({ sha256: metadata.sha256, byteLength: metadata.byteLength });
    for (const kind of ["iou", "settlement"] as const) {
      const context = createLocalProcessorContext([{ id: "synthetic-kind", name: "Synthetic booking",
        keywords: ["booking"], direction: "debt", txn_type: kind === "iou" ? "settlement" : "iou" }], "USD");
      const request = { type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context,
        input: { operation: "normalize", modality: "text", text: "booking 20 USD",
          candidates: [{ kind, amount: 20, currency: "USD", direction: "credit", note: "booking" }] } };
      let listener: ((event: { data: unknown }) => void) | undefined;
      const replies: unknown[] = [];
      // Execute the actual shipped worker, without any network capability or app account.
      const worker = createContext({ TextEncoder, TextDecoder, requestJson: JSON.stringify(request),
        dispatch: (event: { data: unknown }) => listener!(event), self: {
        addEventListener: (_name: string, handler: typeof listener) => { listener = handler; },
        postMessage: (value: unknown) => replies.push(JSON.parse(JSON.stringify(value))),
      } });
      runInContext(source.toString("utf8"), worker, { timeout: 1000 });
      expect(listener).toBeTypeOf("function");
      // Real postMessage clones into the worker realm; do not pass foreign VM prototypes.
      runInContext("dispatch({ data: JSON.parse(requestJson) }); dispatch({ data: JSON.parse(requestJson) });", worker, { timeout: 1000 });
      expect(replies).toEqual([processLocalArtifactRequest(request)]);
      expect(replies[0]).toMatchObject({ kind: "candidates", candidates: [{ kind, direction: "debt" }] });
    }
  });
  it.each(["iou", "settlement"] as const)("preserves extracted %s kind when a different saved Type matches", (kind) => {
    const context = createLocalProcessorContext([{ id: "synthetic-kind", name: "Synthetic booking",
      keywords: ["booking"], direction: "debt", txn_type: kind === "iou" ? "settlement" : "iou" }], "USD");
    const result = processLocalArtifactRequest({ type: "oc:local-process:request", version: 1,
      actionId: "iou.entry.import", context, input: {
        operation: "normalize", modality: "text", text: "booking 20 USD", candidates: [{
          kind, amount: 20, currency: "USD", direction: "credit", note: "booking",
        }],
      } });
    expect(result).toMatchObject({ kind: "candidates", candidates: [{
      kind, direction: "debt", typeId: "synthetic-kind", typeName: "Synthetic booking",
    }] });
  });
  it("rejects conflicting acceptance-label dates but accepts the same text with one transaction date", () => {
    const context = createLocalProcessorContext([{ id: "synthetic-acceptance", name: "Synthetic acceptance",
      direction: "debt", txn_type: "iou", keywords: ["TEST ONLY"] }], "USD");
    const text = "TEST ONLY — OpenChat IOU acceptance 2026-09-29\nAmount: 123.45 USD\nDate: 27 September 2026\nDirection: You owe\nNote: Synthetic acceptance; not a real balance.";
    const request = (sourceText: string, privateContext = context) => ({
      type: "oc:local-process:request", version: 1, actionId: "iou.entry.import", context: privateContext,
      input: { operation: "extract", modality: "text", text: sourceText, sourceTimestamp: Date.UTC(2026, 8, 29) },
    });
    expect(processLocalArtifactRequest(request(text))).toEqual({ kind: "ambiguous" });
    // Remove only the run-label date. Do not weaken date ambiguity checks or alter the transaction.
    const singleDate = text.replace(" acceptance 2026-09-29\n", " acceptance\n");
    expect(processLocalArtifactRequest(request(singleDate))).toEqual({ kind: "candidates", candidates: [{
      amount: 123.45, direction: "debt", note: "", currency: "USD", kind: "iou", date: "2026-09-27",
      typeId: "synthetic-acceptance", typeName: "Synthetic acceptance",
    }] });
    // Text cues are sender-relative; the exported matching Type separately supplies its direction.
    const noTypes = createLocalProcessorContext([], "USD");
    expect(processLocalArtifactRequest(request(singleDate, noTypes))).toMatchObject({
      kind: "candidates", candidates: [{ direction: "credit", date: "2026-09-27" }],
    });
    expect(processLocalArtifactRequest(request(singleDate.replace("Direction: You owe", "Direction: I owe"), noTypes))).toMatchObject({
      kind: "candidates", candidates: [{ direction: "debt", date: "2026-09-27" }],
    });
  });
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
