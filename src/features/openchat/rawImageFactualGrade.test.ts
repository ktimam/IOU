import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import negativeCaptures from "./fixtures/qwen-image-factual-negatives-20261003.json";
import mergedInvoiceCapture from "./fixtures/qwen-direction-r2-two-invoices-20261005.json";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { gradeExactRawImageFacts } from "./rawImageFactualGrade";

// Authored factual expectations are deliberately separate from the immutable
// model captures. These describe the synthetic image; they are not model output.
const noDateLabelsExpectation = {
  heading: "Service invoice",
  total_text: "Total 42.75 EUR",
  dates: [],
  kind: "iou",
  direction_text: "",
  type_texts: [],
};
const noDateCategoricalExpectation = {
  heading: "Service invoice",
  total_text: "Total 42.75 EUR",
  dates: [],
  kind: "iou",
  direction_text: "",
  type_id: "",
};

describe("exact raw-image factual grading", () => {
  it("allows harmless object-key order while keeping the exact field set", () => {
    const reordered = JSON.stringify({
      kind: "iou",
      dates: [],
      heading: "Service invoice",
      type_texts: [],
      direction_text: "",
      total_text: "Total 42.75 EUR",
    });
    expect(gradeExactRawImageFacts(reordered, noDateLabelsExpectation)).toEqual({
      passed: true,
      issues: [],
    });
  });

  it("rejects missing and extra fields without projecting a partial record", () => {
    const raw = JSON.stringify({
      heading: "Service invoice",
      total_text: "Total 42.75 EUR",
      dates: [],
      kind: "iou",
      type_texts: [],
      unexpected: "not evidence",
    });
    expect(gradeExactRawImageFacts(raw, noDateLabelsExpectation)).toEqual({
      passed: false,
      issues: [
        "$.direction_text:missing-field",
        "$:unexpected-field",
      ],
    });
  });

  it("does not copy an unexpected model-controlled key into diagnostics", () => {
    const privateKey = "PRIVATE MODEL-CONTROLLED KEY";
    const grade = gradeExactRawImageFacts(
      JSON.stringify({ ...noDateLabelsExpectation, [privateKey]: "not evidence" }),
      noDateLabelsExpectation,
    );
    expect(grade).toEqual({ passed: false, issues: ["$:unexpected-field"] });
    expect(JSON.stringify(grade)).not.toContain(privateKey);
  });

  it("rejects array cardinality and order changes", () => {
    const expected = [{ heading: "First", dates: ["start", "end"] }];
    expect(
      gradeExactRawImageFacts(
        JSON.stringify([
          { heading: "First", dates: ["end", "start"] },
          { heading: "Second", dates: [] },
        ]),
        expected,
      ),
    ).toEqual({
      passed: false,
      issues: [
        "$:array-length",
        "$[0].dates[0]:value",
        "$[0].dates[1]:value",
      ],
    });
  });

  it("does not trim exact string values or strip a JSON fence", () => {
    const spaced = JSON.stringify({
      ...noDateLabelsExpectation,
      heading: " Service invoice ",
    });
    expect(gradeExactRawImageFacts(spaced, noDateLabelsExpectation)).toEqual({
      passed: false,
      issues: ["$.heading:value"],
    });
    expect(
      gradeExactRawImageFacts(
        `\`\`\`json\n${JSON.stringify(noDateLabelsExpectation)}\n\`\`\``,
        noDateLabelsExpectation,
      ),
    ).toEqual({ passed: false, issues: ["$:invalid-json"] });
  });

  it.each([
    {
      id: "r26-false-delta-source-evidence",
      expected: noDateLabelsExpectation,
      issue: "$.type_texts:array-length",
    },
    {
      id: "r29-false-gamma-categorical-id",
      expected: noDateCategoricalExpectation,
      issue: "$.type_id:value",
    },
  ])("rejects retained actual synthetic false-Type capture $id before normalization", ({ id, expected, issue }) => {
    const capture = negativeCaptures.captures.find((value) => value.id === id);
    if (capture === undefined) throw new Error(`Missing retained capture ${id}`);
    expect(Buffer.byteLength(capture.rawText)).toBe(capture.rawBytes);
    expect(createHash("sha256").update(capture.rawText).digest("hex")).toBe(
      capture.rawSha256,
    );
    expect(capture).toMatchObject({
      modelId: "qwen3-vl-2b-instruct-q4",
      maxTokens: 96,
      cleanupConfirmed: true,
      candidateActivated: false,
    });
    expect(gradeExactRawImageFacts(capture.rawText, expected)).toEqual({
      passed: false,
      issues: [issue],
    });
  });

  it("rejects the captured binary false positive independently of its complete JSON fence", () => {
    const capture = negativeCaptures.captures.find(
      (value) => value.id === "r32-false-gamma-binary-visibility",
    );
    if (capture === undefined) throw new Error("Missing retained binary capture");
    expect(Buffer.byteLength(capture.rawText)).toBe(capture.rawBytes);
    expect(createHash("sha256").update(capture.rawText).digest("hex")).toBe(capture.rawSha256);
    expect(capture).toMatchObject({ cleanupConfirmed: true, candidateActivated: false });
    // The independent synthetic-image expectation is false. r32 prospectively allowed
    // exactly one whole JSON fence, as the existing host parser already does. Preserve
    // the strict grader's format result separately; never mistake parsing for accuracy.
    expect(capture.rawText).toBe("```json\n{\"visible\":true}\n```");
    expect(gradeExactRawImageFacts(capture.rawText, { visible: false })).toEqual({
      passed: false, issues: ["$:invalid-json"],
    });
    const completeJson = capture.rawText.slice("```json\n".length, -"\n```".length);
    expect(gradeExactRawImageFacts(completeJson, { visible: false })).toEqual({
      passed: false, issues: ["$.visible:value"],
    });
  });

  it("rejects duplicate fields instead of accepting JSON.parse's last value", () => {
    const raw = '{"heading":"wrong","heading":"Service invoice","total_text":"Total 42.75 EUR","dates":[],"kind":"iou","direction_text":"","type_texts":[]}';
    expect(gradeExactRawImageFacts(raw, noDateLabelsExpectation)).toEqual({
      passed: false,
      issues: ["$:duplicate-key"],
    });
    const nestedEscaped =
      '{"rows":[{"t\\u0079pe_texts":[],"type_texts":["Delta"]}]}';
    expect(
      gradeExactRawImageFacts(nestedEscaped, { rows: [{ type_texts: ["Delta"] }] }),
    ).toEqual({ passed: false, issues: ["$:duplicate-key"] });
  });

  it("rejects the actual synthetic merged-invoice capture before normalization despite valid JSON and processor output", () => {
    const capture = mergedInvoiceCapture;
    expect(Buffer.byteLength(capture.rawText)).toBe(capture.rawBytes);
    expect(createHash("sha256").update(capture.rawText).digest("hex")).toBe(capture.rawSha256);
    expect(capture.rawSha256).toBe("a19e923cd44eb449ebca6c70f71d717998a93f010130e563ade8d34f057aeddc");
    expect(capture).toMatchObject({
      modelId: "qwen3-vl-2b-instruct-q4",
      promptSha256: "ba37d96a627c8bf763b2a753d453d8456fb4a2c054a24d4711cbe42ed056b045",
      imageSha256: "72bc884d5a20d66a8aaec29b96404635f193d865e172c9719db6eda26718aa38",
      maxTokens: 96, resultKind: "result", cleanupConfirmed: true,
      fullCacheShaReverified: true, candidateActivated: false,
    });
    // Authored independently from the two visible invoices: each has its own
    // total, date and printed direction. Neither date is a period endpoint.
    const expected = [
      { heading: "Invoice A", total_text: "Total 12.34 USD", dates: ["1 October 2026"], kind: "iou", direction_text: "You owe" },
      { heading: "Invoice B", total_text: "Total 56.78 EUR", dates: ["2 October 2026"], kind: "iou", direction_text: "Owed to you" },
    ];
    expect(gradeExactRawImageFacts(capture.rawText, expected)).toEqual({ passed: false, issues: ["$:invalid-json"] });
    // The raw fence is retained byte-exact above. The host prospectively allows
    // one complete fence; stripping that envelope for grading does not fix facts.
    const fence = /^```json\r?\n([\s\S]*?)\r?\n```$/u.exec(capture.rawText.trim());
    expect(fence).not.toBeNull();
    const json = fence![1];
    expect(gradeExactRawImageFacts(json, expected)).toEqual({ passed: false, issues: ["$:type"] });
    const parsed: unknown = JSON.parse(json); // Valid syntax is not a factual pass.
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    expect(gradeExactRawImageFacts(JSON.stringify(rows), expected)).toEqual({
      passed: false, issues: ["$:array-length", "$[0].dates:array-length"],
    });
    const unchanged = JSON.stringify(rows);
    const processed = processLocalArtifactRequest({
      type: "oc:local-process:request", version: 1, actionId: "iou.entry.import",
      input: { operation: "normalize_raw", modality: "image", candidates: rows, sourceTimestamp: Date.parse("2026-10-05T12:00:00Z") },
    }, { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "direction-v1" });
    expect(JSON.stringify(rows)).toBe(unchanged);
    // The processor has no image pixels and cannot know an invoice was omitted.
    // Do not make it reject otherwise valid JSON, invent row B, or redistribute
    // dates. This intentional semantic acceptance must never count as accuracy.
    expect(processed.kind).toBe("candidates");
    if (processed.kind !== "candidates" || !("candidates" in processed)) throw new Error("Expected schema-valid input");
    expect(processed.candidates).toHaveLength(1);
    expect(processed.candidates[0]).toMatchObject({ amount: 12.34, currency: "USD", kind: "iou", direction: "debt", date: "2026-10-01" });
  });
});
