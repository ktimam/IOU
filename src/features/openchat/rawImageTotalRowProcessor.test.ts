import { expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { processIouRequest } from "./localProcessorBridge";

const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const raw = { heading: "RIVER MARKET", total_row: "TOTAL EGP 350.00", dates: ["04 JUL 2026"], kind: "iou" };
const request = (candidates: unknown[], overrides: Record<string, unknown> = {}) => ({
  type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id,
  input: { operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 8, 9), candidates, ...overrides },
});

it("routes only the explicit total_row contract through IOU and preserves source indexes", () => {
  const original = JSON.stringify(raw);
  expect(processIouRequest(request([raw]), binding)).toEqual({
    kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 350, currency: "EGP", kind: "iou", date: "2026-07-04",
      note: "RIVER MARKET", image_heading: "RIVER MARKET",
    }],
  });
  expect(JSON.stringify(raw)).toBe(original);
});

it("does not use the row adapter to salvage old or mixed total_text output", () => {
  const { total_row, ...rest } = raw;
  for (const candidate of [{ ...rest, total_text: total_row }, { ...raw, total_text: "EGP 350.00" }])
    expect(processIouRequest(request([candidate]), binding)).toEqual({ kind: "error" });
});

it("rejects the whole batch if one row or modality is invalid", () => {
  expect(processIouRequest(request([raw, { ...raw, total_row: "TOTAL USD EGP 350.00" }]), binding)).toEqual({ kind: "error" });
  for (const overrides of [{ modality: "audio" }, { modality: "text" }, { ocrTranscripts: [] }])
    expect(processIouRequest(request([raw], overrides), binding)).toEqual({ kind: "error" });
});
