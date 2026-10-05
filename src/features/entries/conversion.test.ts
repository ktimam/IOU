import { describe, expect, it } from "vitest";
import { resolveConversion, savedConversion, type ConversionDraft } from "./conversion";

const draft: ConversionDraft = {
  base: "USD", quote: "EGP", kind: "rate", value: "49.12",
  source: "manual", updatedAt: 1700000000000,
};

describe("manual conversion", () => {
  it("calculates from an editable rate and marks its provenance", () => {
    expect(resolveConversion(draft, 10000)).toEqual({
      convertedMinor: 491200,
      rate: { base: "USD", quote: "EGP", rate: 49.12, source: "manual", fetchedAt: draft.updatedAt },
    });
  });
  it("derives the rate from a manually entered converted amount", () => {
    const amount = { ...draft, kind: "amount" as const, value: "12900.25" };
    const result = resolveConversion(amount, 30000)!;
    expect(result.convertedMinor).toBe(1290025);
    expect(Math.round(result.rate.rate * 30000)).toBe(1290025);
    // Changing the original amount preserves the user's target amount, updating the rate.
    expect(resolveConversion(amount, 60000)?.convertedMinor).toBe(1290025);
    expect(resolveConversion(amount, 60000)?.rate.rate).toBe(result.rate.rate / 2);
  });
  it("keeps a manually entered rate fixed when the original amount changes", () => {
    expect(resolveConversion(draft, 20000)?.convertedMinor).toBe(982400);
  });
  it.each(["rate", "amount"] as const)("rejects invalid %s input", (kind) => {
    for (const value of ["", " ", "0", "-1", "NaN", "Infinity", "oops", "1e300"]) {
      expect(resolveConversion({ ...draft, kind, value }, 10000)).toBeNull();
    }
    for (const amount of [0, -100, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(resolveConversion({ ...draft, kind }, amount)).toBeNull();
    }
    expect(resolveConversion({ ...draft, kind, value: "0.00000001" }, 10000)).toBeNull();
  });
  it("restores saved rate/source/time without fetching a replacement", () => {
    expect(savedConversion({
      from_currency: "USD", from_amount_minor: 10000,
      to_currency: "EGP", to_amount_minor: 491200,
      rate: 49.12, rate_source: "manual", rate_fetched_at: draft.updatedAt,
    })).toEqual({ ...draft, savedAmounts: { from: 10000, to: 491200 } });
    expect(savedConversion()).toBeNull();
  });
  it("preserves saved exact amounts on edit without rounding through the stored rate again", () => {
    const saved = savedConversion({
      from_currency: "USD", from_amount_minor: 100,
      to_currency: "EGP", to_amount_minor: 4503599627370495,
      rate: 4503599627370495 / 100, rate_source: "manual", rate_fetched_at: draft.updatedAt,
    });
    expect(resolveConversion(saved, 100)?.convertedMinor).toBe(4503599627370495);
    // An actual change to the source amount recalculates using the saved rate.
    expect(resolveConversion(saved, 50)?.convertedMinor).toBe(Math.round(50 * Number(saved!.value)));
  });
});
