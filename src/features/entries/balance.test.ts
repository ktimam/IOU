import { describe, it, expect } from "vitest";
import {
  portionsOf,
  computeBalances,
  computeBalancesAsOf,
  endOfPrevMonth,
  netAfterFee,
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

const DAY = 86_400_000;
const JUN1 = Date.UTC(2026, 5, 1); // 2026-06-01
const JUN15 = Date.UTC(2026, 5, 15);
const JUL1 = Date.UTC(2026, 6, 1);

describe("portionsOf", () => {
  it("settlement → one portion at ts", () => {
    const ps = portionsOf(entry({ txn_type: "settlement", ts: JUN1, amount_minor: 500 }));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ due_ts: JUN1, amount_minor: 500 });
  });

  it("iou with no schedule → one portion due at ts", () => {
    const ps = portionsOf(entry({ txn_type: "iou", ts: JUN15, amount_minor: 1000 }));
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ due_ts: JUN15, amount_minor: 1000 });
  });

  it("legacy entry (no txn_type) → single portion due at ts", () => {
    const ps = portionsOf(entry({ ts: JUN15, amount_minor: 1000 }));
    expect(ps).toHaveLength(1);
    expect(ps[0].amount_minor).toBe(1000);
  });

  it("splits by percent and gives the remainder to the last portion (no drift)", () => {
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 101,
        schedule: [
          { due_ts: JUN1, percent: 50 },
          { due_ts: JUL1, percent: 50 },
        ],
      }),
    );
    expect(ps.map((p) => p.amount_minor)).toEqual([51, 50]);
    expect(ps.reduce((s, p) => s + p.amount_minor, 0)).toBe(101);
  });

  it("three-way split sums exactly to the total", () => {
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 100,
        schedule: [
          { due_ts: JUN1, percent: 33 },
          { due_ts: JUN15, percent: 33 },
          { due_ts: JUL1, percent: 34 },
        ],
      }),
    );
    expect(ps.map((p) => p.amount_minor)).toEqual([33, 33, 34]);
    expect(ps.reduce((s, p) => s + p.amount_minor, 0)).toBe(100);
  });
});

describe("portionsOf with a fee (deducted from the final due)", () => {
  it("splits the gross and takes the fee off the last installment", () => {
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 80000, // net = 1000 − 20%
        fee: { percent: 20, gross_amount_minor: 100000 },
        schedule: [
          { due_ts: JUN1, percent: 50 },
          { due_ts: JUL1, percent: 50 },
        ],
      }),
    );
    // gross split 500/500; fee 200 off the last → 500, 300
    expect(ps.map((p) => p.amount_minor)).toEqual([50000, 30000]);
    expect(ps.reduce((s, p) => s + p.amount_minor, 0)).toBe(80000); // = net
  });

  it("cascades the fee backward when the last installment is too small", () => {
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 80000,
        fee: { percent: 20, gross_amount_minor: 100000 },
        schedule: [
          { due_ts: JUN1, percent: 90 },
          { due_ts: JUL1, percent: 10 },
        ],
      }),
    );
    // gross 900/100; fee 200 empties the last (100) then takes 100 off the first
    expect(ps.map((p) => p.amount_minor)).toEqual([80000, 0]);
    expect(ps.reduce((s, p) => s + p.amount_minor, 0)).toBe(80000);
  });

  it("single due with a fee nets to the post-fee amount", () => {
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        amount_minor: 75000,
        fee: { percent: 20, fixed_minor: 5000, gross_amount_minor: 100000 },
      }),
    );
    expect(ps.map((p) => p.amount_minor)).toEqual([75000]);
  });

  it("early installments stay full; only the matured (full) part shows this month", () => {
    const split = entry({
      txn_type: "iou",
      direction: "credit",
      amount_minor: 80000,
      fee: { percent: 20, gross_amount_minor: 100000 },
      schedule: [
        { due_ts: JUN1, percent: 50 }, // matured, full 500
        { due_ts: JUL1, percent: 50 }, // future, 300 after fee
      ],
    });
    expect(computeBalancesAsOf([split], JUN15)).toEqual([
      { currency: "USD", amount_minor: 50000 },
    ]);
    expect(computeBalances([split])).toEqual([{ currency: "USD", amount_minor: 80000 }]);
  });
});

describe("portionsOf with a cross-currency fixed fee", () => {
  it("keeps the foreign fixed fee as its own opposite-direction line (entry amount unreduced)", () => {
    // IOU 1000 USD, fee 1000 EGP: the EGP fee doesn't touch the USD amount.
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        direction: "credit",
        currency: "USD",
        amount_minor: 100000, // net = gross (percent 0, foreign fixed not deducted here)
        fee: {
          percent: 0,
          fixed_minor: 100000,
          fixed_currency: "EGP",
          gross_amount_minor: 100000,
        },
        ts: JUN1,
      }),
    );
    expect(ps).toEqual([
      { currency: "USD", due_ts: JUN1, amount_minor: 100000, direction: "credit" },
      { currency: "EGP", due_ts: JUN1, amount_minor: 100000, direction: "debt" },
    ]);
  });

  it("percent still deducts from the entry currency; only the fixed fee crosses currencies", () => {
    // IOU 1000 USD, 20% + 1000 EGP fixed → 800 USD net, plus a 1000 EGP line.
    const ps = portionsOf(
      entry({
        txn_type: "iou",
        direction: "debt",
        currency: "USD",
        amount_minor: 80000, // gross − 20% (foreign fixed not netted)
        fee: {
          percent: 20,
          fixed_minor: 100000,
          fixed_currency: "EGP",
          gross_amount_minor: 100000,
        },
        ts: JUN1,
      }),
    );
    expect(ps).toEqual([
      { currency: "USD", due_ts: JUN1, amount_minor: 80000, direction: "debt" },
      { currency: "EGP", due_ts: JUN1, amount_minor: 100000, direction: "credit" },
    ]);
  });

  it("totals the foreign fee with other entries of that currency, separate from the entry currency", () => {
    const iou = entry({
      txn_type: "iou",
      direction: "credit",
      currency: "USD",
      amount_minor: 100000,
      fee: { percent: 0, fixed_minor: 50000, fixed_currency: "EGP", gross_amount_minor: 100000 },
      ts: JUN1,
    });
    // A plain EGP credit rolls up with the fee's EGP line: +500 − 500 = 0 → drops out.
    const egpCredit = entry({ currency: "EGP", direction: "credit", amount_minor: 50000, ts: JUN1 });
    expect(computeBalances([iou, egpCredit])).toEqual([
      { currency: "USD", amount_minor: 100000 },
    ]);
  });
});

describe("computeBalancesAsOf (maturity buckets)", () => {
  const split = entry({
    txn_type: "iou",
    direction: "credit",
    amount_minor: 1000,
    schedule: [
      { due_ts: JUN1, percent: 50 }, // matured early
      { due_ts: JUL1, percent: 50 }, // matures later
    ],
  });

  it("only counts portions due on/before the cutoff", () => {
    const asOfJun15 = computeBalancesAsOf([split], JUN15);
    expect(asOfJun15).toEqual([{ currency: "USD", amount_minor: 500 }]);
  });

  it("overall counts every portion (100%)", () => {
    expect(computeBalances([split])).toEqual([{ currency: "USD", amount_minor: 1000 }]);
  });

  it("before the first due date, nothing has matured", () => {
    expect(computeBalancesAsOf([split], JUN1 - DAY)).toEqual([]);
  });

  it("nets credit against debt per currency", () => {
    const credit = entry({ direction: "credit", amount_minor: 800, ts: JUN1 });
    const debt = entry({ direction: "debt", amount_minor: 300, ts: JUN1 });
    expect(computeBalancesAsOf([credit, debt], JUN15)).toEqual([
      { currency: "USD", amount_minor: 500 },
    ]);
  });

  it("settlement matures instantly at its ts", () => {
    const s = entry({ txn_type: "settlement", direction: "debt", amount_minor: 200, ts: JUN1 });
    expect(computeBalancesAsOf([s], JUN15)).toEqual([{ currency: "USD", amount_minor: -200 }]);
    expect(computeBalancesAsOf([s], JUN1 - DAY)).toEqual([]);
  });
});

describe("netAfterFee", () => {
  it("deducts the percentage from the gross", () => {
    expect(netAfterFee(100000, 20)).toBe(80000); // 1000.00 − 20% → 800.00
    expect(netAfterFee(100000, 0)).toBe(100000);
    expect(netAfterFee(100000, 100)).toBe(0);
  });
  it("deducts a fixed amount, and percent + fixed together", () => {
    expect(netAfterFee(100000, 0, 1000)).toBe(99000); // − 10.00 fixed
    expect(netAfterFee(500000, 20, 100000)).toBe(300000); // − 20% − 1000.00
  });
  it("rounds to the nearest minor unit", () => {
    expect(netAfterFee(333, 10)).toBe(300); // 333 * 0.9 = 299.7 → 300
  });
  it("clamps to zero and ignores out-of-range inputs", () => {
    expect(netAfterFee(100, -5)).toBe(100);
    expect(netAfterFee(100, 150)).toBe(0);
    expect(netAfterFee(100, 0, 500)).toBe(0); // fixed exceeds gross → 0
  });
});

describe("endOfPrevMonth", () => {
  it("returns the last ms of the previous calendar month (UTC)", () => {
    // now = 2026-06-15 → previous month ends 2026-05-31T23:59:59.999Z
    const eop = endOfPrevMonth(JUN15);
    expect(eop).toBe(JUN1 - 1);
    expect(new Date(eop).toISOString()).toBe("2026-05-31T23:59:59.999Z");
  });
});
