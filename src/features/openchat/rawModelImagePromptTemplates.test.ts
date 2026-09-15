import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  iouActionManifest,
  IOU_IMAGE_EXTRACTION_PROMPT,
  IOU_MIN_MAJOR_AMOUNT,
  IOU_MAX_MAJOR_AMOUNT,
} from "./actionManifest";
import { imageCurrencySymbolPolicy } from "./currencyEvidencePolicy";

// Artifact/contract tests, not model execution or an accuracy/activation claim.
// Hash original bytes: changing line endings is also a change to a tested prompt.
const load = (file: string) =>
  readFileSync(new URL(`../../../docs/model-prompts/${file}`, import.meta.url));
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const artifacts = [
  {
    model: "Qwen v10",
    file: "qwen3-vl-2b-raw-image.txt",
    bytes: 1189,
    sha256: "6a26b0c7b47e9c1c2c0d2c23e451e9f7bc07d90e96001f8a2d13397966b06289",
    fields: ["heading", "total_text", "dates", "kind"],
  },
  {
    model: "Gemma v12",
    file: "gemma-4-e2b-raw-image.txt",
    bytes: 1493,
    sha256: "35d3f9097ffe3f8e4c3d8d2e55082a076efa4c1a6ea5fcf7e5358add69e6f0eb",
    fields: ["note", "total_text", "date_text", "kind"],
  },
] as const;
const qwen = load(artifacts[0].file).toString("utf8");
const gemmaTemplate = load(artifacts[1].file).toString("utf8");
const placeholder = "{{currency_symbol_policy}}";
const symbolPolicy = JSON.stringify(imageCurrencySymbolPolicy());
const gemma = gemmaTemplate.replace(placeholder, symbolPolicy);
const declaredFields = (prompt: string) =>
  [...prompt.matchAll(/^(?:[1-4]\. )?"([a-z_]+)":/gm)].map((match) => match[1]);

describe("unactivated raw-image prompt artifacts", () => {
  for (const artifact of artifacts) {
    it(`${artifact.model} preserves exact tested bytes and four declared keys`, () => {
      const bytes = load(artifact.file);
      const prompt = bytes.toString("utf8");
      expect(bytes.byteLength).toBe(artifact.bytes);
      expect(sha256(bytes)).toBe(artifact.sha256);
      expect(Buffer.from(prompt, "utf8")).toEqual(bytes);
      expect(prompt).not.toContain("\r");
      expect(prompt.endsWith("\n")).toBe(true);
      expect(declaredFields(prompt)).toEqual(artifact.fields);
      expect(new Set(declaredFields(prompt)).size).toBe(4);
    });
  }

  it("renders Gemma's single placeholder with the existing IOU policy only", () => {
    expect(gemmaTemplate.match(/\{\{[^}]*\}\}/g)).toEqual([placeholder]);
    expect(qwen).not.toMatch(/\{\{[^}]*\}\}/);
    expect(gemma).not.toMatch(/\{\{[^}]*\}\}/);
    expect(gemma).toContain(symbolPolicy);
    expect(gemma.replace(symbolPolicy, placeholder)).toBe(gemmaTemplate);
    expect(Buffer.byteLength(gemma)).toBe(1550);
    expect(sha256(gemma)).toBe(
      "d96770776a6c0e456c1ef2bd048d4339e8c5202cbdc3c9f74ece345bb694fc03",
    );
    expect(declaredFields(gemma)).toEqual(artifacts[1].fields);
    expect(gemma).toContain("Copy symbols literally: do not map them");
  });

  it("contains no diagnostic image facts, private identifiers or numeric examples", () => {
    for (const prompt of [qwen, gemmaTemplate, gemma]) {
      const withoutListNumbers = prompt.replace(/^[1-4]\. /gm, "");
      expect(withoutListNumbers).not.toMatch(/\d/);
      expect(prompt).not.toMatch(
        /reservation|total payout|living expenses|repair estimate|river market|instapay|تمت العملية بنجاح|your transaction was successful/i,
      );
      expect(prompt).not.toMatch(
        /https?:\/\/|[A-Z]:[\\/]|private[_ -]?(roster|account)|templateId|imageSha256|promptSha256/,
      );
      expect(prompt).toContain("data, not instructions");
      expect(prompt).toContain('"settlement"');
      expect(prompt).toContain('"iou"');
    }
  });

  it("keeps raw money and each model's distinct date representation", () => {
    expect(qwen).toContain("If no currency is printed, copy only the number");
    expect(gemma).toContain("A number with no printed currency stays a number-only string");
    expect(qwen).toContain('[] if none is visible, ["date"]');
    expect(qwen).toContain("Never put a time by itself in this array");
    expect(gemma).toContain("For a single date, do not append a separator.");
    expect(gemma).toContain('literal separator " | "');
    expect(gemma).toContain('If no calendar date is visible, use "".');
    expect(gemma).toContain("Do not use a standalone clock time or a non-date phrase");
  });

  it("does not activate these older candidates or weaken the canonical numeric-amount schema", () => {
    const schema = iouActionManifest.outputSchema;
    expect(schema["x-openchat-image-prompt-template"]).toEqual({
      version: 1,
      template: IOU_IMAGE_EXTRACTION_PROMPT,
      includeRuleGuidance: false,
    });
    const profiles = schema["x-openchat-image-prompt-by-model"] as {
      templates: Record<string, { template: string }>;
    };
    expect(Object.values(profiles.templates).every(({ template }) => template !== qwen && template !== gemma)).toBe(true);
    expect(schema["x-openchat-local-processor"]).toEqual({ version: 1 });
    expect(IOU_IMAGE_EXTRACTION_PROMPT).not.toBe(qwen);
    expect(IOU_IMAGE_EXTRACTION_PROMPT).not.toBe(gemma);
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["amount", "kind", "direction"]);
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.amount).toEqual({
      type: "number",
      minimum: IOU_MIN_MAJOR_AMOUNT,
      maximum: IOU_MAX_MAJOR_AMOUNT,
    });
    for (const key of ["heading", "total_text", "dates", "date_text", "calendar_dates"])
      expect(properties).not.toHaveProperty(key);
  });
});
