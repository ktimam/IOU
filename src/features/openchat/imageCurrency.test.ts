import { describe, expect, it } from "vitest";
import { IOU_CURRENCY_EVIDENCE_MAP } from "./actionManifest";
import { ISO_CURRENCIES } from "../settings/currencies";
import { normalizeImageCurrencyToken, type ImageCurrencyMapping } from "./imageCurrency";

describe("IOU image-model literal currency token normalization", () => {
  it("preserves every code already recognized by IOU without requiring a symbol alias", () => {
    for (const code of ISO_CURRENCIES) expect(normalizeImageCurrencyToken(code)).toBe(code);
    expect(normalizeImageCurrencyToken("EGP")).toBe("EGP");
  });

  it.each([
    ["$", "USD"], ["€", "EUR"], ["£", "GBP"], ["E£", "EGP"],
    ["ج.م", "EGP"], ["¥", "JPY"], ["₹", "INR"],
  ])("uses the existing exact app-owned mapping %s → %s", (token, code) => {
    expect(IOU_CURRENCY_EVIDENCE_MAP.some((entry) =>
      entry.value === code && entry.keywords.includes(token))).toBe(true);
    expect(normalizeImageCurrencyToken(token)).toBe(code);
  });

  it("does not create a second symbol map when the injected app map omits a token", () => {
    expect(normalizeImageCurrencyToken("$", [])).toBeUndefined();
    expect(normalizeImageCurrencyToken("EGP", [])).toBe("EGP");
  });

  it.each([
    "cp", "ecp", "tcp", "CP", "ECP", "TCP", "dollar", "dollars", "euro", "yen",
    "Egyptian pound", "US dollars", "pounds sterling", "rupees",
  ])("does not apply text or OCR-only alphabetic aliases to image-model token %s", (value) => {
    expect(normalizeImageCurrencyToken(value)).toBeUndefined();
  });

  it.each([
    undefined, null, 0, 12900, true, {}, { currency: "$" }, ["$"], ["EGP"],
    "", "usd", "egp", "ZZZ", "US$", "C$", "e£", "$$", "$1,912.15",
    "1912.15$", "USD$", "The currency is $", '"$"', "EGP/USD", "¥/CNY",
    " $", "$ ", " EGP ", "$\n", "\tEGP", "\u00a0$", "$\0", "$\u007f",
    "$\u0085", "\u202e$", "$\u202c", "\u2066EGP\u2069", "$\u200b", "$\ud800",
    "x".repeat(16) + "$",
  ])("rejects malformed, unknown, nested, ambiguous, or prose token %s", (value) => {
    expect(normalizeImageCurrencyToken(value)).toBeUndefined();
  });

  it("rejects aliases assigned to more than one recognized currency, independent of order", () => {
    const conflicting: ImageCurrencyMapping = [
      { value: "USD", keywords: ["$"] }, { value: "CAD", keywords: ["$"] },
    ];
    expect(normalizeImageCurrencyToken("$", conflicting)).toBeUndefined();
    expect(normalizeImageCurrencyToken("$", [...conflicting].reverse())).toBeUndefined();
  });

  it("does not treat repeated declarations for the same currency as a conflict", () => {
    expect(normalizeImageCurrencyToken("$", [
      { value: "USD", keywords: ["$", "$"] }, { value: "USD", keywords: ["$"] },
    ])).toBe("USD");
  });

  it.each(["ZZZ", "usd", "USD ", "USD\n", "CAD/USD"])(
    "rejects a matching alias with an invalid currency destination: %s", (destination) => {
      const mapping = [{ value: "USD", keywords: ["$"] }, { value: destination, keywords: ["$"] }];
      expect(normalizeImageCurrencyToken("$", mapping)).toBeUndefined();
      expect(normalizeImageCurrencyToken("$", [...mapping].reverse())).toBeUndefined();
    },
  );

  it("does not let an injected alphabetic alias remap a recognized ISO code", () => {
    expect(normalizeImageCurrencyToken("EGP", [{ value: "USD", keywords: ["EGP"] }])).toBe("EGP");
    expect(normalizeImageCurrencyToken("ecp", [{ value: "EGP", keywords: ["ecp"] }])).toBeUndefined();
  });

  it("bounds tokens even if the app's mapping contains an overlong or control-bearing alias", () => {
    for (const token of ["x".repeat(16) + "$", "$\n", "\u2066$\u2069", "a $ b"]) {
      expect(normalizeImageCurrencyToken(token, [{ value: "USD", keywords: [token] }])).toBeUndefined();
    }
    const boundary = "x".repeat(15) + "$";
    expect(normalizeImageCurrencyToken(boundary, [{ value: "USD", keywords: [boundary] }])).toBe("USD");
  });
});
