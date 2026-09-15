import { describe, expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { parseProcessorBootstrap, processIouRequest } from "./localProcessorBridge";

const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const request = (input: unknown) => ({ type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id, input });
describe("IOU owns the local processor", () => {
  it("normalizes app-owned raw image evidence once, preserving source-row indexes and strict canonical money", () => {
    const candidates = [
      { note: "Reservation", currency_text: "$", amount_text: "1,912.15", date_text: "Sun, Jul 19 - Thu, Aug 6", kind: "iou" },
      { note: "REPAIR ESTIMATE", currency_text: "", amount_text: "72.50", date_text: "", kind: "iou" },
    ];
    const before = JSON.stringify(candidates);
    const result = processIouRequest(request({ operation: "normalize_raw", modality: "image", candidates, sourceTimestamp: Date.UTC(2026, 6, 3) }), binding);
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0, 1], candidates: [
      { note: "Reservation", image_heading: "Reservation", currency: "USD", amount: 1912.15, kind: "iou", date: "2026-07-19", interval_start: "Sun, Jul 19", interval_end: "Thu, Aug 6" },
      { note: "REPAIR ESTIMATE", image_heading: "REPAIR ESTIMATE", amount: 72.5, kind: "iou" },
    ] });
    expect(JSON.stringify(candidates)).toBe(before);
  });
  it("rejects the whole raw batch for a malformed row, wrong modality, mixed OCR or legacy shape", () => {
    const raw = { note: "Heading", currency_text: "EGP", amount_text: "350.00", date_text: "04 JUL 2026", kind: "iou" };
    for (const input of [
      { modality: "text", candidates: [raw] }, { modality: "audio", candidates: [raw] },
      { modality: "image", candidates: [raw], ocrTranscripts: [] },
      { modality: "image", candidates: [raw, { ...raw, date_text: "From Reservation to Total Payout" }] },
      { modality: "image", candidates: [{ amount: 350, kind: "iou" }] },
      { modality: "image", candidates: [] }, { modality: "image", candidates: Array.from({ length: 17 }, () => raw) },
    ]) expect(processIouRequest(request({ operation: "normalize_raw", ...input }), binding)).toEqual({ kind: "error" });
  });
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
