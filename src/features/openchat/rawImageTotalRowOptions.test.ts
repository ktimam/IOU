import { expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { processIouRequest } from "./localProcessorBridge";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { normalizeRawImageTotalRowText } from "./rawImageTotalRow";

const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
const row = { heading: "RIVER MARKET", total_text: "TOTAL EGP 350.00", dates: ["04 JUL 2026"], kind: "iou" };
const request = (candidates: unknown[], overrides: Record<string, unknown> = {}) => ({
  type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id,
  input: { operation: "normalize_raw", modality: "image", sourceTimestamp: Date.UTC(2026, 8, 9), candidates, ...overrides },
});

it("opts into row semantics in app configuration, not by changing the model's key", () => {
  expect(normalizeRawImageEvidence(row)).toBeUndefined();
  expect(normalizeRawImageTotalRowText(row)).toMatchObject({ amount: 350, currency: "EGP" });
  for (const options of [{}, { rawImageMoneyFormat: "strict" as const }])
    expect(processIouRequest(request([row]), binding, options)).toEqual({ kind: "error" });
  const result = processIouRequest(request([row]), binding, { rawImageMoneyFormat: "total-row" });
  expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
    amount: 350, currency: "EGP", kind: "iou", date: "2026-07-04",
    note: "RIVER MARKET", image_heading: "RIVER MARKET",
  }] });
});

it("cannot enable the app profile from model output or host input", () => {
  expect(processIouRequest(request([{ ...row, rawImageMoneyFormat: "total-row" }]), binding)).toEqual({ kind: "error" });
  expect(processIouRequest(request([row], { rawImageMoneyFormat: "total-row" }), binding)).toEqual({ kind: "error" });
  expect(processIouRequest(request([row]), binding, { rawImageMoneyFormat: "invalid" as "strict" })).toEqual({ kind: "error" });
});

it("keeps split-field formats unchanged and rejects malformed row batches atomically", () => {
  const split = { note: "Heading", currency_text: "GBP", amount_text: "12.50", date_text: "", kind: "iou" };
  expect(processIouRequest(request([split]), binding, { rawImageMoneyFormat: "total-row" }))
    .toEqual(processIouRequest(request([split]), binding));
  for (const total_text of ["TOTAL USD EGP 350.00", "Total: 350.00 and 20.00", "Total: -350.00"])
    expect(processIouRequest(request([row, { ...row, total_text }]), binding, { rawImageMoneyFormat: "total-row" }))
      .toEqual({ kind: "error" });
});
