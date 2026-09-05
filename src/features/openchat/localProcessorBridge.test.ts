import { describe, expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { parseProcessorBootstrap, processIouRequest } from "./localProcessorBridge";

const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const request = (input: unknown) => ({ type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id, input });
describe("IOU owns the local processor", () => {
  it("binds bootstrap and rejects other actions or replayed request ids", () => {
    expect(parseProcessorBootstrap({ type: "oc:app-process:bootstrap", version: 1, ...binding })).toEqual(binding);
    expect(parseProcessorBootstrap({ type: "oc:app-process:bootstrap", version: 1, ...binding, text: "leak" })).toBeUndefined();
    const value = request({ operation: "extract", modality: "text", text: "owe me 20 EGP" });
    expect(processIouRequest({ ...value, actionId: "unknown" }, binding)).toEqual({ kind: "error" });
    expect(processIouRequest({ ...value, requestNonce: "old" }, binding)).toEqual({ kind: "error" });
  });
  it("extracts the user's text and resolves its date inside IOU", () => {
    const result = processIouRequest(request({ operation: "extract", modality: "text",
      text: "Reservation Confirmed\nSynthetic property UNIT-A1\nAugust 6-10\n26,400 EGP",
      sourceTimestamp: Date.UTC(2026, 8, 5) }), binding);
    expect(result.kind).toBe("candidates");
    if (result.kind === "candidates") expect(result.candidates[0]).toMatchObject({ amount: 26400, currency: "EGP", date: "2026-08-06" });
  });
  it("normalizes the original visible transfer date in IOU and preserves image interval fields", () => {
    const result = processIouRequest(request({ operation: "normalize", modality: "image",
      candidates: [{ amount: 12900, currency: "EGP", kind: "settlement", date: "14 Aug 2026", interval_start: "Sun, Jul 19", interval_end: "Tue, Jul 21" }] }), binding);
    expect(result).toEqual({ kind: "candidates", candidates: [{ amount: 12900, currency: "EGP", kind: "settlement", date: "2026-08-14", interval_start: "Sun, Jul 19", interval_end: "Tue, Jul 21" }] });
  });
  it("rejects unsafe JSON, oversize inputs, and invalid timestamps", () => {
    expect(processIouRequest(request({ operation: "extract", modality: "text", text: "x".repeat(33000) }), binding)).toEqual({ kind: "error" });
    expect(processIouRequest(request({ operation: "extract", modality: "text", text: "owe 20", sourceTimestamp: Infinity }), binding)).toEqual({ kind: "error" });
    expect(processIouRequest(request({ operation: "normalize", modality: "image", candidates: [JSON.parse('{"constructor":{}}')] }), binding)).toEqual({ kind: "error" });
  });
  it("interprets independent OCR profiles in IOU without requiring a model", () => {
    const result = processIouRequest(request({ operation: "extract", modality: "image", ocrTranscripts: [
      { profile: "eng", text: "TOTAL 12,900 EGP\nDATE: 14 AUG 2026" },
      { profile: "ara+eng", text: "تمت العملية بنجاح\n1,000 USD\nNOTE: invented" },
    ] }), binding);
    expect(result).toEqual({ kind: "candidates", candidates: [{ amount: 12900, currency: "EGP", date: "2026-08-14", kind: "settlement", direction: "credit" }] });
  });
});
