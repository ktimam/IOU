import { describe, expect, it } from "vitest";
import { IOU_CURRENCY_EVIDENCE_MAP, IOU_IMAGE_EXTRACTION_PROMPT } from "./actionManifest";
import { imageCurrencySymbolPolicy, permittedImageCurrencyOutputs } from "./currencyEvidencePolicy";
import { checkPackagedResponse, parsePackagedExpectation, safePackagedExpectation } from "../../../scripts/live/packagedTransformersAcceptance";
import range from "./fixtures/packaged-worker-literal-currency-range-expectation.json";
import single from "./fixtures/packaged-worker-printed-full-timestamp-expectation.json";

const currencyPolicy = { version: 1, mode: "literal-or-declared-symbol" } as const;
const completion = (raw: Record<string, unknown>) => Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== null));

describe("prospective app-approved image currency policy (no model inference)", () => {
  it("puts classification first and declares symbol mapping without image-specific examples", () => {
    expect(IOU_IMAGE_EXTRACTION_PROMPT.match(/^"[a-z_]+":/gm)).toEqual([
      '"kind":', '"currency":', '"amount":', '"printed_date":', '"printed_end_date":', '"note":',
    ]);
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain('"$":"USD"');
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain("Use a mapping only when its exact symbol is visible");
    expect(IOU_IMAGE_EXTRACTION_PROMPT).toContain(JSON.stringify(imageCurrencySymbolPolicy()));
    expect(imageCurrencySymbolPolicy()).toEqual({ "$": "USD", "£": "GBP", "€": "EUR", "¥": "JPY",
      "₹": "INR", "E£": "EGP", "ج.م": "EGP" });
    for (const { keywords } of IOU_CURRENCY_EVIDENCE_MAP) {
      for (const token of keywords.filter(value => !/[\p{P}\p{S}]/u.test(value))) {
        expect(imageCurrencySymbolPolicy()).not.toHaveProperty(token);
      }
    }
  });

  it.each(["$", "USD"])("permits %s only for the verified dollar-symbol source and approved canonical USD", (currency) => {
    const expected = parsePackagedExpectation({ ...range, currencyPolicy });
    const text = JSON.stringify({ ...completion(expected.raw), currency });
    const result = checkPackagedResponse(text, expected);
    expect(result.exact).toBe(true);
    expect(result.currencyAccepted).toBe(true);
    expect(result.literalCurrencyAccepted).toBe(currency === "$");
    expect(safePackagedExpectation(expected).currencyPolicy).toEqual(currencyPolicy);
    expect(result.projected).toMatchObject({ amount: 1912.15, confirmedAmount: 1912.15,
      currency: "USD", confirmedCurrency: "USD", date: "2026-07-19", confirmedDate: "2026-07-19" });
    // The original literal-only contract is never retroactively loosened.
    expect(checkPackagedResponse(text, parsePackagedExpectation(range)).exact).toBe(currency === "$");
  });

  it("keeps an explicit EGP source literal and rejects a USD substitution", () => {
    const expected = parsePackagedExpectation({ ...single, currencyPolicy,
      card: { ...single.card, currency: "EGP" }, confirmed: { ...single.confirmed, currency: "EGP" } });
    const raw = completion(expected.raw);
    expect(checkPackagedResponse(JSON.stringify(raw), expected).exact).toBe(true);
    for (const currency of ["USD", "$", "EUR", "EGP/USD", "cp", undefined, null]) {
      expect(checkPackagedResponse(JSON.stringify({ ...raw, currency }), expected).exact).toBe(false);
    }
  });

  it.each(["CAD", "AUD", "EUR", "EGP", "C$", "US$", "$$", "dollars", "cp", "usd", "$ ", null, undefined])(
    "does not turn the dollar-symbol source into a blanket currency waiver: %s", (currency) => {
      const expected = parsePackagedExpectation({ ...range, currencyPolicy });
      expect(checkPackagedResponse(JSON.stringify({ ...completion(expected.raw), currency }), expected).exact).toBe(false);
    },
  );

  it.each([{ amount: 191215 }, { kind: "settlement" }, { printed_date: "Sun, Jul 12" },
    { printed_end_date: "" }, { note: "Invented heading" }])("preserves every other exact expected field: %j", (incorrect) => {
    const expected = parsePackagedExpectation({ ...range, currencyPolicy });
    expect(checkPackagedResponse(JSON.stringify({ ...completion(expected.raw), currency: "USD", ...incorrect }), expected).exact).toBe(false);
  });

  it.each([
    { ...range, currencyPolicy: null },
    { ...range, currencyPolicy: { ...currencyPolicy, version: 2 } },
    { ...range, currencyPolicy: { ...currencyPolicy, mode: "any-ISO" } },
    { ...range, currencyPolicy: { ...currencyPolicy, allow: ["CAD"] } },
    { ...range, currencyPolicy, card: { ...range.card, currency: "CAD" } },
    { ...range, currencyPolicy, confirmed: { ...range.confirmed, currency: "CAD" } },
    { ...range, currencyPolicy, raw: { ...range.raw, currency: "C$" } },
    { ...range, currencyPolicy, raw: { ...range.raw, currency: null } },
    { ...range, currencyPolicy, raw: { ...range.raw, currency: "cp" } },
  ])("rejects invalid opt-in metadata or an unjustified source-to-card mapping", value => {
    expect(() => parsePackagedExpectation(value)).toThrow("invalid expectation");
  });

  it("derives source-bound alternatives, never an unconditional USD allowance", () => {
    expect(permittedImageCurrencyOutputs("$")).toEqual(["$", "USD"]);
    expect(permittedImageCurrencyOutputs("€")).toEqual(["€", "EUR"]);
    expect(permittedImageCurrencyOutputs("EGP")).toEqual(["EGP"]);
    expect(permittedImageCurrencyOutputs("$", [])).toEqual([]);
    for (const token of ["C$", "cp", "dollars", "USD or CAD", "USD\n", undefined]) {
      expect(permittedImageCurrencyOutputs(token)).toEqual([]);
    }
    const conflict = [{ value: "USD", keywords: ["$"] }, { value: "CAD", keywords: ["$"] }];
    expect(permittedImageCurrencyOutputs("$", conflict)).toEqual([]);
    expect(() => imageCurrencySymbolPolicy(conflict)).toThrow("Invalid or conflicting");
    expect(imageCurrencySymbolPolicy([{ value: "USD", keywords: ["$", "$", "dollars"] }])).toEqual({ "$": "USD" });
  });

  it.each([
    [{ value: "ZZZ", keywords: ["$"] }],
    [{ value: "usd", keywords: ["$"] }],
    [{ value: "USD", keywords: ["$\n"] }],
    [{ value: "USD", keywords: ["a $ b"] }],
    [{ value: "USD", keywords: ["x".repeat(16) + "$"] }],
    Array.from({ length: 33 }, () => ({ value: "USD", keywords: ["$"] })),
    [{ value: "USD", keywords: Array.from({ length: 33 }, () => "$") }],
  ].map(mapping => ({ mapping })))("fails closed on malformed or unbounded prompt mapping data", ({ mapping }) => {
    expect(() => imageCurrencySymbolPolicy(mapping)).toThrow("Invalid or conflicting");
  });
});
