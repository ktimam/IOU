import { describe, expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { parseProcessorBootstrap, processIouRequest, type IouProcessorOptions } from "./localProcessorBridge";

const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const request = (input: unknown) => ({ type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id, input });

describe("app-owned raw image source details", () => {
  const options: IouProcessorOptions = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "source-v1" };
  const labelOptions: IouProcessorOptions = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v1" };
  const details = { direction_text: " You owe ", description_text: "Test stationery", type_texts: ["TEST ONLY", " "] };
  const rows = [
    { heading: "TEST INVOICE", total_text: "Total 123.45 USD", dates: ["27 September 2026"], kind: "iou" },
    { heading: "TEST INVOICE", total_row: "Total 123.45 USD", dates: ["27 September 2026"], kind: "iou" },
    { note: "TEST INVOICE", currency_text: "USD", amount_text: "123.45", date_text: "27 September 2026", kind: "iou" },
  ];
  it.each(rows)("passes source-v1 to each supported raw money parser", (row) => {
    const candidate = { ...row, ...details };
    const before = JSON.stringify(candidate);
    expect(processIouRequest(request({ operation: "normalize_raw", modality: "image", candidates: [candidate] }), binding, options))
      .toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 123.45, currency: "USD", kind: "iou",
        direction: "debt", note: "Test stationery", image_heading: "TEST INVOICE", image_type_texts: ["TEST ONLY", " "], date: "2026-09-27" }] });
    expect(JSON.stringify(candidate)).toBe(before);
  });
  it.each(rows)("passes labels-v1 to each supported raw money parser while preserving the heading note", (row) => {
    const candidate = { ...row, direction_text: " You owe ", type_texts: ["TEST ONLY", " "] };
    expect(processIouRequest(request({ operation: "normalize_raw", modality: "image", candidates: [candidate] }), binding, labelOptions))
      .toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{ amount: 123.45, currency: "USD", kind: "iou",
        direction: "debt", note: "TEST INVOICE", image_heading: "TEST INVOICE", image_type_texts: ["TEST ONLY", " "], date: "2026-09-27" }] });
  });
  it("requires app options, not request or model fields, to enable details", () => {
    const input = { operation: "normalize_raw", modality: "image", candidates: [{ ...rows[2], ...details }] };
    expect(processIouRequest(request(input), binding)).toEqual({ kind: "error" });
    expect(processIouRequest(request(input), binding, { rawImageDetailsFormat: "none" })).toEqual({ kind: "error" });
    expect(processIouRequest(request({ ...input, rawImageDetailsFormat: "source-v1" }), binding, options)).toEqual({ kind: "error" });
    expect(processIouRequest({ ...request(input), rawImageDetailsFormat: "source-v1" }, binding, options)).toEqual({ kind: "error" });
    const labelInput = { operation: "normalize_raw", modality: "image", candidates: [{ ...rows[2], direction_text: "", type_texts: [] }] };
    expect(processIouRequest(request({ ...labelInput, rawImageDetailsFormat: "labels-v1" }), binding, labelOptions))
      .toEqual({ kind: "error" });
    expect(processIouRequest({ ...request(labelInput), rawImageDetailsFormat: "labels-v1" }, binding, labelOptions))
      .toEqual({ kind: "error" });
    expect(processIouRequest(request(input), binding, { rawImageDetailsFormat: "unknown" } as unknown as IouProcessorOptions)).toEqual({ kind: "error" });
    expect(processIouRequest(request({ operation: "normalize", modality: "image", candidates: [{ amount: 20 }] }), binding,
      { rawImageDetailsFormat: "unknown" } as unknown as IouProcessorOptions)).toEqual({ kind: "error" });
  });
  it("does not require raw details for canonical normalization or text extraction", () => {
    for (const input of [
      { operation: "normalize", modality: "image", candidates: [{ amount: 20, currency: "USD", note: "unchanged" }] },
      { operation: "extract", modality: "text", text: "I owe 20 USD" },
    ]) expect(processIouRequest(request(input), binding, options)).toEqual(processIouRequest(request(input), binding));
  });
  it("rejects a whole batch with missing, unknown or malformed details without repairing strings", () => {
    const raw = { ...rows[2], ...details };
    const { type_texts: _omitted, ...missing } = raw;
    for (const invalid of [missing, { ...raw, direction_text: "probably debt" }, { ...raw, description_text: "line\nbreak" },
      { ...raw, type_texts: ["TEST ONLY", 1] }, { ...raw, type_texts: Array(5).fill("TEST ONLY") }, { ...raw, extra: "unrequested" }]) {
      expect(processIouRequest(request({ operation: "normalize_raw", modality: "image", candidates: [raw, invalid] }), binding, options))
        .toEqual({ kind: "error" });
    }
  });
  it("rejects incomplete, malformed or expanded labels-v1 rows atomically", () => {
    const raw = { ...rows[2], direction_text: "You owe", type_texts: ["TEST ONLY"] };
    const { type_texts: _omitted, ...missing } = raw;
    for (const invalid of [missing, { ...raw, direction_text: "probably debt" },
      { ...raw, type_texts: ["TEST ONLY", 1] }, { ...raw, description_text: "Not allowed" }, { ...raw, extra: true }])
      expect(processIouRequest(request({ operation: "normalize_raw", modality: "image", candidates: [raw, invalid] }), binding, labelOptions))
        .toEqual({ kind: "error" });
  });
});
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
