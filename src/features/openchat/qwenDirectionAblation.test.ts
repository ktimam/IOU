import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import baseline from "../../../docs/model-prompts/direction-v1-grouping-candidate.json";
import a from "../../../docs/model-prompts/qwen-five-field-ablation-a-compact-candidate.json";
import b from "../../../docs/model-prompts/qwen-five-field-ablation-b-direction-candidate.json";
import protocol from "../../../docs/model-prompts/qwen-five-field-ablations-20261005.json";
import { readIouModelImageProfiles, iouImageProcessorOptions } from "./modelImageProfiles";
import { processLocalArtifactRequest } from "./localProcessorArtifact";
import { gradeExactRawImageFacts } from "./rawImageFactualGrade";

const model = "qwen3-vl-2b-instruct-q4";
const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const oldFormat = "No explanations, invented values or markdown.";
const newFormat = "Use compact single-line JSON with no whitespace outside strings and no markdown or code fences. No explanations or invented values.";
const oldDirection = '"direction_text": start with "". Replace it only when the image itself contains an explicit statement of who owes whom; copy that printed statement without a field label. Keep "" when there is no such printed statement. Do not infer it from payment status, document kind, names, bank accounts or arrows.';
const newDirection = '"direction_text": for each entry, read its own image block for a printed statement that explicitly says who owes whom. Copy that statement verbatim, without its field label. Do not replace a printed statement with "". Use "" only when that entry has no such printed statement. Do not infer it from payment status, document kind, names, bank accounts or arrows.';

describe("prospective independent inactive Qwen five-field ablations", () => {
  it("A changes formatting only, including byte-identical direction instructions", () => {
    expect(a).toEqual({ ...baseline, templates: { ...baseline.templates, [model]: {
      ...baseline.templates[model], template: baseline.templates[model].template.replace(oldFormat, newFormat),
    } } });
    expect(a.templates[model].template).toContain(oldDirection);
    expect(a.templates[model].template).not.toContain(newDirection);
  });
  it("B changes only direction copying, not formatting or A's instruction", () => {
    expect(b).toEqual({ ...baseline, templates: { ...baseline.templates, [model]: {
      ...baseline.templates[model], template: baseline.templates[model].template.replace(oldDirection, newDirection),
    } } });
    expect(b.templates[model].template).toContain(oldFormat);
    expect(b.templates[model].template).not.toContain(newFormat);
  });
  it.each([{ profile: a, declaration: protocol.ablations[0] }, { profile: b, declaration: protocol.ablations[1] }])("pins and validates $declaration.id without activating it", ({ profile, declaration }) => {
    expect(sha(readFileSync(new URL(`../../../docs/model-prompts/${declaration.file}`, import.meta.url)))).toBe(declaration.sha256);
    expect(sha(profile.templates[model].template)).toBe(declaration.promptSha256);
    expect(profile.templates["gemma-4-e2b-it-q4"]).toEqual(baseline.templates["gemma-4-e2b-it-q4"]);
    expect(readIouModelImageProfiles(profile).processorOptions).toEqual(protocol.processorOptions);
    expect(profile.processorOptions).not.toHaveProperty("rawImageValuesRowFormat");
    expect(iouImageProcessorOptions).toEqual({ rawImageMoneyFormat: "total-row" });
    expect(sha(readFileSync(new URL("./modelImageProfiles.json", import.meta.url)))).toBe("e8291225e81419a051cb9c48934211e15c012c29a5d3680e2ef7976d035667a3");
  });
  it("contains no literal fixture answers in either changed instruction", () => {
    for (const text of [newFormat, newDirection]) for (const forbidden of ["You owe", "Owed to you", "Reservation", "Invoice", "12900", "123.45", "42.75", "October", "USD", "EUR", "EGP"])
      expect(text).not.toContain(forbidden);
    expect(protocol.runtime.maxOutputTokens).toBe(96); expect(protocol.runtime.qwenContextGuard).toBe(1024);
  });
  it.each(protocol.matrix)("retains exact authored source grammar and one-to-one projection for $id (not model inference)", fixture => {
    const raw = JSON.stringify(fixture.expected);
    expect(gradeExactRawImageFacts(raw, fixture.expected)).toEqual({ passed: true, issues: [] });
    expect(fixture.imageSha256).toMatch(/^[a-f0-9]{64}$/u);
    for (const row of fixture.expected) {
      expect(Object.keys(row)).toEqual(protocol.grammar.keys);
      expect(Array.isArray(row.dates)).toBe(true); expect(row.dates.length).toBeLessThanOrEqual(2);
    }
    const result = processLocalArtifactRequest({ type: "oc:local-process:request", version: 1, actionId: "iou.entry.import",
      input: { operation: "normalize_raw", modality: "image", candidates: fixture.expected, sourceTimestamp: Date.parse(fixture.sourceTimestamp) },
    }, readIouModelImageProfiles(a).processorOptions);
    expect(result.kind).toBe("candidates");
    if (result.kind !== "candidates" || !("candidates" in result)) throw new Error("Expected valid authored oracle");
    expect(result.candidates).toHaveLength(fixture.expected.length);
    expect(result.sourceIndexes).toEqual(fixture.expected.map((_, index) => index));
    if (fixture.id === "absent-direction-no-date-unmatched") expect(result.candidates[0]).not.toHaveProperty("date");
    if (fixture.id === "original-payout-period") expect(result.candidates[0]).toMatchObject({ date: "2026-07-19", note: fixture.expectedAppNote });
  });
  it("fails independent source assertions for omitted direction, invented negative evidence, merged dates and missing rows", () => {
    const two = protocol.matrix[0].expected;
    const omitted = structuredClone(two); omitted[0].direction_text = "";
    expect(gradeExactRawImageFacts(JSON.stringify(omitted), two)).toEqual({ passed: false, issues: ["$[0].direction_text:value"] });
    const merged = structuredClone(two); merged[0].dates.push(two[1].dates[0]);
    expect(gradeExactRawImageFacts(JSON.stringify(merged), two).passed).toBe(false);
    expect(gradeExactRawImageFacts(JSON.stringify(two.slice(0, 1)), two).passed).toBe(false);
    const absent = protocol.matrix.find(item => item.id === "absent-direction-no-date-unmatched")!.expected;
    const invented = structuredClone(absent); invented[0].direction_text = "Owed to you";
    expect(gradeExactRawImageFacts(JSON.stringify(invented), absent).passed).toBe(false);
  });
});
