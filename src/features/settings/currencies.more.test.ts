// Additional orderedCurrencies edges + ISO list integrity. Complements
// currencies.test.ts.

import { describe, it, expect } from "vitest";
import { orderedCurrencies, ISO_CURRENCIES, COMMON_CURRENCIES } from "./currencies";

describe("ISO_CURRENCIES integrity", () => {
  it("is all-uppercase 3-letter codes with no duplicates", () => {
    for (const c of ISO_CURRENCIES) expect(c).toMatch(/^[A-Z]{3}$/);
    expect(new Set(ISO_CURRENCIES).size).toBe(ISO_CURRENCIES.length);
  });
  it("contains every COMMON currency", () => {
    for (const c of COMMON_CURRENCIES) expect(ISO_CURRENCIES).toContain(c);
  });
});

describe("orderedCurrencies — edges", () => {
  it("puts a non-big-three default first without duplicating it in the tail", () => {
    const list = orderedCurrencies("JPY");
    expect(list.slice(0, 4)).toEqual(["JPY", "USD", "EUR", "GBP"]);
    expect(list.filter((c) => c === "JPY")).toHaveLength(1);
    expect(list.length).toBe(ISO_CURRENCIES.length);
  });

  it("adds a default that isn't in the ISO list (grows the pool by one, still first)", () => {
    const list = orderedCurrencies("xbt"); // not a real ISO code
    expect(list[0]).toBe("XBT");
    expect(list.length).toBe(ISO_CURRENCIES.length + 1);
    expect(list.filter((c) => c === "XBT")).toHaveLength(1);
  });

  it("uppercases and dedups `extra`, ignoring blank entries", () => {
    const list = orderedCurrencies(undefined, ["", "   ", "usd", "zzz", "ZZZ"]);
    expect(list).toContain("ZZZ");
    expect(list.filter((c) => c === "ZZZ")).toHaveLength(1);
    expect(list).not.toContain("");
    // USD stays a single entry even though it was passed as extra.
    expect(list.filter((c) => c === "USD")).toHaveLength(1);
    expect(new Set(list).size).toBe(list.length);
  });

  it("no-args ordering is deterministic (big three, then alphabetical)", () => {
    const list = orderedCurrencies();
    expect(list.slice(0, 3)).toEqual(["USD", "EUR", "GBP"]);
    const tail = list.slice(3);
    expect(tail).toEqual([...tail].sort());
  });
});
