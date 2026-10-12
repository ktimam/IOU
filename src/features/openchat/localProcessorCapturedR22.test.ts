import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import capture from "./fixtures/qwen-labels-r22-synthetic-invoice-20261003.json";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { createLocalProcessorContext } from "./localProcessorContext";
import { gradeExactRawImageFacts } from "./rawImageFactualGrade";

// Captured bytes are immutable evidence. Mutated controls below are not model runs.
const row = () => JSON.parse(capture.rawText);
const savedType = { id: "synthetic-alpha", name: "Alpha", keywords: ["TEST ONLY"],
  direction: "credit" as const, txn_type: "settlement" as const };
const authoredSourceFacts = {
  heading: "SYNTHETIC TEST INVOICE", total_text: "123.45 USD", dates: ["27 September 2026"],
  kind: "iou", direction_text: "You owe", type_texts: ["TEST ONLY"],
};
const request = (candidate: unknown = row(), withTypes = true) => ({
  type: "oc:local-process:request", version: 1, actionId: "iou.entry.import",
  context: { ...createLocalProcessorContext(withTypes ? [savedType] : [], "USD"), draftEditorDefaults: "host-v1" },
  input: { operation: "normalize_raw", modality: "image", candidates: [candidate],
    sourceTimestamp: Date.parse(capture.sourceTimestamp) },
});

describe("exact r22 synthetic Qwen capture — offline IOU replay only", () => {
  it("retains byte-exact evidence without promoting the diagnostic to production", () => {
    expect(Buffer.byteLength(capture.rawText)).toBe(capture.provenance.rawBytes);
    expect(createHash("sha256").update(capture.rawText).digest("hex")).toBe(capture.provenance.rawSha256);
    expect(capture.provenance.candidateActivated).toBe(false);
  });

  it.each(["labels-v1", "labels-v2"] as const)("preserves printed fields and app-owned matching with %s", (format) => {
    // Factual grading precedes IOU normalization. A normalizable but invented
    // Type term must never become a model-accuracy pass.
    expect(gradeExactRawImageFacts(capture.rawText, authoredSourceFacts))
      .toEqual({ passed: true, issues: [] });
    const value = request();
    const before = JSON.stringify(value);
    const result = processLocalArtifactRequest(value, { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: format });
    expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
      amount: 123.45, currency: "USD", date: "2026-09-27", kind: "iou", direction: "debt",
      note: "SYNTHETIC TEST INVOICE", typeId: savedType.id, typeName: savedType.name,
    }] });
    // The host applies Type defaults later; normalization keeps the extracted baseline.
    expect(JSON.stringify(value)).toBe(before);
    for (const field of ["type_texts", "direction_text", "total_text", "keywords", "draftEditorDefaults", "processorContext"])
      expect(JSON.stringify(result)).not.toContain(field);
    expect(JSON.stringify(result)).not.toContain("TEST ONLY");
    expect(processLocalArtifactRequest(value)).toEqual({ kind: "error" });
  });

  it("does not silently admit unconfigured Type evidence in labels-v2", () => {
    expect(processLocalArtifactRequest(request(row(), false), {
      rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v2",
    })).toEqual({ kind: "error" });
  });

  it.each([
    { type_texts: ["TEST ONLY", "TEST ONLY"] },
    { type_texts: ["NOT IN THE PRIVATE ROSTER"] },
    { type_texts: ["TEST ONLY"], unexpected: "extra key" },
    { direction_text: "inferred incoming transfer" },
  ])("rejects a synthetic invalid mutation atomically: %j", (change) => {
    expect(processLocalArtifactRequest(request({ ...row(), ...change }), {
      rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "labels-v2",
    })).toEqual({ kind: "error" });
  });
});
