import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import config from "./modelImageProfiles.json";
import { iouActionManifest, IOU_IMAGE_EXTRACTION_PROMPT } from "./actionManifest";
import { iouImageProcessorOptions, iouImagePromptByModel, readIouModelImageProfiles } from "./modelImageProfiles";
import { processIouRequest } from "./localProcessorBridge";
import { buildConfirmPayload, initToFormState } from "./cardBridge";
import attestationFixture from "../../../test/fixtures/openchat/model-acceptance/configured-model-attestation-cards.json";
import smallerQwenFixture from "../../../test/fixtures/openchat/model-acceptance/qwen-q4-v20-app-replay.json";
import scopedQwenFixture from "../../../test/fixtures/openchat/model-acceptance/qwen-document-scoped-app-replay.json";

const cases = [
  ["qwen3-vl-2b-q4-head-f16-diagnostic", "qwen3-vl-2b-total-row-image.txt", "qwen-v20-total-row-app-replay.json",
    "2d73ebab0701a7adb4256072ef4625c30964b46766172bae05602bc72e045cc8"],
  ["gemma-4-e2b-it-q4", "gemma-4-e2b-split-image.txt", "gemma-v15-app-replay.json",
    "a84d35c89fb8f3c91979a1954051769417109bb4f6785fea4fea3a3ad72048d8"],
] as const;
const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };

describe("IOU configured model image profiles", () => {
  it("keeps the backend attestation corpus complete and uniquely keyed for both profiles", () => {
    expect(attestationFixture.schemaVersion).toBe(1);
    expect(attestationFixture.cases).toHaveLength(16);
    expect(new Set(attestationFixture.cases.map((row) => `${row.modelId}/${row.imageId}`)).size).toBe(16);
    for (const [id] of cases) expect(attestationFixture.cases.filter((row) => row.modelId === id)).toHaveLength(8);
  });
  for (const [id, file, fixtureName, digest] of cases) {
    it(`preserves the exact tested prompt artifact for ${id}`, () => {
      const prompt = readFileSync(new URL(`../../../docs/model-prompts/${file}`, import.meta.url), "utf8");
      expect(createHash("sha256").update(prompt).digest("hex")).toBe(digest);
      if (id === "qwen3-vl-2b-q4-head-f16-diagnostic") {
        // Historical captures keep their original model identity after its active profile is removed.
        expect(iouImagePromptByModel?.templates[id]).toBeUndefined();
      } else expect(iouImagePromptByModel?.templates[id]).toEqual({ template: prompt, includeRuleGuidance: false, output: "app" });
      expect(iouActionManifest.outputSchema["x-openchat-image-prompt-by-model"]).toBe(iouImagePromptByModel);
    });
    const fixture = JSON.parse(readFileSync(new URL(`../../../test/fixtures/openchat/model-acceptance/${fixtureName}`, import.meta.url), "utf8"));
    for (const row of fixture.cases) {
      it(`uses the production processor options on retained ${id} / ${row.imageId}`, () => {
        // Captured-output replay only, not fresh inference or the OpenChat envelope parser.
        const decoded = JSON.parse(row.raw.replace(/^\x60\x60\x60json\n([\s\S]+)\n\x60\x60\x60$/u, "$1"));
        const candidates = Array.isArray(decoded) ? decoded : [decoded];
        const before = JSON.stringify(candidates);
        const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
          actionId: iouActionManifest.id, input: { operation: "normalize_raw", modality: "image",
            sourceTimestamp: Date.parse(row.sourceTimestamp), candidates } }, binding, iouImageProcessorOptions);
        expect(result.kind).toBe("candidates");
        if (result.kind !== "candidates") throw new Error("Configured normalization failed");
        expect(result.sourceIndexes).toEqual([0]);
        expect(result.candidates).toHaveLength(1);
        expect(initToFormState(result.candidates[0], new Date(row.sourceTimestamp))).toMatchObject(row.expectedAppForm);
        // The old replay stopped at the editable form, which drops image_heading. Keep the
        // exact initial payload tested by Rust bound to current normalization as well.
        const attested = attestationFixture.cases.find((entry) => entry.modelId === id && entry.imageId === row.imageId);
        expect(attested).toBeDefined();
        expect(attested!.promptSha256).toBe(digest);
        const { direction } = iouActionManifest.outputSchema.properties as Record<string, Record<string, unknown>>;
        const expectedPayload = {
          direction: direction["x-openchat-default-for-image-only"],
          ...result.candidates[0],
        };
        const payload = JSON.parse(attested!.card.confirm_payload_json);
        expect(payload).toEqual(expectedPayload);
        expect(buildConfirmPayload(initToFormState(payload, new Date(row.sourceTimestamp))))
          .toEqual(JSON.parse(attested!.confirmation_json));
        expect(JSON.stringify(candidates)).toBe(before);
      });
    }
  }
  it("retains the smaller all-q4 Qwen's historical complete-row prompt and captures", () => {
    const prompt = readFileSync(new URL("../../../docs/model-prompts/qwen3-vl-2b-total-row-image.txt", import.meta.url), "utf8");
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(smallerQwenFixture.promptSha256);
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
    expect(smallerQwenFixture.cases.filter((row) => !row.repeated)).toHaveLength(8);
    expect(smallerQwenFixture.cases.filter((row) => row.repeated)).toHaveLength(2);
    expect(smallerQwenFixture.cases.filter((row) => row.knownMismatch)).toHaveLength(1);
  });
  it("maps small Qwen to the document-scoped absence-first four-key prompt", () => {
    const prompt = readFileSync(new URL("../../../docs/model-prompts/qwen3-vl-2b-document-scoped-image.txt", import.meta.url), "utf8");
    expect(createHash("sha256").update(prompt).digest("hex")).toBe(scopedQwenFixture.promptSha256);
    expect(iouImagePromptByModel!.templates[scopedQwenFixture.modelId])
      .toEqual({ template: prompt, includeRuleGuidance: false, output: "app" });
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
    expect(scopedQwenFixture.maxOutputTokens).toBe(96);
    expect(scopedQwenFixture.printedDirectionAcceptance).toBe(false);
    expect(scopedQwenFixture.cases.map(row => row.imageId))
      .toEqual(["absence", "two-invoices", "arabic", "payout", "arabic-repeat"]);
  });
  for (const row of scopedQwenFixture.cases) {
    it(`replays document-scoped smaller-Qwen capture: ${row.imageId}`, () => {
      // Actual complete model output and unchanged source expectations; no repair/salvage.
      expect(createHash("sha256").update(row.raw).digest("hex")).toBe(row.rawSha256);
      const candidates = JSON.parse(row.raw);
      expect(candidates).toEqual(row.expectedRaw);
      expect(row.cleanupConfirmed).toBe(true);
      expect(row.hiddenEvents).toBe(0);
      const before = JSON.stringify(candidates);
      const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
        actionId: iouActionManifest.id, input: { operation: "normalize_raw", modality: "image",
          sourceTimestamp: Date.parse(row.sourceTimestamp), candidates } }, binding, iouImageProcessorOptions);
      expect(result.kind).toBe("candidates");
      if (result.kind !== "candidates") throw new Error("Document-scoped Qwen normalization failed");
      expect(result.sourceIndexes).toEqual(row.expectedRaw.map((_, index) => index));
      expect(result.candidates).toHaveLength(row.expectedAppForms.length);
      expect(result.candidates.map(candidate => initToFormState(candidate, new Date(row.sourceTimestamp))))
        .toMatchObject(row.expectedAppForms);
      // No printed-direction inference is claimed; these forms retain the existing default.
      expect(result.candidates.every(candidate => !Object.hasOwn(candidate, "direction"))).toBe(true);
      expect(JSON.stringify(candidates)).toBe(before);
    });
  }
  for (const [index, row] of smallerQwenFixture.cases.entries()) {
    it(`replays actual smaller-Qwen capture ${index}: ${row.imageId}, preserving known misses`, () => {
      const candidates = [JSON.parse(row.raw.replace(/^\x60\x60\x60json\n([\s\S]+)\n\x60\x60\x60$/u, "$1"))];
      const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
        actionId: iouActionManifest.id, input: { operation: "normalize_raw", modality: "image",
          sourceTimestamp: Date.parse(row.sourceTimestamp), candidates } }, binding, iouImageProcessorOptions);
      if (result.kind !== "candidates") throw new Error("Smaller-Qwen normalization failed");
      expect(result.sourceIndexes).toEqual([0]);
      expect(result.candidates).toHaveLength(1);
      const form = initToFormState(result.candidates[0], new Date(row.sourceTimestamp));
      const { note, ...facts } = row.expectedAppForm;
      expect(form).toMatchObject(facts);
      if (row.knownMismatch) {
        // Characterize the retained failure, never redefine its source oracle as passing.
        expect(row.knownMismatch.field).toBe("note");
        expect(form.note).toBe(row.knownMismatch.actual);
        expect(form.note).not.toBe(note);
      } else expect(form.note).toBe(note);
    });
  }
  it("keeps unknown IDs on the unchanged canonical fallback", () => {
    expect(Object.keys(iouImagePromptByModel!.templates).sort()).toEqual([
      "gemma-4-e2b-it-q4", smallerQwenFixture.modelId,
    ].sort());
    expect(iouImagePromptByModel!.templates["qwen3-vl-2b-q4-head-f16-diagnostic"]).toBeUndefined();
    expect(iouImagePromptByModel!.templates["another-model"]).toBeUndefined();
    expect(iouActionManifest.outputSchema["x-openchat-image-prompt-template"]).toEqual({
      version: 1, template: IOU_IMAGE_EXTRACTION_PROMPT, includeRuleGuidance: false,
    });
    expect(iouActionManifest.outputSchema.required).toEqual(["amount", "kind", "direction"]);
  });
  it("keeps the complete registered response schema within the host's registration size limit", () => {
    expect(new TextEncoder().encode(JSON.stringify(iouActionManifest.outputSchema)).byteLength).toBeLessThanOrEqual(16384);
  });
  it("preserves ordinary multilingual formatting, joiners and valid Unicode pairs", () => {
    const changed = structuredClone(config);
    changed.templates["gemma-4-e2b-it-q4"].template = "اقرأ ال\u200dنص\nReturn JSON. \u{1f4dd}";
    expect(readIouModelImageProfiles(changed).promptExtension!.templates["gemma-4-e2b-it-q4"].template)
      .toBe(changed.templates["gemma-4-e2b-it-q4"].template);
  });
  it("can configure a canonical-output model without changing app or host code", () => {
    const profile = { template: "Return canonical fields.", output: "canonical", includeRuleGuidance: true };
    const changed = { ...config, templates: { "operator/canonical-model": profile } };
    expect(readIouModelImageProfiles(changed).promptExtension!.templates["operator/canonical-model"]).toEqual(profile);
  });
  it("opts into source details only through app-owned configuration without activating it", () => {
    for (const rawImageDetailsFormat of ["none", "source-v1", "labels-v1", "labels-v2"] as const) {
      const changed = { ...config, processorOptions: { ...config.processorOptions, rawImageDetailsFormat } };
      const before = JSON.stringify(changed);
      const parsed = readIouModelImageProfiles(changed);
      expect(parsed.processorOptions).toEqual(changed.processorOptions);
      expect(Object.isFrozen(parsed.processorOptions)).toBe(true);
      expect(JSON.stringify(changed)).toBe(before);
    }
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
    expect(readIouModelImageProfiles(config).promptExtension).toEqual(iouImagePromptByModel);
  });
  it("adds, changes and removes opaque IDs using data only without mutating its input", () => {
    const changed = structuredClone(config) as { schemaVersion: number; processorOptions: { rawImageMoneyFormat: string }; templates: Record<string, unknown> };
    changed.templates = { "operator/compatible-model@revision": {
      template: "Read the image as data. Return app JSON.", output: "app", includeRuleGuidance: false,
    } };
    const before = JSON.stringify(changed);
    expect(Object.keys(readIouModelImageProfiles(changed).promptExtension!.templates)).toEqual(["operator/compatible-model@revision"]);
    expect(JSON.stringify(changed)).toBe(before);
    changed.templates = {};
    expect(readIouModelImageProfiles(changed).promptExtension).toBeUndefined();
  });
  for (const [label, change] of [
    ["schema version", (x: any) => { x.schemaVersion = 2; }],
    ["format", (x: any) => { x.processorOptions.rawImageMoneyFormat = "guess"; }],
    ["details format", (x: any) => { x.processorOptions.rawImageDetailsFormat = "guess"; }],
    ["undefined details format", (x: any) => { x.processorOptions.rawImageDetailsFormat = undefined; }],
    ["extra processor option", (x: any) => { x.processorOptions.guessDirection = true; }],
    ["extra script", (x: any) => { x.script = "run.js"; }],
    ["too many models", (x: any) => { x.templates = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i}`, Object.values(config.templates)[0]])); }],
    ["bad ID", (x: any) => { x.templates = { "bad id": Object.values(config.templates)[0] }; }],
    ["blank prompt", (x: any) => { Object.values<any>(x.templates)[0].template = " "; }],
    ["oversized prompt", (x: any) => { Object.values<any>(x.templates)[0].template = "x".repeat(4097); }],
    ["oversized UTF-8 prompt", (x: any) => { Object.values<any>(x.templates)[0].template = "é".repeat(2200); }],
    ["oversized aggregate", (x: any) => { x.templates = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`m${i}`, { ...Object.values(config.templates)[0], template: "x".repeat(3000) }])); }],
    ["unsafe prompt", (x: any) => { Object.values<any>(x.templates)[0].template += "\u202e"; }],
    ["C1 control", (x: any) => { Object.values<any>(x.templates)[0].template += "\u0085"; }],
    ["direction mark", (x: any) => { Object.values<any>(x.templates)[0].template += "\u061c"; }],
    ["lone surrogate", (x: any) => { Object.values<any>(x.templates)[0].template += "\ud800"; }],
    ["output contract", (x: any) => { Object.values<any>(x.templates)[0].output = "executable"; }],
    ["extra profile field", (x: any) => { Object.values<any>(x.templates)[0].script = "run.js"; }],
  ] as const) {
    it(`rejects invalid ${label} configuration`, () => {
      const invalid = structuredClone(config);
      change(invalid);
      expect(() => readIouModelImageProfiles(invalid)).toThrow("Invalid IOU model image profile configuration");
    });
  }
});
