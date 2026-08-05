import { afterEach, describe, expect, it } from "vitest";
import {
  buildIouOutputSchema,
  buildIouRules,
  IOU_EXTRACTION_RULES,
  resolvePublicOrigin,
  type ManifestTemplate,
} from "./actionManifest";

describe("public manifest privacy boundaries", () => {
  const privateTemplates: ManifestTemplate[] = Array.from({ length: 60 }, (_, i) => ({
    id: `private-${i}`,
    name: `Private type ${i}`,
    keywords: [`private-keyword-${i}`, "=formula-like-keyword"],
  }));

  it("keeps the static rules unchanged even when private templates are supplied", () => {
    expect(buildIouRules(privateTemplates)).toEqual(IOU_EXTRACTION_RULES);
  });

  it("does not serialize names, keywords, ids or a template schema field", () => {
    const serialized = JSON.stringify({
      rules: buildIouRules(privateTemplates),
      schema: buildIouOutputSchema(privateTemplates),
    });
    expect(serialized).not.toContain("Private type");
    expect(serialized).not.toContain("private-keyword");
    expect(serialized).not.toContain("private-");
    expect((buildIouOutputSchema(privateTemplates).properties as Record<string, unknown>).template)
      .toBeUndefined();
  });
});

describe("resolvePublicOrigin", () => {
  const saved = process.env.OC_APP_PUBLIC_ORIGIN;
  afterEach(() => {
    if (saved === undefined) delete process.env.OC_APP_PUBLIC_ORIGIN;
    else process.env.OC_APP_PUBLIC_ORIGIN = saved;
  });

  it("defaults to the dev origin", () => {
    delete process.env.OC_APP_PUBLIC_ORIGIN;
    expect(resolvePublicOrigin()).toBe("http://127.0.0.1:3000");
  });

  it("honours OC_APP_PUBLIC_ORIGIN and strips a trailing slash", () => {
    process.env.OC_APP_PUBLIC_ORIGIN = "https://iou.example.com/";
    expect(resolvePublicOrigin()).toBe("https://iou.example.com");
  });
});
