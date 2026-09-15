import { describe, expect, it } from "vitest";
import { normalizeRawImageEvidence } from "./rawImageEvidence";
import { normalizeRawImageTotalRow } from "./rawImageTotalRow";

const evidence = (total_row: unknown, overrides: Record<string, unknown> = {}) => ({
  heading: "Visible heading", total_row, dates: ["14 Aug 2026"], kind: "iou", ...overrides,
});

describe("explicit whole total_row evidence", () => {
  it.each([
    ["12,900 EGP", 12900, "EGP"], ["Total Payout $1,912.15", 1912.15, "USD"],
    ["Total: 72.50", 72.5, undefined], ["TOTAL EGP 350.00", 350, "EGP"],
    ["Total: €84.70", 84.7, "EUR"], ["Total agreed: £842.65", 842.65, "GBP"],
    ["1,912.15 USD", 1912.15, "USD"], ["Grand sum: 84.70 EUR", 84.7, "EUR"],
    ["المبلغ: ج.م 350.00", 350, "EGP"], ["Montant dû: 84.70 €", 84.7, "EUR"],
    ["£842.65", 842.65, "GBP"], ["72.50", 72.5, undefined],
    ["Amount E£ 12.50", 12.5, "EGP"], ["Total:\u00a0€84.70", 84.7, "EUR"],
  ])("parses one declared row without label-specific rules: %s", (total, amount, currency) => {
    const raw = evidence(total), original = JSON.stringify(raw);
    expect(normalizeRawImageTotalRow(raw)).toEqual({
      amount, ...(currency === undefined ? {} : { currency }), kind: "iou",
      note: "Visible heading", image_heading: "Visible heading",
      printed_date: "14 Aug 2026", printed_end_date: "",
    });
    expect(JSON.stringify(raw)).toBe(original);
  });

  it.each([
    "Total 72.50", "XYZ 350.00", "Amount XYZ 350.00", "Total: 350.00 XYZ",
    "USD EGP 350.00", "Total USD EGP 350.00", "USD: 350.00", "USD: 350.00 EGP",
    "Total $350.00 USD", "Total € $350.00", "Total $$350.00", "Total: 350.00 paid",
    "Items 3 total $350.00", "Total $350.00 and $20.00", "Total: $350.00 | note",
    "Total: -350.00", "Total: +350.00", "Total: (350.00)", "Total: 1e3",
    "Total: 1,23.00", "Total: 1.234,56", "Total: 01.00", "Total: 0", "Total: .50",
    "Total: 1.", "Total: 1.001", "Total: 12.50%", "Total: 12.50\n", "Total:\u202e12.50",
    "Total\u0000: 12.50", "Total: \ud80012.50", "Total: ١٢.٥٠", "Total: １２.５０",
    "A".repeat(65) + ": $12.50", "A".repeat(193), "", " ", null, undefined, 350,
  ])("rejects incomplete, ambiguous or unsafe rows without partial salvage: %j", (total) => {
    expect(normalizeRawImageTotalRow(evidence(total))).toBeUndefined();
  });

  it("does not widen the old total_text format or accept mixed shapes", () => {
    const { total_row, ...rest } = evidence("TOTAL EGP 350.00");
    expect(normalizeRawImageEvidence({ ...rest, total_text: total_row })).toBeUndefined();
    expect(normalizeRawImageTotalRow({ ...rest, total_text: total_row })).toBeUndefined();
    for (const key of ["total_text", "amount", "currency", "direction", "type", "extra"])
      expect(normalizeRawImageTotalRow(evidence(total_row, { [key]: "extra" }))).toBeUndefined();
    for (const key of Object.keys(evidence(total_row))) {
      const raw: Record<string, unknown> = evidence(total_row); delete raw[key];
      expect(normalizeRawImageTotalRow(raw)).toBeUndefined();
    }
  });

  it("preserves strict dates, heading validation, missing evidence and monetary bounds", () => {
    const row = "Total: 12.50";
    expect(normalizeRawImageTotalRow(evidence(row, { heading: "", dates: [] })))
      .toEqual({ amount: 12.5, kind: "iou" });
    expect(normalizeRawImageTotalRow(evidence(row, { dates: ["Sun, Jul 19", "Thu, Aug 6"] })))
      .toMatchObject({ printed_date: "Sun, Jul 19", printed_end_date: "Thu, Aug 6" });
    for (const dates of [["bad date"], ["14 Aug 2026", "09:47 PM"], ["2026-08-10", "2026-08-06"]])
      expect(normalizeRawImageTotalRow(evidence(row, { dates }))).toBeUndefined();
    expect(normalizeRawImageTotalRow(evidence(row, { kind: "paid" }))).toBeUndefined();
    expect(normalizeRawImageTotalRow(evidence(row, { heading: "Heading\nMade up" }))).toBeUndefined();
    for (const amount of ["0.01", "90,071,992,547,409.91", "90,071,992,547,409.90", "90,071,992,547,409.92"])
      expect(normalizeRawImageTotalRow(evidence(`Total: ${amount}`)))
        .toEqual(normalizeRawImageEvidence({ heading: "Visible heading", total_text: amount, dates: ["14 Aug 2026"], kind: "iou" }));
  });

  it("rejects descriptors/prototypes/symbols/proxies without executing getters", () => {
    let calls = 0;
    for (const key of Object.keys(evidence("Total: 12.50"))) {
      const raw = evidence("Total: 12.50"); Object.defineProperty(raw, key, { get: () => { calls++; return "x"; } });
      expect(normalizeRawImageTotalRow(raw)).toBeUndefined();
    }
    expect(calls).toBe(0);
    expect(normalizeRawImageTotalRow(Object.assign(Object.create({ extra: 1 }), evidence("Total: 12.50")))).toBeUndefined();
    expect(normalizeRawImageTotalRow({ ...evidence("Total: 12.50"), [Symbol("hidden")]: 1 })).toBeUndefined();
    expect(normalizeRawImageTotalRow(new Proxy({}, { getPrototypeOf() { throw new Error("trap"); } }))).toBeUndefined();
    const hidden = evidence("Total: 12.50"); Object.defineProperty(hidden, "kind", { enumerable: false });
    expect(normalizeRawImageTotalRow(hidden)).toBeUndefined();
    expect(normalizeRawImageTotalRow(Object.assign(Object.create(null), evidence("Total: 12.50"))))?.toBeDefined();
  });
});
