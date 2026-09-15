import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { iouActionManifest } from "./actionManifest";
import { initToFormState, buildConfirmPayload } from "./cardBridge";
import { processIouRequest } from "./localProcessorBridge";

// Captured desktop model answers: this suite performs no model inference or phone test.
const bytes = readFileSync(new URL("../../../test/fixtures/openchat/model-acceptance/qwen-v20-total-row-app-replay.json", import.meta.url));
const fixture = JSON.parse(bytes.toString("utf8")) as {
  modelId: string; promptSha256: string; workerSha256: string; resultSha256: string;
  cases: { imageId: string; imageSha256: string; sourceTimestamp: string; raw: string;
    expectedSource: { heading: string; total_text: string; dates: string[]; kind: string };
    allowedDates: string[][];
    expectedAppForm: { kind: string; amount: string; currency: string; date: string; note: string } }[];
};

describe("Qwen complete-row captured-output IOU regression", () => {
  it("binds the actual eight captures, unchanged prompt and mixed-precision worker", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("06300da64f2c67020f3d2a0b45df151d5349a5aa8e8cab33d3c2f344f16eab22");
    expect(fixture.modelId).toBe("qwen3-vl-2b-q4-head-f16-diagnostic");
    expect(fixture.resultSha256).toBe("c5404f050bbd50953dd69b67ffaf201964eb50f27dc9e064be69f7c3c7555b3d");
    expect(fixture.workerSha256).toBe("131557a3edb11a51f227c7cca76e4d90739d14a0152ba0e517cbefffd68916be");
    expect(fixture.promptSha256).toBe("2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8");
    const prompt = readFileSync(new URL("../../../docs/model-prompts/qwen3-vl-2b-total-row-image.txt", import.meta.url));
    expect(prompt.byteLength).toBe(1337);
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(fixture.promptSha256);
    expect(prompt.toString("utf8")).not.toMatch(/reservation|river market|repair estimate|12,900|350\.00/i);
    expect(fixture.cases).toHaveLength(8);
    expect(new Set(fixture.cases.map((row) => row.imageId)).size).toBe(8);
  });

  for (const row of fixture.cases) {
    it(`preserves captured source facts through processor, card and confirmation: ${row.imageId}`, () => {
      // All eight captured answers have one complete enclosing fence. Removing this
      // exact envelope is fixture decoding, not a replacement for OpenChat's parser.
      const envelope = /^```json\n([\s\S]+)\n```$/u.exec(row.raw);
      expect(envelope).not.toBeNull();
      const raw = JSON.parse(envelope![1]);
      expect(Object.keys(raw)).toEqual(["heading", "total_text", "dates", "kind"]);
      expect(raw.heading).toBe(row.expectedSource.heading);
      expect(raw.total_text.trim().replace(/\s+/gu, " ")).toBe(row.expectedSource.total_text);
      expect(raw.kind).toBe(row.expectedSource.kind);
      expect(row.allowedDates.some((dates) => JSON.stringify(dates) === JSON.stringify(raw.dates))).toBe(true);
      const original = JSON.stringify(raw), binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
      const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id,
        input: { operation: "normalize_raw", modality: "image", candidates: [raw], sourceTimestamp: Date.parse(row.sourceTimestamp) },
      }, binding, { rawImageMoneyFormat: "total-row" });
      expect(result.kind).toBe("candidates");
      if (result.kind !== "candidates") throw new Error("Expected complete app candidate");
      expect(result.sourceIndexes).toEqual([0]); expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0], now = new Date(row.sourceTimestamp), card = initToFormState(candidate, now);
      expect(card).toMatchObject(row.expectedAppForm);
      const confirmation = buildConfirmPayload(card);
      expect(Number(confirmation.amount)).toBe(Number(row.expectedAppForm.amount));
      expect(confirmation.note).toBe(row.expectedAppForm.note);
      expect(initToFormState({ ...candidate, note: card.note }, now).note).toBe(card.note);
      expect(JSON.stringify(raw)).toBe(original);
      for (const key of ["total_text", "total_row", "sourceIndexes"]) expect(candidate).not.toHaveProperty(key);
      for (const key of ["image_heading", "printed_date", "printed_end_date", "sourceIndexes"]) expect(confirmation).not.toHaveProperty(key);
      if (row.expectedAppForm.currency === "") expect(candidate).not.toHaveProperty("currency");
      if (row.expectedAppForm.date === "") expect(candidate).not.toHaveProperty("date");
    });
  }
});
