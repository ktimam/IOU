import { ISO_CURRENCIES } from "../settings/currencies";

export type ImageCurrencyMapping = ReadonlyArray<{ value: string; keywords: readonly string[] }>;

// One IOU-owned vocabulary shared by existing text/OCR rules and image normalization. Image
// prompts expose only the bounded symbol subset, never the alphabetic or OCR-only aliases.
export const IOU_CURRENCY_EVIDENCE_MAP: { value: string; keywords: string[] }[] = [
  { value: "USD", keywords: ["$", "dollar", "dollars", "US dollar", "US dollars"] },
  { value: "GBP", keywords: ["£", "pound sterling", "pounds sterling"] },
  { value: "EUR", keywords: ["€", "euro", "euros"] },
  { value: "JPY", keywords: ["¥", "yen"] },
  { value: "INR", keywords: ["₹", "rupee", "rupees"] },
  {
    value: "EGP",
    // Existing OCR-only exact misreads remain available to the established OCR rules, not images.
    keywords: ["E£", "Egyptian pound", "Egyptian pounds", "ج.م", "cp", "ecp", "tcp"],
  },
];

const ISO_CODES = new Set(ISO_CURRENCIES);
const MAX_TOKEN_LENGTH = 16;

function isBoundedToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH &&
    !/[\s\p{Cc}\p{Cf}\p{Cs}]/u.test(value);
}

/** Existing token normalization; a recognized token is not independent proof of image accuracy. */
export function normalizeImageCurrencyToken(
  value: unknown,
  mapping: ImageCurrencyMapping = IOU_CURRENCY_EVIDENCE_MAP,
): string | undefined {
  if (!isBoundedToken(value)) return undefined;
  if (ISO_CODES.has(value)) return value;
  if (!/[\p{P}\p{S}]/u.test(value)) return undefined;
  const matches = new Set<string>();
  for (const entry of mapping) {
    if (!entry.keywords.includes(value)) continue;
    if (!ISO_CODES.has(entry.value)) return undefined;
    matches.add(entry.value);
    if (matches.size > 1) return undefined;
  }
  return matches.size === 1 ? matches.values().next().value : undefined;
}

/** App-owned prompt data, not evidence that any listed currency is present in an image. */
export function imageCurrencySymbolPolicy(
  mapping: ImageCurrencyMapping = IOU_CURRENCY_EVIDENCE_MAP,
): Record<string, string> {
  const invalid = () => { throw new Error("Invalid or conflicting image currency symbol policy"); };
  if (!Array.isArray(mapping) || mapping.length > 32) return invalid();
  const symbols = new Set<string>();
  for (const entry of mapping) {
    if (entry === null || typeof entry !== "object" || !Array.isArray(entry.keywords) ||
        entry.keywords.length > 32) return invalid();
    for (const token of entry.keywords) {
      if (typeof token !== "string") return invalid();
      if (!/[\p{P}\p{S}]/u.test(token)) continue; // Text/OCR-only aliases are deliberately not exposed.
      if (!isBoundedToken(token)) return invalid();
      symbols.add(token);
      if (symbols.size > 32) return invalid();
    }
  }
  const entries = [...symbols].map((symbol) => {
    const code = normalizeImageCurrencyToken(symbol, mapping);
    if (code === undefined) return invalid();
    return [symbol, code] as const;
  });
  return Object.fromEntries(entries);
}

/** For source-bound tests only: sourceToken must come from reviewed image evidence, not the model. */
export function permittedImageCurrencyOutputs(
  sourceToken: unknown,
  mapping: ImageCurrencyMapping = IOU_CURRENCY_EVIDENCE_MAP,
): readonly string[] {
  const canonical = normalizeImageCurrencyToken(sourceToken, mapping);
  return canonical === undefined ? [] : sourceToken === canonical ? [canonical] : [sourceToken as string, canonical];
}
