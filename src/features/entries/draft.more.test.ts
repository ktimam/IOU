// Exhaustive parseDraft coverage — template base merge, fee-currency carry,
// loose-date recovery, schedule percent boundaries, string/k-suffix amounts,
// draftId idempotency, and hostile-input handling. Complements draft.test.ts.

import { describe, it, expect } from "vitest";
import { parseDraft } from "./draft";
import type { EntryPayload } from "./types";

function ok(input: unknown, base?: Partial<EntryPayload>) {
  const r = parseDraft(input, base);
  if (!r.ok) throw new Error("expected ok, got: " + r.errors.join("; "));
  return r.value;
}
function errs(input: unknown, base?: Partial<EntryPayload>): string[] {
  const r = parseDraft(input, base);
  if (r.ok) throw new Error("expected errors, got ok");
  return r.errors;
}
const iso = (ts: number | undefined) => new Date(ts!).toISOString().slice(0, 10);

describe("parseDraft — template base merge (extracted wins, base fills gaps)", () => {
  const base: Partial<EntryPayload> = {
    txn_type: "iou",
    currency: "EGP",
    amount_minor: 5000,
    direction: "debt",
    note: "Rent",
  };

  it("uses the base type/currency/amount/direction/note when the draft omits them", () => {
    const v = ok({ note: "" }, base); // empty note falls back to the base note
    expect(v.initial.txn_type).toBe("iou");
    expect(v.initial.currency).toBe("EGP");
    expect(v.initial.amount_minor).toBe(5000);
    expect(v.initial.direction).toBe("debt");
    expect(v.initial.note).toBe("Rent");
  });

  it("lets explicit draft fields override every base default", () => {
    const v = ok(
      { kind: "settlement", amount: 12, currency: "usd", direction: "credit", note: "coffee" },
      base,
    );
    expect(v.initial.txn_type).toBe("settlement");
    expect(v.initial.amount_minor).toBe(1200);
    expect(v.initial.currency).toBe("USD");
    expect(v.initial.direction).toBe("credit");
    expect(v.initial.note).toBe("coffee");
  });

  it("base txn_type=iou forces iou even without a fee/schedule in the draft", () => {
    const v = ok({ amount: 10, currency: "USD" }, { txn_type: "iou" });
    expect(v.initial.txn_type).toBe("iou");
  });

  it("carries a same-currency base fee without a fixed_currency key", () => {
    const v = ok(
      { amount: 100, currency: "USD" },
      { txn_type: "iou", currency: "USD", fee: { percent: 10, fixed_minor: 500, gross_amount_minor: 0 } },
    );
    expect(v.initial.fee).toEqual({ percent: 10, fixed_minor: 500, gross_amount_minor: 10000 });
    expect(v.initial.fee).not.toHaveProperty("fixed_currency");
  });

  it("carries the base schedule when the draft has none", () => {
    const v = ok(
      { amount: 100, currency: "USD" },
      {
        txn_type: "iou",
        currency: "USD",
        schedule: [
          { due_ts: Date.UTC(2026, 6, 1), percent: 50 },
          { due_ts: Date.UTC(2026, 7, 1), percent: 50 },
        ],
      },
    );
    expect(v.initial.schedule).toHaveLength(2);
  });

  it("an explicit fee_percent/fee_fixed overrides the base fee but keeps the base fee currency", () => {
    const v = ok(
      { amount: 100, currency: "USD", fee_percent: 5 },
      {
        txn_type: "iou",
        currency: "USD",
        fee: { percent: 20, fixed_minor: 10000, fixed_currency: "EGP", gross_amount_minor: 0 },
      },
    );
    expect(v.initial.fee).toEqual({
      percent: 5, // overridden
      fixed_minor: 10000, // from base
      fixed_currency: "EGP", // carried from base (draft carries no fee-currency field)
      gross_amount_minor: 10000,
    });
  });
});

describe("parseDraft — loose date recovery from the note / date field", () => {
  it("recovers month/day/range/slash forms and an embedded ISO date", () => {
    expect(iso(ok({ amount: 5, currency: "USD", date: "July 1-7" }).initial.ts)).toMatch(/-07-01$/);
    expect(iso(ok({ amount: 5, currency: "USD", note: "booking 1–5 August" }).initial.ts)).toMatch(/-08-01$/);
    expect(iso(ok({ amount: 5, currency: "USD", date: "5/6" }).initial.ts)).toMatch(/-06-05$/); // D/M, year=now
    expect(iso(ok({ amount: 5, currency: "USD", date: "5/6/24" }).initial.ts)).toBe("2024-06-05"); // 2-digit year
    expect(iso(ok({ amount: 5, currency: "USD", note: "settled on 2026-03-09" }).initial.ts)).toBe("2026-03-09");
  });

  it("surfaces a malformed date only when the note carried no date", () => {
    expect(errs({ amount: 5, currency: "USD", date: "whenever" })).toContain("date must be YYYY-MM-DD");
    // Note carries the real date → the model's junk date field is not surfaced as an error.
    const v = ok({ amount: 5, currency: "USD", date: "whenever", note: "reservation 3 April" });
    expect(iso(v.initial.ts)).toMatch(/-04-03$/);
  });
});

describe("parseDraft — schedule percent boundaries", () => {
  it("forces a single portion to 100% even when a different percent is given", () => {
    const v = ok({ kind: "iou", amount: 100, currency: "USD", schedule: [{ due_date: "2026-07-01", percent: 40 }] });
    expect(v.initial.schedule).toEqual([{ due_ts: Date.parse("2026-07-01T00:00:00Z"), percent: 100 }]);
  });

  it("accepts multi-portion schedules that total exactly 100 (incl. 99/1)", () => {
    expect(
      ok({
        kind: "iou",
        amount: 100,
        currency: "USD",
        schedule: [
          { due_date: "2026-07-01", percent: 99 },
          { due_date: "2026-08-01", percent: 1 },
        ],
      }).initial.schedule,
    ).toHaveLength(2);
  });

  it("rejects totals other than 100 and out-of-range percents", () => {
    expect(errs({ kind: "iou", amount: 100, currency: "USD", schedule: [
      { due_date: "2026-07-01", percent: 50 },
      { due_date: "2026-08-01", percent: 40 },
    ] })).toContain("schedule percents must total 100");
    expect(errs({ kind: "iou", amount: 100, currency: "USD", schedule: [
      { due_date: "2026-07-01", percent: 150 },
      { due_date: "2026-08-01", percent: -50 },
    ] })).toContain("schedule.percent must be 0..100");
  });

  it("rejects malformed schedule shapes (non-array, empty, non-object rows, missing due_date)", () => {
    expect(errs({ kind: "iou", amount: 1, currency: "USD", schedule: "soon" })).toContain(
      "schedule must be a non-empty array",
    );
    expect(errs({ kind: "iou", amount: 1, currency: "USD", schedule: [] })).toContain(
      "schedule must be a non-empty array",
    );
    expect(errs({ kind: "iou", amount: 1, currency: "USD", schedule: [42] })).toContain(
      "schedule rows must be objects",
    );
    expect(errs({ kind: "iou", amount: 1, currency: "USD", schedule: [{ percent: 100 }] })).toContain(
      "schedule.due_date must be YYYY-MM-DD",
    );
  });
});

describe("parseDraft — amount forms (string, decimal, k-suffix boundary)", () => {
  it("parses numeric strings and decimals to minor units", () => {
    expect(ok({ amount: "26.50", currency: "USD" }).initial.amount_minor).toBe(2650);
    expect(ok({ amount: 0.1, currency: "USD" }).initial.amount_minor).toBe(10);
  });

  it("does NOT parse a 'k' suffix — IOU relies on OpenChat's normalize pass for that", () => {
    // Documents the boundary: '26k' reaches parseDraft only if OpenChat's k_m_suffix rule failed,
    // and IOU then rejects it rather than guessing.
    expect(errs({ amount: "26k", currency: "USD" })).toContain("amount must be a positive number");
  });
});

describe("parseDraft — draftId idempotency", () => {
  it("trims and honours a provided draft_id", () => {
    expect(ok({ amount: 5, currency: "USD", draft_id: "  ext-2  " }).draftId).toBe("ext-2");
  });
  it("derives distinct ids when the note or schedule differs", () => {
    const a = ok({ amount: 5, currency: "USD", date: "2026-06-20", note: "a" }).draftId;
    const b = ok({ amount: 5, currency: "USD", date: "2026-06-20", note: "b" }).draftId;
    expect(a).not.toBe(b);
    const s1 = ok({ kind: "iou", amount: 5, currency: "USD", schedule: [{ due_date: "2026-07-01" }] }).draftId;
    const s2 = ok({ kind: "iou", amount: 5, currency: "USD", schedule: [{ due_date: "2026-08-01" }] }).draftId;
    expect(s1).not.toBe(s2);
  });
});

describe("parseDraft — hostile input", () => {
  it("folds away unknown/dangerous extra fields", () => {
    const v = ok({ amount: 5, currency: "USD", note: "x", evil: "rm -rf", __proto__: { polluted: true } });
    expect(Object.keys(v.initial)).not.toContain("evil");
    expect((v.initial as Record<string, unknown>).evil).toBeUndefined();
  });

  it("rejects an array, an invalid kind, and out-of-range fees", () => {
    expect(parseDraft([]).ok).toBe(false);
    expect(errs({ kind: "gift", amount: 5, currency: "USD" })).toContain('kind must be "settlement" or "iou"');
    expect(errs({ kind: "iou", amount: 5, currency: "USD", fee_percent: 101 })).toContain("fee_percent must be 0..100");
    expect(errs({ kind: "iou", amount: 5, currency: "USD", fee_fixed: -1 })).toContain(
      "fee_fixed must be a non-negative number",
    );
  });

  it("collects several independent errors in one pass", () => {
    const e = errs({ amount: -1, currency: "zz", direction: "sideways", date: 5 });
    expect(e.length).toBeGreaterThanOrEqual(4);
  });
});
