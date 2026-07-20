// buildEntryPayload — the net/convert/fee/schedule math EntryForm.submit delegates
// to. Covers plain entries, same- vs cross-currency fees, currency conversion (fee
// applied to the converted base), schedule validation, fee>gross clamps, kind
// mapping, and draft_id carry-through.

import { describe, it, expect } from "vitest";
import { buildEntryPayload, toMinorMajor, ymdToTs, type EntryFormInput } from "./entryMath";

function base(over: Partial<EntryFormInput> = {}): EntryFormInput {
  return {
    amountStr: "100.00",
    currency: "USD",
    direction: "credit",
    note: "",
    dateYmd: "2026-06-20",
    txnType: "settlement",
    feePercent: 0,
    feeFixedStr: "",
    feeFixedCurrency: "",
    schedule: [{ date: "2026-06-20", percent: 100 }],
    convert: null,
    ...over,
  };
}
function okPayload(over: Partial<EntryFormInput> = {}) {
  const r = buildEntryPayload(base(over));
  if (!r.ok) throw new Error("expected ok, got: " + r.error);
  return r.payload;
}

describe("toMinorMajor / ymdToTs", () => {
  it("rounds major strings to minor units (blank/NaN → 0)", () => {
    expect(toMinorMajor("12.50")).toBe(1250);
    expect(toMinorMajor("")).toBe(0);
    expect(toMinorMajor("abc")).toBe(0);
  });
  it("maps YYYY-MM-DD to UTC midnight ms", () => {
    expect(ymdToTs("2026-06-20")).toBe(Date.parse("2026-06-20T00:00:00Z"));
  });
});

describe("buildEntryPayload — basics + validation", () => {
  it("builds a settlement (kind=payment) with no fee/schedule", () => {
    const p = okPayload({ txnType: "settlement" });
    expect(p.kind).toBe("payment");
    expect(p.txn_type).toBe("settlement");
    expect(p.amount_minor).toBe(10000);
    expect(p.currency).toBe("USD");
    expect(p.fee).toBeUndefined();
    expect(p.ts).toBe(Date.parse("2026-06-20T00:00:00Z"));
  });

  it("builds an IOU (kind=expense) with a single 100% due date", () => {
    const p = okPayload({ txnType: "iou" });
    expect(p.kind).toBe("expense");
    expect(p.schedule).toEqual([{ due_ts: Date.parse("2026-06-20T00:00:00Z"), percent: 100 }]);
  });

  it("IOU→settlement edit drops the schedule AND fee; amount is the gross (U4)", () => {
    // The form's type toggle on edit: an IOU carrying a fee + a multi-portion schedule is flipped to
    // Settlement. Settlements have neither a fee nor a schedule, and the amount is the gross (no
    // fee netting). The fee-drop is covered elsewhere; the SCHEDULE-drop is the missing assertion.
    const p = okPayload({
      txnType: "settlement",
      feePercent: 20,
      feeFixedStr: "10.00",
      feeFixedCurrency: "USD",
      schedule: [
        { date: "2026-07-01", percent: 50 },
        { date: "2026-08-01", percent: 50 },
      ],
    });
    expect(p.kind).toBe("payment");
    expect(p.txn_type).toBe("settlement");
    expect(p.schedule).toBeUndefined();
    expect(p.fee).toBeUndefined();
    expect(p.amount_minor).toBe(10000); // gross, no fee netting
  });

  it("rejects a non-positive amount", () => {
    expect(buildEntryPayload(base({ amountStr: "0" }))).toEqual({ ok: false, error: "amount must be > 0" });
    expect(buildEntryPayload(base({ amountStr: "" }))).toEqual({ ok: false, error: "amount must be > 0" });
  });

  it("rejects a multi-portion IOU schedule that doesn't total 100%", () => {
    const r = buildEntryPayload(
      base({
        txnType: "iou",
        schedule: [
          { date: "2026-07-01", percent: 60 },
          { date: "2026-08-01", percent: 30 },
        ],
      }),
    );
    expect(r).toEqual({ ok: false, error: "due-date percentages must total 100%" });
  });

  it("carries the draft_id through when present", () => {
    expect(okPayload({ draftId: "d:abc" }).draft_id).toBe("d:abc");
    expect(okPayload({}).draft_id).toBeUndefined();
  });
});

describe("buildEntryPayload — fees", () => {
  it("percent-only fee reduces the net; gross kept on the fee", () => {
    const p = okPayload({ txnType: "iou", feePercent: 20 });
    expect(p.amount_minor).toBe(8000); // 100 − 20%
    expect(p.fee).toEqual({ percent: 20, fixed_minor: 0, gross_amount_minor: 10000 });
  });

  it("same-currency fixed fee folds into the net (no fixed_currency key)", () => {
    const p = okPayload({ txnType: "iou", feePercent: 0, feeFixedStr: "10.00", feeFixedCurrency: "USD" });
    expect(p.amount_minor).toBe(9000); // 100 − 10 fixed
    expect(p.fee).toEqual({ percent: 0, fixed_minor: 1000, gross_amount_minor: 10000 });
    expect(p.fee).not.toHaveProperty("fixed_currency");
  });

  it("cross-currency fixed fee does NOT reduce the net; it is carried as fixed_currency", () => {
    const p = okPayload({ txnType: "iou", feePercent: 20, feeFixedStr: "500.00", feeFixedCurrency: "EGP" });
    // Only the 20% reduces the USD net; the EGP fixed fee is a separate line.
    expect(p.amount_minor).toBe(8000);
    expect(p.fee).toEqual({ percent: 20, fixed_minor: 50000, fixed_currency: "EGP", gross_amount_minor: 10000 });
  });

  it("clamps the net at zero when the fee exceeds the gross", () => {
    const p = okPayload({ txnType: "iou", feePercent: 100, feeFixedStr: "50.00", feeFixedCurrency: "USD" });
    expect(p.amount_minor).toBe(0);
  });

  it("no fee on a settlement even if fee fields are set", () => {
    const p = okPayload({ txnType: "settlement", feePercent: 20, feeFixedStr: "5.00" });
    expect(p.fee).toBeUndefined();
    expect(p.amount_minor).toBe(10000);
  });
});

describe("buildEntryPayload — currency conversion", () => {
  it("restates the entry in the target currency and applies the fee to the converted base", () => {
    const p = okPayload({
      txnType: "iou",
      currency: "USD",
      feePercent: 10,
      convert: { to: "EGP", rate: 49.12, rateSource: "frankfurter.app", rateFetchedAt: 1_700_000_000_000 },
    });
    expect(p.currency).toBe("EGP");
    const convertedGross = Math.round(10000 * 49.12); // 491200
    expect(p.convert).toEqual({
      from_currency: "USD",
      from_amount_minor: 10000,
      to_currency: "EGP",
      to_amount_minor: convertedGross,
      rate: 49.12,
      rate_source: "frankfurter.app",
      rate_fetched_at: 1_700_000_000_000,
    });
    expect(p.fee?.gross_amount_minor).toBe(convertedGross);
    expect(p.amount_minor).toBe(Math.round(convertedGross * 0.9)); // 10% off the converted base
  });
});
