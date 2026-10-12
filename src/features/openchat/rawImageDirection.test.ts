import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import candidateProfiles from "../../../docs/model-prompts/direction-v1-candidate.json";
import revision2Profiles from "../../../docs/model-prompts/direction-v1-revision2-candidate.json";
import activeProfiles from "./modelImageProfiles.json";
import { readIouModelImageProfiles, iouImageProcessorOptions } from "./modelImageProfiles";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { normalizeRawImageTotalRow, normalizeRawImageTotalRowText } from "./rawImageTotalRow";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { createLocalProcessorContext } from "./localProcessorContext";
import { createIouLocalAppPackage } from "./localAppPackage";
import { withPrivateTypeImageEvidenceGuidance } from "./imageTypePrompt";
import { iouActionManifest } from "./actionManifest";

const options = { rawImageMoneyFormat: "total-row", rawImageDetailsFormat: "direction-v1" } as const;
const rawQwen = (direction_text: unknown = "You owe") => ({
  heading: "Synthetic invoice", total_text: "Total: $123.45", dates: ["27 Sep 2026"], kind: "iou", direction_text,
});
const rawGemma = (direction_text: unknown = "You owe") => ({
  note: "Synthetic invoice", currency_text: "USD", amount_text: "123.45", date_text: "27 Sep 2026", kind: "iou", direction_text,
});
const savedType = { id: "synthetic-type", name: "Synthetic invoice", keywords: [], direction: "credit", txn_type: "settlement" } as const;
const request = (candidates: Record<string, unknown>[], context?: unknown) => ({
  version: 1, type: "oc:local-process:request", actionId: "iou.entry.import", ...(context ? { context } : {}),
  input: { operation: "normalize_raw", modality: "image", candidates, sourceTimestamp: Date.parse("2026-09-27T12:00:00Z") },
});

// Constructed contract inputs, not model captures. Passing these tests is not image qualification.
describe("inactive direction-v1 contract", () => {
  const parsers = [
    { name: "Qwen complete row", read: (value: unknown) => normalizeRawImageTotalRowText(value, "direction-v1"), raw: rawQwen },
    { name: "Gemma split money", read: (value: unknown) => normalizeRawImageEvidence(value, "labeled-values", "direction-v1"), raw: rawGemma },
    { name: "explicit total_row", read: (value: unknown) => normalizeRawImageTotalRow(value, "direction-v1"), raw: (direction?: unknown) => {
      const { total_text, ...rest } = rawQwen(direction); return { ...rest, total_row: total_text };
    } },
  ];
  describe.each(parsers)("$name", ({ read, raw }) => {
    it.each([["You owe", "debt"], ["Owed to you", "credit"], ["you OWE", "debt"], ["", undefined]] as const)(
      "preserves exact displayed direction %j without changing money, heading or dates", (label, direction) => {
        const value = raw(label), before = JSON.stringify(value);
        expect(read(value)).toEqual({ amount: 123.45, currency: "USD", kind: "iou", note: "Synthetic invoice",
          image_heading: "Synthetic invoice", printed_date: "27 Sep 2026", printed_end_date: "",
          ...(direction === undefined ? {} : { direction }) });
        expect(JSON.stringify(value)).toBe(before);
      },
    );
    it.each(["debt", "credit", "Direction: You owe", "You owe me", "Paid", "You owe | Owed to you", "You\nowe", "You owe\u202e", "x".repeat(65), 1, [], {}].map(direction => ({ direction })))(
      "rejects malformed, ambiguous or nonliteral direction atomically: $direction", ({ direction }) => expect(read(raw(direction))).toBeUndefined(),
    );
    it("requires its exact own field and never accepts a broader experimental shape", () => {
      const value: Record<string, unknown> = raw(); delete value.direction_text;
      expect(read(value)).toBeUndefined();
      for (const extra of ["direction", "description_text", "type_texts", "image_type_texts", "hidden"])
        expect(read({ ...raw(), [extra]: [] })).toBeUndefined();
      expect(read(Object.assign(raw(), { [Symbol("hidden")]: true }))).toBeUndefined();
      expect(read({ ...raw(), direction_text: undefined })).toBeUndefined();
    });
    it("treats only explicit null as absent evidence without adding a direction or mutating it", () => {
      const value = raw(null), before = JSON.stringify(value);
      expect(read(value)).toEqual(read(raw("")));
      expect(read(value)).not.toHaveProperty("direction");
      expect(read(value)).not.toHaveProperty("image_type_texts");
      expect(JSON.stringify(value)).toBe(before);
    });
    it("does not invoke accessors or accept inherited direction", () => {
      let reads = 0;
      const value = Object.defineProperty(raw(), "direction_text", { get() { reads++; return "You owe"; } });
      expect(read(value)).toBeUndefined();
      expect(reads).toBe(0);
      const inherited: Record<string, unknown> = raw(); delete inherited.direction_text;
      Object.setPrototypeOf(inherited, { direction_text: "You owe" });
      expect(read(inherited)).toBeUndefined();
    });
  });

  it("keeps the candidate versioned and inactive without changing the tested active prompts", () => {
    const before = JSON.stringify(candidateProfiles);
    expect(readIouModelImageProfiles(candidateProfiles).processorOptions).toEqual(options);
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
    expect(Object.keys(candidateProfiles.templates)).toEqual(Object.keys(activeProfiles.templates));
    expect(JSON.stringify(candidateProfiles)).toBe(before);
    for (const id of Object.keys(activeProfiles.templates) as (keyof typeof activeProfiles.templates)[]) {
      const prompt = candidateProfiles.templates[id];
      expect(prompt.output).toBe("app"); expect(prompt.includeRuleGuidance).toBe(false);
      expect(prompt.template).toContain('"direction_text"');
      expect(prompt.template).not.toContain("type_texts");
      expect(activeProfiles.templates[id].template).not.toContain("direction_text");
    }
  });

  it("changes only the key count and one literal-direction instruction in each existing prompt", () => {
    const rule = '"direction_text": look for these exact printed labels: "Owed to you", "You owe". Copy a label only if that exact label is visible in the image. If neither label is printed, output "". Do not infer a label from payment status, names, bank accounts or arrows.';
    const qwen = activeProfiles.templates["qwen3-vl-2b-instruct-q4"].template
      .replace("Use exactly four keys", "Use exactly five keys")
      .replace("\n\nDo not add separate amount", `\n\n${rule}\n\nDo not add separate amount`);
    const gemma = activeProfiles.templates["gemma-4-e2b-it-q4"].template
      .replace("Fill these five fields", "Fill these six fields")
      .replace("\n\nUse only these five keys", `\n6. ${rule}\n\nUse only these six keys`);
    expect(candidateProfiles.templates["qwen3-vl-2b-instruct-q4"].template).toBe(qwen);
    expect(candidateProfiles.templates["gemma-4-e2b-it-q4"].template).toBe(gemma);
    expect(createHash("sha256").update(qwen).digest("hex")).toBe("cb62b24d295c497531fd76c646f143b5a4f0927def5eaae94399215d52d24c94");
    expect(createHash("sha256").update(gemma).digest("hex")).toBe("b75532105908b81d7aad1e7eb9a7b091a544f953474574b737291907cb98bb4d");
  });

  it("keeps the public prompt recipe byte-identical across private Type rosters and within schema limits", () => {
    const parsed = readIouModelImageProfiles(candidateProfiles);
    const before = JSON.stringify(parsed.promptExtension);
    for (const types of [[], [{ ...savedType, name: "Private account-specific label", keywords: ["Private keyword"] }]]) {
      expect(withPrivateTypeImageEvidenceGuidance({ promptExtension: parsed.promptExtension,
        rawImageDetailsFormat: "direction-v1", processorContext: createLocalProcessorContext(types, "USD"),
      })).toBe(parsed.promptExtension);
    }
    expect(JSON.stringify(parsed.promptExtension)).toBe(before);
    const schema = { ...iouActionManifest.outputSchema, "x-openchat-image-prompt-by-model": parsed.promptExtension };
    expect(new TextEncoder().encode(JSON.stringify(schema)).byteLength).toBeLessThanOrEqual(16384);
  });

  it("keeps revision2 inactive and limits its model-specific changes to the reviewed ablations", () => {
    const oldRule = '"direction_text": look for these exact printed labels: "Owed to you", "You owe". Copy a label only if that exact label is visible in the image. If neither label is printed, output "". Do not infer a label from payment status, names, bank accounts or arrows.';
    const newRule = '"direction_text": start with "". Replace it only when the image itself contains an explicit statement of who owes whom; copy that printed statement without a field label. Keep "" when there is no such printed statement. Do not infer it from payment status, document kind, names, bank accounts or arrows.';
    const qwen = revision2Profiles.templates["qwen3-vl-2b-instruct-q4"].template;
    const gemma = revision2Profiles.templates["gemma-4-e2b-it-q4"].template;
    expect(qwen).toBe(candidateProfiles.templates["qwen3-vl-2b-instruct-q4"].template.replace(oldRule, newRule));
    expect(gemma).toBe(candidateProfiles.templates["gemma-4-e2b-it-q4"].template.replace(
      "Use only these six keys.", "Return compact single-line JSON, with no indentation or whitespace outside strings. Use only these six keys.",
    ));
    expect(createHash("sha256").update(qwen).digest("hex")).toBe("ba37d96a627c8bf763b2a753d453d8456fb4a2c054a24d4711cbe42ed056b045");
    expect(createHash("sha256").update(gemma).digest("hex")).toBe("80a89d8e6b9109dd0135a39d3150a64e84b1314be873625320f1787c0b369e0d");
    expect(readIouModelImageProfiles(revision2Profiles).processorOptions).toEqual(options);
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
  });

  describe.each([{ name: "Qwen", raw: rawQwen }, { name: "Gemma", raw: rawGemma }])("$name private artifact", ({ raw }) => {
    it.each(["You owe", "Owed to you", "", null])("preserves printed %j or the established absent-direction default", (printed) => {
      const value = request([raw(printed)]), before = JSON.stringify(value);
      expect(processLocalArtifactRequest(value, options)).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
        amount: 123.45, currency: "USD", kind: "iou", direction: printed === "You owe" ? "debt" : "credit",
        date: "2026-09-27", note: "Synthetic invoice",
      }] });
      expect(JSON.stringify(value)).toBe(before);
      expect(processLocalArtifactRequest(value)).toEqual({ kind: "error" });
    });
    it("keeps null absence separate from saved-Type defaults and never changes transaction kind", () => {
      const context = createLocalProcessorContext([{ ...savedType, direction: "debt", keywords: [] }], "USD");
      const value = request([raw(null)], { ...context, draftEditorDefaults: "host-v1" });
      const result = processLocalArtifactRequest(value, options);
      expect(result).toMatchObject({ candidates: [{ direction: "credit", kind: "iou", typeId: savedType.id }] });
      expect(processLocalArtifactRequest({ ...value, context }, options)).toMatchObject({ candidates: [{
        direction: "debt", kind: "iou", typeId: savedType.id,
      }] });
      expect(value.input.candidates[0].direction_text).toBeNull();
    });
    it("retains heading-based saved-Type choice and exposes pre-Type direction for the existing host default policy", () => {
      const base = createLocalProcessorContext([{ ...savedType, keywords: [] }], "USD");
      const value = request([raw()], { ...base, draftEditorDefaults: "host-v1" });
      expect(processLocalArtifactRequest(value, options)).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
        amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27", note: "Synthetic invoice",
        typeId: savedType.id, typeName: savedType.name,
      }] });
      // Legacy app-owned Type defaults and host-v1 baseline/default pairing stay distinct.
      expect(processLocalArtifactRequest({ ...value, context: base }, options)).toMatchObject({ candidates: [{
        direction: "credit", kind: "iou", typeId: savedType.id,
      }] });
    });
    it("keeps an unmatched heading untyped and strips extraction-only direction/source metadata", () => {
      const context = createLocalProcessorContext([{ ...savedType, name: "Unmatched private type", keywords: [] }], "USD");
      const result = processLocalArtifactRequest(request([raw()], { ...context, draftEditorDefaults: "host-v1" }), options);
      expect(result).toMatchObject({ candidates: [{ direction: "debt" }] });
      for (const key of ["typeId", "typeName", "image_heading", "image_type_texts", "direction_text", "processorContext", "keywords"])
        expect(JSON.stringify(result)).not.toContain(key);
    });
    it("does not let colliding saved Types replace a printed direction", () => {
      const context = createLocalProcessorContext([
        { ...savedType, name: "First private type", keywords: ["Synthetic invoice"] },
        { ...savedType, id: "other-type", name: "Second private type", keywords: ["Synthetic invoice"], direction: "debt" },
      ], "USD");
      const result = processLocalArtifactRequest(request([raw()], { ...context, draftEditorDefaults: "host-v1" }), options);
      expect(result).toEqual({ kind: "candidates", sourceIndexes: [0], candidates: [{
        amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27", note: "Synthetic invoice",
      }] });
    });
    it("keeps absent date and row directions independent across multiple transactions", () => {
      const second = { ...raw("Owed to you"), ...(raw === rawQwen ? { total_text: "$45.67", dates: [] } : { amount_text: "45.67", date_text: "" }) };
      const result = processLocalArtifactRequest(request([raw(), second]), options);
      expect(result).toEqual({ kind: "candidates", sourceIndexes: [0, 1], candidates: [
        { amount: 123.45, currency: "USD", kind: "iou", direction: "debt", date: "2026-09-27", note: "Synthetic invoice" },
        { amount: 45.67, currency: "USD", kind: "iou", direction: "credit", note: "Synthetic invoice" },
      ] });
      expect(processLocalArtifactRequest(request([raw(), { ...second, direction_text: "ambiguous" }]), options)).toEqual({ kind: "error" });
    });
    it("does not allow the model/request to select the processor contract", () => {
      const value = request([raw()]);
      expect(processLocalArtifactRequest({ ...value, rawImageDetailsFormat: "direction-v1" }, options)).toEqual({ kind: "error" });
      expect(processLocalArtifactRequest({ ...value, input: { ...value.input, rawImageDetailsFormat: "direction-v1" } }, options))
        .toEqual({ kind: "error" });
    });
  });

  it("leaves the exported saved-Type direction default independent of transaction kind", () => {
    const context = createLocalProcessorContext([{ ...savedType, keywords: [] }], "USD");
    const exported = createIouLocalAppPackage("https://example.test/openchat/import", { sha256: "a".repeat(64), byteLength: 1 }, {
      recipientLabel: "Synthetic test sheet", processorContext: context,
    });
    expect(exported.apps[0].actions[0].draftEditor?.choices[0].options[0]).toEqual({
      value: savedType.id, label: savedType.name, assign: [{ field: "typeName", value: savedType.name }],
      defaults: [{ field: "direction", value: "credit" }],
    });
  });
  it("does not widen older formats or coerce null money/date/heading/kind into valid values", () => {
    const base = rawGemma(null);
    for (const mode of ["labels-v1", "labels-v2", "source-v1"] as const) {
      const value = { ...base, type_texts: [], ...(mode === "source-v1" ? { description_text: "" } : {}) };
      expect(normalizeRawImageEvidence(value, "strict", mode)).toBeUndefined();
    }
    for (const field of ["note", "currency_text", "amount_text", "date_text", "kind"])
      expect(normalizeRawImageEvidence({ ...rawGemma(), [field]: null }, "strict", "direction-v1")).toBeUndefined();
    expect(normalizeRawImageEvidence(JSON.stringify(base), "strict", "direction-v1")).toBeUndefined();
    expect(processLocalArtifactRequest(request([JSON.stringify(base) as unknown as Record<string, unknown>]), options)).toEqual({ kind: "error" });
  });
});
