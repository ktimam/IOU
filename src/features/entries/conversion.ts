import type { ConvertPayload } from "./types";
import type { FxRate } from "./fx";

/** Keep the user's exact input: editing an amount fixes that amount, not its derived rate. */
export type ConversionDraft = {
  base: string;
  quote: string;
  kind: "rate" | "amount";
  value: string;
  source: string;
  updatedAt: number;
  savedAmounts?: { from: number; to: number };
};

export function savedConversion(convert?: ConvertPayload): ConversionDraft | null {
  return convert ? {
    base: convert.from_currency,
    quote: convert.to_currency,
    kind: "rate",
    value: String(convert.rate),
    source: convert.rate_source,
    updatedAt: convert.rate_fetched_at,
    savedAmounts: { from: convert.from_amount_minor, to: convert.to_amount_minor },
  } : null;
}

export function resolveConversion(draft: ConversionDraft | null, amountMinor: number) {
  const value = Number(draft?.value);
  if (!draft || !Number.isFinite(value) || value <= 0) return null;
  const convertedMinor = draft.kind === "amount"
    ? Math.round(value * 100)
    : draft.savedAmounts?.from === amountMinor ? draft.savedAmounts.to
    : Math.round(amountMinor * value);
  const rate = draft.kind === "amount" ? convertedMinor / amountMinor : value;
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 ||
      !Number.isSafeInteger(convertedMinor) || convertedMinor <= 0 ||
      !Number.isFinite(rate) || rate <= 0) return null;
  return {
    convertedMinor,
    rate: {
      base: draft.base, quote: draft.quote, rate,
      source: draft.source, fetchedAt: draft.updatedAt,
    } satisfies FxRate,
  };
}
