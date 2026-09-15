import { describe, expect, it } from "vitest";
import { matchTemplateForDraft, resolveTemplateBase, templateEvidenceForImport } from "../entries/resolveTemplateBase";
import type { Direction } from "../entries/types";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { buildConfirmPayload, buildMultiConfirmPayload, initEntries, initToFormState } from "./cardBridge";
import { hydrateSavedTypeForCard } from "./OpenChatCardPage";
import { iouActionManifest } from "./actionManifest";
import { processIouRequest } from "./localProcessorBridge";

// Constructed IOU-only contract tests, not recorded/fresh model accuracy or private-context
// authentication tests. The caller supplies its private roster after extraction. Heading and
// memo remain separate evidence; only the reviewed memo is retained in confirmation data.
function savedType(id: string, name: string, direction: Direction, keywords: string[] = []): TxnTemplate {
  return { id, name, direction, keywords, txn_type: "iou" };
}

const violet = savedType("private-violet", "Violet account bucket", "debt", ["Violet cable"]);
const copper = savedType("private-copper", "Copper account bucket", "credit", ["Copper lantern"]);
const rowLocal = { evidence: "row-local", allowImageHeading: true } as const;
const imageFull = { allowImageHeading: true } as const;

describe("separate image heading evidence for private saved types", () => {
  for (const direction of ["debt", "credit"] as const) {
    it.each(["name", "keyword"] as const)(`matches arbitrary private %s with ${direction} direction`, vocabulary => {
      const template = savedType(`private-${direction}`, "Indigo account category", direction, ["Amber equipment"]);
      const heading = vocabulary === "name" ? template.name : template.keywords![0];
      const raw = { note: "A source memo without a category", image_heading: `  ${heading}  ` };
      expect(matchTemplateForDraft([template], raw, rowLocal)).toBe(template);
      expect(raw.note).toBe("A source memo without a category");
      expect(raw.image_heading).toBe(`  ${heading}  `);
    });
  }

  it("cannot select a type absent from the caller's private roster", () => {
    const raw = { image_heading: "Violet cable", note: "A separate memo" };
    expect(matchTemplateForDraft([], raw, rowLocal)).toBeUndefined();
    expect(matchTemplateForDraft([copper], raw, rowLocal)).toBeUndefined();
  });

  it("ignores image headings by default on direct paste and connector import paths", () => {
    const raw = { note: "A separate memo", image_heading: "Violet cable" };
    for (const options of [{}, { evidence: "full" as const }, { evidence: "row-local" as const },
      { evidence: "row-local" as const, allowImageHeading: false }]) {
      expect(matchTemplateForDraft([violet], raw, options)).toBeUndefined();
      expect(resolveTemplateBase([violet], raw, options)).toEqual({});
    }
    expect(matchTemplateForDraft([violet], raw, rowLocal)).toBe(violet);
    // A conflicting untrusted extra must not suppress the existing legitimate note match either.
    expect(matchTemplateForDraft([violet, copper], {
      note: "Copper lantern", image_heading: "Violet cable",
    }, { evidence: "row-local" })).toBe(copper);
  });

  it("counts a type once even when its name and repeated keywords match both fields", () => {
    const repeated = { ...violet, keywords: ["Violet cable", "violet CABLE", "Violet account bucket"] };
    expect(matchTemplateForDraft([repeated], {
      note: "Violet cable", image_heading: "Violet account bucket",
    }, rowLocal)).toBe(repeated);
  });

  it.each([[violet, copper], [copper, violet]])("rejects conflicting note/heading matches regardless of roster order: %j", (...templates) => {
    expect(matchTemplateForDraft(templates, {
      note: "Violet cable", image_heading: "Copper lantern",
    }, rowLocal)).toBeUndefined();
  });

  it("never fabricates a keyword phrase across evidence fields", () => {
    const phrase = savedType("private-phrase", "Unrelated category", "debt", ["Violet cable"]);
    expect(matchTemplateForDraft([phrase], { note: "Violet", image_heading: "cable" }, rowLocal)).toBeUndefined();
    expect(matchTemplateForDraft([phrase], { message: "Violet", image_heading: "cable" }, imageFull)).toBeUndefined();
  });

  it("retains complete-word and literal-phrase matching for headings", () => {
    expect(matchTemplateForDraft([violet], { image_heading: "Violet cables" }, rowLocal)).toBeUndefined();
    expect(matchTemplateForDraft([violet], { image_heading: "(VIOLET CABLE)" }, rowLocal)).toBe(violet);
    const literal = savedType("private-literal", "Different category", "debt", ["A+B"]);
    expect(matchTemplateForDraft([literal], { image_heading: "A+B" }, rowLocal)).toBe(literal);
    expect(matchTemplateForDraft([literal], { image_heading: "AAAB" }, rowLocal)).toBeUndefined();
  });

  it.each([
    undefined, null, false, 12, [], { text: "Violet cable" }, "", "   ",
    "Violet cable\n", "Violet cable\r", "Violet\tcable", "Violet cable\0",
    "Violet cable\u007f", "Violet cable\u0085", "Violet cable\u2028", "Violet cable\u2029",
    `Violet cable ${"x".repeat(201)}`,
  ].map(image_heading => ({ image_heading })))("ignores malformed heading evidence without changing valid memo matching: $image_heading", ({ image_heading }) => {
    expect(matchTemplateForDraft([violet], { image_heading }, rowLocal)).toBeUndefined();
    expect(matchTemplateForDraft([violet], { image_heading, note: "Violet cable" }, rowLocal)).toBe(violet);
  });

  it("preserves existing full-message precedence and row-local note routing", () => {
    const raw = { message: "Violet cable", note: "Copper lantern" };
    expect(matchTemplateForDraft([violet, copper], raw)).toBe(violet);
    expect(matchTemplateForDraft([violet, copper], raw, rowLocal)).toBe(copper);
    expect(matchTemplateForDraft([copper], { message: "  ", note: "Copper lantern" })).toBe(copper);
    expect(matchTemplateForDraft([violet, copper], {
      ...raw, image_heading: "Copper lantern",
    }, imageFull)).toBeUndefined();
    expect(matchTemplateForDraft([violet, copper], {
      ...raw, image_heading: "Copper lantern",
    }, rowLocal)).toBe(copper);
    expect(templateEvidenceForImport("openchat", false)).toBe("row-local");
  });
});

describe("image heading supports IOU type matching without replacing the reviewed note", () => {
  it.each(["text", "audio", "image"] as const)("uses actual %s normalization before private card hydration", modality => {
    const raw = {
      kind: "iou", amount: 48.75, currency: "CAD", date: "2026-09-10", direction: "credit",
      note: "Parts for the workshop", image_heading: "Violet cable",
    };
    const binding = { frameNonce: "a".repeat(48), requestNonce: "b".repeat(48) };
    const result = processIouRequest({ type: "oc:app-process:request", version: 1, ...binding,
      actionId: iouActionManifest.id, input: { operation: "normalize", modality, candidates: [raw] } }, binding);
    if (result.kind !== "candidates" || result.candidates.length !== 1) throw new Error("Expected one normalized candidate");
    const candidate = result.candidates[0];
    const initial = initToFormState(candidate);
    const hydrated = hydrateSavedTypeForCard(initial, candidate, [violet]);
    if (modality === "image") {
      expect(candidate.image_heading).toBe(raw.image_heading);
      expect(hydrated.templateId).toBe(violet.id);
      expect(hydrated.direction).toBe("debt");
    } else {
      expect(candidate).not.toHaveProperty("image_heading");
      expect(hydrated).toEqual(initial);
      expect(hydrated.templateId).toBeUndefined();
    }
    const confirmed = buildConfirmPayload(hydrated);
    expect(confirmed.note).toBe(raw.note);
    expect(confirmed).not.toHaveProperty("image_heading");
    expect(raw.image_heading).toBe("Violet cable");
  });

  it.each(["debt", "credit"] as const)("hydrates %s direction from a heading while confirming the unchanged memo", direction => {
    const template = savedType("private-heading-type", "Invisible account category", direction, ["Amber equipment"]);
    const raw = {
      kind: "iou" as const, amount: 48.75, currency: "CAD", date: "2026-09-10",
      direction: direction === "debt" ? "credit" as const : "debt" as const,
      note: "Parts for the workshop", image_heading: "Amber equipment",
    };
    const before = structuredClone(raw);
    const initial = initToFormState(raw);
    const hydrated = hydrateSavedTypeForCard(initial, raw, [template], rowLocal);
    expect(hydrated.templateId).toBe(template.id);
    expect(hydrated.direction).toBe(direction);
    expect(hydrated.note).toBe(raw.note);
    expect(hydrated).not.toHaveProperty("image_heading");
    const confirmed = buildConfirmPayload(hydrated);
    expect(confirmed).toEqual({ kind: "iou", amount: 48.75, currency: "CAD", date: "2026-09-10", direction, note: raw.note });
    for (const key of ["image_heading", "templateId", "template", "template_ref"]) expect(confirmed).not.toHaveProperty(key);
    expect(JSON.stringify(confirmed)).not.toContain(template.id);
    expect(JSON.stringify(confirmed)).not.toContain(template.name);
    expect(raw).toEqual(before);
  });

  it("leaves a conflicting heading/memo type unselected and preserves the original direction", () => {
    const raw = { note: "Violet cable", image_heading: "Copper lantern", direction: "debt" as const };
    const initial = initToFormState(raw);
    expect(hydrateSavedTypeForCard(initial, raw, [violet, copper], rowLocal)).toEqual(initial);
    expect(buildConfirmPayload(initial).note).toBe(raw.note);
  });

  it("matches each multi-row heading without borrowing a sibling keyword from shared message", () => {
    const rows = ["Violet cable", "Copper lantern", "No matching category"].map((image_heading, index) => ({
      kind: "iou" as const, amount: 75, currency: "CAD", direction: "debt" as const,
      date: "2026-09-10", note: `Separate memo ${index + 1}`, image_heading,
      message: "Violet cable and Copper lantern",
    }));
    const states = initEntries({ entries: rows });
    if (!states) throw new Error("Expected multi-card state");
    const hydrated = states.map((state, index) => hydrateSavedTypeForCard(state, rows[index], [violet, copper], rowLocal));
    expect(hydrated.map(state => state.templateId)).toEqual([violet.id, copper.id, undefined]);
    expect(hydrated.map(state => state.direction)).toEqual(["debt", "credit", "debt"]);
    const confirmed = buildMultiConfirmPayload(hydrated);
    expect(confirmed).toHaveLength(3);
    expect(confirmed.map(row => row.note)).toEqual(rows.map(row => row.note));
    expect(confirmed.map(row => row.direction)).toEqual(["debt", "credit", "debt"]);
    for (const row of confirmed) {
      expect(row).not.toHaveProperty("image_heading");
      expect(row).not.toHaveProperty("templateId");
    }
    const surviving = initEntries({ entries: [rows[2]] });
    if (!surviving) throw new Error("Expected filtered one-row state");
    expect(hydrateSavedTypeForCard(surviving[0], rows[2], [violet, copper], rowLocal).templateId).toBeUndefined();
  });
});
