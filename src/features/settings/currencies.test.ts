import { describe, it, expect } from "vitest";
import { orderedCurrencies, ISO_CURRENCIES } from "./currencies";

describe("orderedCurrencies", () => {
  it("default first, then USD/EUR/GBP, then the rest alphabetically", () => {
    const list = orderedCurrencies("EGP");
    expect(list.slice(0, 4)).toEqual(["EGP", "USD", "EUR", "GBP"]);
    const tail = list.slice(4);
    expect(tail).toEqual([...tail].sort()); // alphabetical remainder
    expect(new Set(list).size).toBe(list.length); // no duplicates
    expect(list).toContain("JPY");
    expect(list.length).toBe(ISO_CURRENCIES.length); // comprehensive
  });

  it("dedups when the default is itself USD/EUR/GBP", () => {
    const list = orderedCurrencies("usd"); // case-insensitive
    expect(list.slice(0, 3)).toEqual(["USD", "EUR", "GBP"]);
    expect(list.filter((c) => c === "USD")).toHaveLength(1);
  });

  it("no default -> big three first; folds in sheet-local codes (uppercased)", () => {
    const list = orderedCurrencies(undefined, ["xyz", "USD"]);
    expect(list.slice(0, 3)).toEqual(["USD", "EUR", "GBP"]);
    expect(list).toContain("XYZ");
    expect(new Set(list).size).toBe(list.length);
  });
});
