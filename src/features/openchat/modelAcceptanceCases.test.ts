import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MODEL_ACCEPTANCE_CASES,
  scoreModelAcceptanceCase,
  type ModelAcceptanceObservation,
} from "./modelAcceptanceCases";

function passingObservation(
  id: (typeof MODEL_ACCEPTANCE_CASES)[number]["id"],
): ModelAcceptanceObservation {
  const testCase = MODEL_ACCEPTANCE_CASES.find(
    (candidate) => candidate.id === id,
  );
  if (!testCase) throw new Error(`missing acceptance case ${id}`);
  const extracted = testCase.expected.map((entry) => ({
    kind: entry.kind,
    amount: entry.amount,
    currency: entry.currency,
    direction: entry.direction,
    ...(entry.date === undefined ? {} : { date: entry.date }),
    note: entry.noteIncludes.join(" "),
    ...(testCase.modality === "text" ? { message: testCase.text } : {}),
  }));
  return {
    resultKind: extracted.length === 1 ? "ready" : "ready_multi",
    extracted,
    cardRows:
      extracted.length === 1
        ? [
            { label: "Amount", value: String(extracted[0].amount) },
            { label: "Currency", value: String(extracted[0].currency) },
            { label: "Type", value: String(extracted[0].kind) },
            { label: "Direction", value: String(extracted[0].direction) },
            ...(extracted[0].date
              ? [{ label: "Date", value: String(extracted[0].date) }]
              : []),
            { label: "Note", value: String(extracted[0].note) },
          ]
        : extracted.map((entry, index) => ({
            label: `Entry ${index + 1}`,
            value: [
              `Amount: ${String(entry.amount)}`,
              `Currency: ${String(entry.currency)}`,
              `Type: ${String(entry.kind)}`,
              `Direction: ${String(entry.direction)}`,
              `Note: ${String(entry.note)}`,
            ].join(" Â· "),
          })),
    confirmPayload: extracted.length === 1 ? extracted[0] : extracted,
    inferCalls: testCase.expectedInferCalls,
    actionMs: testCase.warmLatencyMs - 1,
  };
}

describe("real-model IOU acceptance cases", () => {
  it("pins text regressions plus fixed clean-document and receipt-photo OCR fixtures", () => {
    expect(
      MODEL_ACCEPTANCE_CASES.map((testCase) => [
        testCase.id,
        testCase.modality,
      ]),
    ).toEqual([
      ["ordinary-text", "text"],
      ["reservation-date-type", "text"],
      ["delimited-multi-entry", "text"],
      ["multi-entry", "text"],
      ["dated-image", "image"],
      ["receipt-photo", "image"],
    ]);
    expect(MODEL_ACCEPTANCE_CASES[1].text).toBe(
      "reservation 3-8 august 7777 gbp",
    );
    expect(MODEL_ACCEPTANCE_CASES[1].expected).toEqual([
      expect.objectContaining({
        kind: "iou",
        amount: 7777,
        currency: "GBP",
        direction: "debt",
        date: "2026-08-03",
      }),
    ]);
    expect(
      MODEL_ACCEPTANCE_CASES[2].expected.map((entry) => entry.amount),
    ).toEqual([310, 145, 620]);
    expect(MODEL_ACCEPTANCE_CASES[2].expectedInferCalls).toBe(0);
    expect(MODEL_ACCEPTANCE_CASES[3].expectedInferCalls).toBe(1);
    for (const testCase of MODEL_ACCEPTANCE_CASES.filter(
      (candidate) => candidate.modality === "image",
    )) {
      const fixture = testCase.imageFixture;
      expect(fixture).toBeDefined();
      const bytes = readFileSync(
        resolve(__dirname, `../../../${fixture!.path}`),
      );
      expect(bytes.byteLength).toBe(fixture!.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(
        fixture!.sha256,
      );
      expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
      expect(bytes.readUInt32BE(16)).toBe(fixture!.width);
      expect(bytes.readUInt32BE(20)).toBe(fixture!.height);
    }
  });

  it.each(MODEL_ACCEPTANCE_CASES)(
    "accepts an exact expected-call $id result",
    (testCase) => {
      expect(
        scoreModelAcceptanceCase(testCase, passingObservation(testCase.id)),
      ).toEqual({
        pass: true,
        reasons: [],
      });
    },
  );

  it("binds both fixed image fixture identities into the cases digest", () => {
    expect(
      createHash("sha256")
        .update(JSON.stringify(MODEL_ACCEPTANCE_CASES))
        .digest("hex"),
    ).toBe("5dab0ae3870984a6ff6af9e6b93a562dd6ae17676da049d869dd556c386e4314");
  });

  it("rejects a repair pass even when the repaired extraction is correct", () => {
    const testCase = MODEL_ACCEPTANCE_CASES[0];
    const observation = { ...passingObservation(testCase.id), inferCalls: 2 };
    expect(scoreModelAcceptanceCase(testCase, observation)).toEqual({
      pass: false,
      reasons: ["expected 1 inference call, observed 2"],
    });
  });

  it("rejects model inference on the deterministic delimited fast path", () => {
    const testCase = MODEL_ACCEPTANCE_CASES[2];
    const observation = { ...passingObservation(testCase.id), inferCalls: 1 };
    expect(scoreModelAcceptanceCase(testCase, observation)).toEqual({
      pass: false,
      reasons: ["expected 0 inference calls, observed 1"],
    });
  });

  it("rejects an invented note detail even when the required source word is present", () => {
    const testCase = MODEL_ACCEPTANCE_CASES[0];
    const observation = passingObservation(testCase.id);
    observation.extracted[0].note = "groceries for Alice tomorrow";
    const score = scoreModelAcceptanceCase(testCase, observation);
    expect(score.pass).toBe(false);
    expect(score.reasons).toContain(
      "entry 1 note invented for, alice, tomorrow",
    );
  });

  it("rejects wrong cardinality, invented dates, and a mismatched card payload", () => {
    const testCase = MODEL_ACCEPTANCE_CASES[0];
    const observation = passingObservation(testCase.id);
    observation.resultKind = "ready_multi";
    observation.extracted = [
      { ...observation.extracted[0], date: "2026-08-14" },
      { ...observation.extracted[0], amount: 99 },
    ];
    observation.confirmPayload = [{ ...observation.extracted[0], amount: 99 }];
    const score = scoreModelAcceptanceCase(testCase, observation);
    expect(score.pass).toBe(false);
    expect(score.reasons).toEqual(
      expect.arrayContaining([
        "expected ready, observed ready_multi",
        "expected 1 extracted entry, observed 2",
        "entry 1 invented date 2026-08-14",
        "confirm payload does not match the extracted result",
      ]),
    );
  });

  it("rejects warm results that exceed the responsiveness gate", () => {
    const testCase = MODEL_ACCEPTANCE_CASES[3];
    const observation = {
      ...passingObservation(testCase.id),
      actionMs: testCase.warmLatencyMs + 1,
    };
    expect(scoreModelAcceptanceCase(testCase, observation).reasons).toContain(
      `warm action took ${testCase.warmLatencyMs + 1} ms (limit ${testCase.warmLatencyMs} ms)`,
    );
  });

  it("opts the real-model matrix into the explicit acceptance-runner attachment path", () => {
    const runner = readFileSync(
      resolve(__dirname, "../../../scripts/live/model-acceptance-matrix.ts"),
      "utf8",
    );
    expect(runner).toContain('purpose: "acceptance-runner"');
    expect(runner).toContain("qualification.modelArtifactFingerprint(entry)");
    expect(runner).toContain("qualification.MODEL_ACCEPTANCE_RUNTIME_DIGEST");
    expect(runner).toContain("runtimeDigest: live.runtimeDigest");
  });
});
