// Additional, exhaustive balance coverage — boundary values, multi-currency
// roll-ups, maturity timing of the cross-currency fee line, and formatMinor.
// Complements balance.test.ts (kept untouched); these are the edges that would
// silently regress the netting/fee math.

import { describe, it, expect } from "vitest";
import {
  portionsOf,
  computeBalances,
  computeBalancesAsOf,
  formatMinor,
} from "./balance";
import type { EntryPayload } from "./types";

function entry(p: Partial<EntryPayload>): EntryPayload {
  return {
    ts: 0,
    kind: "expense",
    currency: "USD",
    amount_minor: 0,
    direction: "credit",
    note: "",
    ...p,
  };
}

const JUN1 = Date.UTC(2026, 5, 1);
const JUN15 = Date.UTC(2026, 5, 15);
const JUL1 = Date.UTC(2026, 6, 1);

describe("portionsOf — fee clamps and settlement handling", () => {
  it("a fee equal to the gross empties every installment (cascades to zero, never negative)", () => {
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 0, // net = gross − 100%
        fee: { percent: 100, gross_amount_minor: 100000 },
        schedule: [
          { due_ts: JUN1, percent: 50 },
          { due_ts: JUL1, percent: 50 },
        ],
      }),
    );
    // The 100% fee (100000) empties the last installment (50000) then cascades onto the first.
    expect(ps.map((p) => p.amount_minor)).toEqual([0, 0]);
    // Whole entry nets to zero → drops out of the balance entirely.
    expect(computeBalances([
      entry({
        txn_type: "iou",
        amount_minor: 0,
        fee: { percent: 100, gross_amount_minor: 100000 },
        ts: JUN1,
      }),
    ])).toEqual([]);
  });

  it("a fee larger than the gross still clamps portions at 0 (no underflow)", () => {
    // Degenerate/hostile: net stored below gross−fee. The cascade stops at 0.
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 0,
        fee: { percent: 0, fixed_minor: 999999, gross_amount_minor: 100000 },
        schedule: [{ due_ts: JUN1, percent: 100 }],
      }),
    );
    expect(ps[0].amount_minor).toBe(0);
    expect(ps.every((p) => p.amount_minor >= 0)).toBe(true);
  });

  it("a settlement ignores any fee sub-payload (amount_minor is used verbatim)", () => {
    const ps = portionsOf(
      entry({
        txn_type: "settlement",
        amount_minor: 4200,
        fee: { percent: 20, gross_amount_minor: 100000 }, // must be ignored
        ts: JUN1,
      }),
    );
    expect(ps).toHaveLength(1);
    expect(ps[0].amount_minor).toBe(4200);
  });
});

describe("computeBalances — multi-currency roll-up + ordering", () => {
  it("nets per currency and sorts by absolute magnitude descending", () => {
    const usd = entry({ currency: "USD", direction: "credit", amount_minor: 300, ts: JUN1 });
    const eur = entry({ currency: "EUR", direction: "debt", amount_minor: 1000, ts: JUN1 });
    const jpy = entry({ currency: "JPY", direction: "credit", amount_minor: 20, ts: JUN1 });
    // |EUR|=1000 > |USD|=300 > |JPY|=20
    expect(computeBalances([usd, eur, jpy])).toEqual([
      { currency: "EUR", amount_minor: -1000 },
      { currency: "USD", amount_minor: 300 },
      { currency: "JPY", amount_minor: 20 },
    ]);
  });

  it("a currency that nets to exactly zero is omitted", () => {
    const a = entry({ currency: "USD", direction: "credit", amount_minor: 500, ts: JUN1 });
    const b = entry({ currency: "USD", direction: "debt", amount_minor: 500, ts: JUN1 });
    expect(computeBalances([a, b])).toEqual([]);
  });
});

describe("cross-currency fee — line timing + same-currency totalling", () => {
  it("the foreign fee line matures with the FINAL installment, not the first", () => {
    const iou = entry({
      txn_type: "iou",
      direction: "credit",
      currency: "USD",
      amount_minor: 100000,
      fee: { percent: 0, fixed_minor: 50000, fixed_currency: "EGP", gross_amount_minor: 100000 },
      schedule: [
        { due_ts: JUN1, percent: 50 },
        { due_ts: JUL1, percent: 50 }, // foreign fee due here
      ],
    });
    // As of mid-June only the first USD installment has matured; the EGP fee is future.
    expect(computeBalancesAsOf([iou], JUN15)).toEqual([{ currency: "USD", amount_minor: 50000 }]);
    // After the last due date, the USD amount and the opposite-direction EGP line are both counted.
    expect(computeBalancesAsOf([iou], JUL1)).toEqual([
      { currency: "USD", amount_minor: 100000 },
      { currency: "EGP", amount_minor: -50000 },
    ]);
  });

  it("two IOUs with foreign fees in the same currency total that fee currency together", () => {
    const mk = (fixed: number) =>
      entry({
        txn_type: "iou",
        direction: "credit",
        currency: "USD",
        amount_minor: 100000,
        fee: { percent: 0, fixed_minor: fixed, fixed_currency: "EGP", gross_amount_minor: 100000 },
        ts: JUN1,
      });
    // Two EGP deduction lines (−300 and −200) total −500 EGP, distinct from the USD +2000.
    expect(computeBalances([mk(30000), mk(20000)])).toEqual([
      { currency: "USD", amount_minor: 200000 },
      { currency: "EGP", amount_minor: -50000 },
    ]);
  });
});

describe("formatMinor", () => {
  it("renders 2 fraction digits with the currency suffix", () => {
    expect(formatMinor(100000, "EUR")).toBe("1000.00 EUR");
    expect(formatMinor(5, "USD")).toBe("0.05 USD");
    expect(formatMinor(0, "USD")).toBe("0.00 USD");
  });
  it("keeps the sign for negative amounts (I owe)", () => {
    expect(formatMinor(-1234, "USD")).toBe("-12.34 USD");
    expect(formatMinor(-1, "JPY")).toBe("-0.01 JPY");
  });
});
