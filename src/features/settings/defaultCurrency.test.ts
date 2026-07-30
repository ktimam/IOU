import { describe, it, expect } from "vitest";
import {
  FALLBACK_CURRENCY,
  currencyFromUserRecord,
  normalizeCurrencyCode,
  reconcileDefaultCurrency,
} from "./defaultCurrency";

describe("normalizeCurrencyCode", () => {
  it("accepts a 3-letter code in any case, trimmed", () => {
    expect(normalizeCurrencyCode("egp")).toBe("EGP");
    expect(normalizeCurrencyCode("  Usd ")).toBe("USD");
    expect(normalizeCurrencyCode("EUR")).toBe("EUR");
  });

  it("rejects everything that is not a bare 3-letter code", () => {
    for (const junk of ["", "  ", "US", "USDD", "US1", "$", "usd usd", null, undefined, 5, {}, ["USD"]]) {
      expect(normalizeCurrencyCode(junk)).toBeUndefined();
    }
  });
});

describe("reconcileDefaultCurrency — the canister is the cross-device source of truth", () => {
  it("uses the canister value and does NOT push when it has one", () => {
    // The whole point: a device whose cache is stale adopts the newer choice made elsewhere.
    expect(reconcileDefaultCurrency("EGP", "USD")).toEqual({ use: "EGP" });
    // Even when they agree, there is nothing to write.
    expect(reconcileDefaultCurrency("EGP", "EGP")).toEqual({ use: "EGP" });
  });

  it("never lets a stale cache overwrite a newer canister value", () => {
    const r = reconcileDefaultCurrency("JPY", "EGP");
    expect(r.use).toBe("JPY");
    expect(r.push).toBeUndefined();
  });

  it("pushes the cached value up when the canister has nothing (the one-time migration)", () => {
    // An existing user whose default has only ever lived in this browser.
    expect(reconcileDefaultCurrency(undefined, "EGP")).toEqual({ use: "EGP", push: "EGP" });
    expect(reconcileDefaultCurrency([], "EGP")).toEqual({ use: "EGP", push: "EGP" });
    // An older canister with no such field at all.
    expect(reconcileDefaultCurrency(null, "  jpy ")).toEqual({ use: "JPY", push: "JPY" });
  });

  it("falls back and records the fallback when neither side is usable", () => {
    expect(reconcileDefaultCurrency(undefined, undefined)).toEqual({
      use: FALLBACK_CURRENCY,
      push: FALLBACK_CURRENCY,
    });
    expect(reconcileDefaultCurrency("junk", "also junk")).toEqual({
      use: FALLBACK_CURRENCY,
      push: FALLBACK_CURRENCY,
    });
  });

  it("ignores a junk canister value rather than adopting it", () => {
    // A garbage remote value must not win over a good local one.
    expect(reconcileDefaultCurrency("EGYPT", "EGP")).toEqual({ use: "EGP", push: "EGP" });
  });

  it("always resolves to a valid ISO code", () => {
    for (const [remote, local] of [
      ["EGP", "USD"],
      [undefined, "eur"],
      [[], ""],
      ["", ""],
    ] as Array<[unknown, unknown]>) {
      expect(reconcileDefaultCurrency(remote, local).use).toMatch(/^[A-Z]{3}$/);
    }
  });
});

describe("currencyFromUserRecord — candid opt unwrapping", () => {
  it("reads a present opt", () => {
    expect(currencyFromUserRecord({ default_currency: ["EGP"] })).toBe("EGP");
    expect(currencyFromUserRecord({ default_currency: ["egp"] })).toBe("EGP");
  });

  it("treats an empty opt, a missing field and a non-record as absent", () => {
    expect(currencyFromUserRecord({ default_currency: [] })).toBeUndefined();
    // An older canister build returns a UserRecord with no such field.
    expect(currencyFromUserRecord({ created_at: 1n })).toBeUndefined();
    expect(currencyFromUserRecord(null)).toBeUndefined();
    expect(currencyFromUserRecord(undefined)).toBeUndefined();
    expect(currencyFromUserRecord("EGP")).toBeUndefined();
  });

  it("rejects a junk value inside the opt", () => {
    expect(currencyFromUserRecord({ default_currency: ["EGYPT"] })).toBeUndefined();
    expect(currencyFromUserRecord({ default_currency: [42] })).toBeUndefined();
  });

  it("also accepts a bare string (a non-candid caller / already-unwrapped record)", () => {
    expect(currencyFromUserRecord({ default_currency: "EUR" })).toBe("EUR");
  });
});
