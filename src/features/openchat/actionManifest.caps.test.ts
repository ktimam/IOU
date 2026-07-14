// Template-routing caps/boundaries (≤50 mappings, ≤50 keywords each, ≤1000-char
// roster instruction) and resolvePublicOrigin. These mirror the on-chain
// register_ai_app validator limits, so a fire-and-forget re-register never
// silently exceeds them. Complements actionManifest.test.ts.

import { describe, it, expect, afterEach } from "vitest";
import {
  buildIouRules,
  buildIouOutputSchema,
  resolvePublicOrigin,
  IOU_EXTRACTION_RULES,
  type ManifestTemplate,
} from "./actionManifest";

function templates(n: number, keywordsEach = 2): ManifestTemplate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id-${i}`,
    name: `Type ${i}`,
    keywords: Array.from({ length: keywordsEach }, (_, k) => `kw${i}_${k}`),
  }));
}

function keywordMap(ts: ManifestTemplate[]) {
  const rule = buildIouRules(ts).find((r) => r.kind === "keyword_map" && r.field === "template");
  if (!rule || rule.kind !== "keyword_map") throw new Error("no template keyword_map");
  return rule.map;
}

describe("buildIouRules — static rules precede template routing", () => {
  it("keeps the static IOU vocabulary first, unchanged", () => {
    const rules = buildIouRules(templates(1));
    expect(rules.slice(0, IOU_EXTRACTION_RULES.length)).toEqual(IOU_EXTRACTION_RULES);
    // Then a keyword_map on `template` + a roster instruction.
    const tail = rules.slice(IOU_EXTRACTION_RULES.length);
    expect(tail.some((r) => r.kind === "keyword_map" && r.field === "template")).toBe(true);
    expect(tail.some((r) => r.kind === "instruction")).toBe(true);
  });

  it("adds no template rules when nothing is routable", () => {
    expect(buildIouRules([])).toEqual(IOU_EXTRACTION_RULES);
    expect(buildIouRules([{ id: "x", name: "X", keywords: [] }])).toEqual(IOU_EXTRACTION_RULES);
  });
});

describe("buildIouRules — validator caps", () => {
  it("caps the keyword_map at 50 mappings", () => {
    expect(keywordMap(templates(60))).toHaveLength(50);
  });

  it("caps each template's keywords at 50", () => {
    const map = keywordMap(templates(1, 60));
    expect(map[0].keywords).toHaveLength(50);
  });

  it("truncates the roster instruction to ≤1000 chars (ellipsis when clipped)", () => {
    const rules = buildIouRules(templates(50, 6));
    const instr = rules.filter((r) => r.kind === "instruction").at(-1);
    expect(instr && instr.kind === "instruction").toBe(true);
    if (instr && instr.kind === "instruction") {
      expect(instr.text.length).toBeLessThanOrEqual(1000);
      expect(instr.text.endsWith("...")).toBe(true);
    }
  });

  it("excludes keyword-less templates from the map and the schema", () => {
    const mixed: ManifestTemplate[] = [
      { id: "a", name: "Rent", keywords: ["rent"] },
      { id: "b", name: "Nope", keywords: [] },
    ];
    expect(keywordMap(mixed)).toEqual([{ value: "Rent", keywords: ["rent"] }]);
    expect((buildIouOutputSchema(mixed).properties as Record<string, unknown>).template).toEqual({ type: "string" });
    // No routable template at all → no `template` schema property.
    expect(
      (buildIouOutputSchema([{ id: "b", name: "Nope", keywords: [] }]).properties as Record<string, unknown>).template,
    ).toBeUndefined();
  });
});

describe("resolvePublicOrigin", () => {
  const saved = process.env.OC_APP_PUBLIC_ORIGIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.OC_APP_PUBLIC_ORIGIN;
    else process.env.OC_APP_PUBLIC_ORIGIN = saved;
  });

  it("defaults to the dev origin (scheme+host+port load-bearing)", () => {
    delete process.env.OC_APP_PUBLIC_ORIGIN;
    expect(resolvePublicOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("honours OC_APP_PUBLIC_ORIGIN and strips a trailing slash", () => {
    process.env.OC_APP_PUBLIC_ORIGIN = "https://iou.example.com/";
    expect(resolvePublicOrigin()).toBe("https://iou.example.com");
  });
});
