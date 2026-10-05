import { describe, expect, it } from "vitest";
import { normalizeRawImageTotalRow, normalizeRawImageTotalRowText } from "./rawImageTotalRow";

describe.each([
  { field: "total_row", normalize: normalizeRawImageTotalRow },
  { field: "total_text", normalize: normalizeRawImageTotalRowText },
])("whole $field sign preservation", ({ field, normalize }) => {
  const raw = (total: string) => ({ heading: "Visible heading", [field]: total, dates: [], kind: "iou" });

  // The old label grammar consumed the minus in "Total -12.34 USD" and returned
  // a positive amount. No model-specific source-details format is needed to reproduce it.
  it.each([
    "Total -12.34 USD", "Total-12.34 USD", "Total - 12.34 USD",
    "Total -:12.34 USD", "Total - : 12.34 USD", "Total: -12.34 USD",
    "Total -$12.34", "Total - $12.34", "Total- $12.34", "Total -: $12.34",
    "Total - : USD 12.34", "Total - USD12.34", "Total - USD 12.34", "Total USD -12.34",
    "Total: $-12.34", "Total -:12.34", "Total - : 12.34", "Total:\u00a0-12.34 USD",
    "Total\u00a0-\u00a012.34 USD", "Total −12.34 USD", "Total +12.34 USD", "Total + $12.34",
  ])("rejects negative/sign-ambiguous row %j without stripping its sign", total => {
    const value = raw(total), before = JSON.stringify(value);
    expect(normalize(value)).toBeUndefined();
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each([
    ["Total 12.34 USD", "USD"], ["Total $12.34", "USD"], ["Total: $12.34", "USD"],
    ["Net-total 12.34 USD", "USD"], ["Net-total $12.34", "USD"], ["Net-total:$12.34", "USD"],
    ["Net-total-amount: USD 12.34", "USD"], ["Net-total: 12.34", undefined],
  ])("preserves positive/internal-hyphenated labels: %s", (total, currency) => {
    expect(normalize(raw(total!))).toEqual({ amount: 12.34, ...(currency === undefined ? {} : { currency }),
      kind: "iou", note: "Visible heading", image_heading: "Visible heading" });
  });
});
