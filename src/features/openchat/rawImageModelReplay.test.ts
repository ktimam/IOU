import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { postProcessIouCandidate } from "./localExtraction";
import { initToFormState } from "./cardBridge";
import { iouActionManifest } from "./actionManifest";
import { processIouRequest } from "./localProcessorBridge";

// Actual saved outputs, not mocked inference passed off as a model run. This replay
// invokes only the IOU functions; the host raw-normalization path is still unwired.
const bytes = readFileSync(new URL("../../../test/fixtures/openchat/model-acceptance/gemma-v15-app-replay.json", import.meta.url));
const fixture = JSON.parse(bytes.toString("utf8")) as {
  modelId: string; promptSha256: string; workerSha256: string; resultSha256: string;
  cases: { imageId: string; imageSha256: string; sourceTimestamp: string; raw: string;
    strictPromptContractPassed: boolean;
    expectedAppForm: { kind: string; amount: string; currency: string; date: string; note: string } }[];
};

describe("Gemma v15 captured-output IOU-only replay", () => {
  it("retains the exact eight captures and the original 6/8 strict-contract result", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("14f9ad07b2b66b75accaf424e22ba5f3bb8f8ae6cd9ecbe09ef573f3455dcae1");
    expect(fixture.modelId).toBe("gemma-4-e2b-it-q4");
    expect(fixture.promptSha256).toBe("a84d35c89fb8f3c91979a1954051769417109bb4f6785fea4fea3a3ad72048d8");
    const prompt = readFileSync(new URL("../../../docs/model-prompts/gemma-4-e2b-split-image.txt", import.meta.url));
    expect(prompt.byteLength).toBe(1573);
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(fixture.promptSha256);
    expect(prompt.toString("utf8")).not.toMatch(/\{\{|reservation|river market|repair estimate/i);
    expect([...prompt.toString("utf8").matchAll(/^[1-5]\. "([a-z_]+)":/gm)].map((match) => match[1]))
      .toEqual(["note", "currency_text", "amount_text", "date_text", "kind"]);
    expect(fixture.workerSha256).toBe("dd107de1bc3fc1c91e7ac16165681f51941f8b9503991c443c1cd749394154ed");
    expect(fixture.resultSha256).toBe("22448763bbed88906ac2042c530300457c92d1c97061daac8dea2b50a9a68bad");
    expect(fixture.cases).toHaveLength(8);
    expect(new Set(fixture.cases.map((row) => row.imageId)).size).toBe(8);
    expect(fixture.cases.filter((row) => row.strictPromptContractPassed)).toHaveLength(6);
  });

  for (const row of fixture.cases) {
    it(`converts complete captured evidence to exact app date/note/money: ${row.imageId}`, () => {
      expect(row.imageSha256).toMatch(/^[a-f0-9]{64}$/);
      const list: unknown[] = JSON.parse(row.raw);
      expect(list).toHaveLength(1);
      const before = JSON.stringify(list[0]);
      expect(normalizeRawImageEvidence(list[0]) !== undefined).toBe(row.strictPromptContractPassed);
      const raw = normalizeRawImageEvidence(list[0], "labeled-values");
      expect(raw).toBeDefined();
      const candidate = postProcessIouCandidate(raw!, { modality: "image", sourceTimestamp: row.sourceTimestamp, candidateCount: 1 });
      const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
      expect(processIouRequest({ type: "oc:app-process:request", version: 1, ...binding, actionId: iouActionManifest.id,
        input: { operation: "normalize_raw", modality: "image", candidates: list, sourceTimestamp: Date.parse(row.sourceTimestamp) },
      }, binding)).toEqual({ kind: "candidates", candidates: [candidate], sourceIndexes: [0] });
      const now = new Date(row.sourceTimestamp);
      const card = initToFormState(candidate, now);
      expect(card).toMatchObject(row.expectedAppForm);
      expect(initToFormState({ ...candidate, note: card.note }, now).note).toBe(card.note);
      expect(JSON.stringify(list[0])).toBe(before);
      expect(candidate).not.toHaveProperty("date_text");
      expect(candidate).not.toHaveProperty("amount_text");
      expect(candidate).not.toHaveProperty("direction");
      if (row.expectedAppForm.currency === "") expect(candidate).not.toHaveProperty("currency");
      if (row.expectedAppForm.date === "") expect(candidate).not.toHaveProperty("date");
    });
  }
});
