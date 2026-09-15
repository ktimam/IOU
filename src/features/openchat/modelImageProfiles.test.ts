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
  it("maps the smaller all-q4 Qwen to the exact tested complete-row profile", () => {
    const selected = iouImagePromptByModel!.templates[smallerQwenFixture.modelId];
    const prompt = readFileSync(new URL("../../../docs/model-prompts/qwen3-vl-2b-total-row-image.txt", import.meta.url), "utf8");
    expect(selected).toEqual({ template: prompt, includeRuleGuidance: false, output: "app" });
    expect(createHash("sha256").update(selected.template).digest("hex")).toBe(smallerQwenFixture.promptSha256);
    expect(selected.output).toBe("app");
    expect(selected.includeRuleGuidance).toBe(false);
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
    expect(smallerQwenFixture.cases.filter((row) => !row.repeated)).toHaveLength(8);
    expect(smallerQwenFixture.cases.filter((row) => row.repeated)).toHaveLength(2);
    expect(smallerQwenFixture.cases.filter((row) => row.knownMismatch)).toHaveLength(1);
  });
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
