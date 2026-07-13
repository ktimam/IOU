import { describe, it, expect } from "vitest";
import { parseDraft, isDuplicateDraft, extractTs } from "./draft";

describe("extractTs — the date a template schedule anchors on", () => {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  it("recovers the transaction date: note-range START, then the date field, then today", () => {
    expect(iso(extractTs({ note: "reservation 1-5 July" }))).toMatch(/-07-01$/);
    expect(iso(extractTs({ date: "2026-03-09" }))).toBe("2026-03-09");
    // The model copies today's date into `date`, but the note carries the real one → note wins.
    expect(iso(extractTs({ date: "2026-07-13", note: "reservation 1-5 July" }))).toMatch(/-07-01$/);
    // Nothing parseable → today (so a "due in 0 days" portion still resolves).
    expect(iso(extractTs({ note: "no date here" }))).toBe(new Date().toISOString().slice(0, 10));
  });
});

// Helper: assert ok and return the parsed value.
function ok(input: unknown) {
  const r = parseDraft(input);
  if (!r.ok) throw new Error("expected ok, got errors: " + r.errors.join("; "));
  return r.value;
}

describe("parseDraft — settlement (transfer screenshot)", () => {
  it("parses a basic settlement and converts amount to minor units", () => {
    const v = ok({
      kind: "settlement",
      amount: "25.00",
      currency: "usd",
      direction: "credit",
      date: "2026-06-20",
      counterparty: "Sam",
      note: "lunch",
    });
    expect(v.initial.txn_type).toBe("settlement");
    expect(v.initial.amount_minor).toBe(2500);
    expect(v.initial.currency).toBe("USD"); // upper-cased
    expect(v.initial.direction).toBe("credit");
    expect(v.initial.note).toBe("lunch (Sam)"); // counterparty folded in
    expect(v.initial.fee).toBeUndefined();
    expect(v.initial.schedule).toBeUndefined();
    expect(v.initial.ts).toBe(Date.parse("2026-06-20T00:00:00Z"));
  });

  it("defaults direction to credit and date to today (UTC) when absent", () => {
    const v = ok({ amount: 10, currency: "EUR" });
    expect(v.initial.direction).toBe("credit");
    expect(v.initial.txn_type).toBe("settlement"); // inferred (no fee/schedule)
    const todayTs = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    expect(v.initial.ts).toBe(todayTs);
  });
});

describe("parseDraft — IOU (reservation)", () => {
  it("parses an IOU with fee + multi-portion schedule", () => {
    const v = ok({
      kind: "iou",
      amount: 1000,
      currency: "EGP",
      direction: "credit",
      fee_percent: 20,
      fee_fixed: "10.00",
      schedule: [
        { due_date: "2026-07-01", percent: 50 },
        { due_date: "2026-08-01", percent: 50 },
      ],
      note: "Reservation",
    });
    expect(v.initial.txn_type).toBe("iou");
    expect(v.initial.fee).toEqual({
      percent: 20,
      fixed_minor: 1000,
      gross_amount_minor: 100000,
    });
    expect(v.initial.schedule).toEqual([
      { due_ts: Date.parse("2026-07-01T00:00:00Z"), percent: 50 },
      { due_ts: Date.parse("2026-08-01T00:00:00Z"), percent: 50 },
    ]);
  });

  it("infers iou when fee/schedule present and absent kind", () => {
    const v = ok({ amount: 50, currency: "USD", schedule: [{ due_date: "2026-09-01" }] });
    expect(v.initial.txn_type).toBe("iou");
    // single portion → forced to 100%
    expect(v.initial.schedule).toEqual([
      { due_ts: Date.parse("2026-09-01T00:00:00Z"), percent: 100 },
    ]);
  });
});

describe("parseDraft — validation (untrusted input)", () => {
  it("rejects a non-object", () => {
    expect(parseDraft("nope").ok).toBe(false);
    expect(parseDraft(null).ok).toBe(false);
    expect(parseDraft([]).ok).toBe(false);
  });

  it("rejects non-positive / non-numeric amount", () => {
    expect(parseDraft({ amount: 0, currency: "USD" }).ok).toBe(false);
    expect(parseDraft({ amount: -5, currency: "USD" }).ok).toBe(false);
    expect(parseDraft({ amount: "abc", currency: "USD" }).ok).toBe(false);
  });

  it("rejects a bad currency", () => {
    expect(parseDraft({ amount: 5, currency: "dollars" }).ok).toBe(false);
    expect(parseDraft({ amount: 5 }).ok).toBe(false); // missing
  });

  it("rejects a bad date and a bad direction", () => {
    expect(parseDraft({ amount: 5, currency: "USD", date: "whenever" }).ok).toBe(false);
    expect(parseDraft({ amount: 5, currency: "USD", direction: "owed" }).ok).toBe(false);
  });

  it("loose-parses common date phrases and recovers the date from the message text", () => {
    const isoOf = (p: unknown): string => {
      const r = parseDraft(p);
      if (!r.ok) throw new Error("expected ok: " + r.errors.join("; "));
      return new Date(r.value.initial.ts!).toISOString().slice(0, 10);
    };
    expect(isoOf({ amount: 5, currency: "USD", date: "20/06/2026" })).toBe("2026-06-20"); // day-first D/M/Y
    expect(isoOf({ amount: 5, currency: "USD", date: "July 1" })).toMatch(/-07-01$/); // Month D
    expect(isoOf({ amount: 5, currency: "USD", date: "1 July" })).toMatch(/-07-01$/); // D Month
    // No date field → recover from the note; a range "1-12 July" resolves to the START day.
    expect(isoOf({ amount: 5, currency: "USD", note: "reservation 1-12 July" })).toMatch(/-07-01$/);
    // The model copied today's date into the date field, but the note carries the real one → note wins.
    expect(isoOf({ amount: 5, currency: "USD", date: "2026-07-12", note: "reservation 1-12 July" })).toMatch(
      /-07-01$/,
    );
  });

  it("rejects an IOU schedule whose percents don't total 100", () => {
    const r = parseDraft({
      kind: "iou",
      amount: 100,
      currency: "USD",
      schedule: [
        { due_date: "2026-07-01", percent: 40 },
        { due_date: "2026-08-01", percent: 40 },
      ],
    });
    expect(r.ok).toBe(false);
  });

  it("collects multiple errors at once", () => {
    const r = parseDraft({ amount: -1, currency: "zz", direction: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe("parseDraft — idempotency (draft_id)", () => {
  it("derives a stable draft_id from identical drafts", () => {
    const a = ok({ amount: 25, currency: "USD", date: "2026-06-20", note: "x" });
    const b = ok({ amount: "25.00", currency: "usd", date: "2026-06-20", note: "x" });
    expect(a.draftId).toBe(b.draftId);
    expect(a.initial.draft_id).toBe(a.draftId);
  });

  it("derives different ids for different amounts", () => {
    const a = ok({ amount: 25, currency: "USD", date: "2026-06-20" });
    const b = ok({ amount: 26, currency: "USD", date: "2026-06-20" });
    expect(a.draftId).not.toBe(b.draftId);
  });

  it("respects a provided draft_id", () => {
    const v = ok({ amount: 25, currency: "USD", draft_id: "ext-123" });
    expect(v.draftId).toBe("ext-123");
    expect(v.initial.draft_id).toBe("ext-123");
  });
});

describe("isDuplicateDraft", () => {
  const entries = [
    { deleted: false, payload: { draft_id: "d:aaaa1111" } },
    { deleted: true, payload: { draft_id: "d:bbbb2222" } }, // deleted → ignored
    { deleted: false, payload: {} }, // manual entry, no draft_id
  ];
  it("flags an existing non-deleted draft", () => {
    expect(isDuplicateDraft(entries, "d:aaaa1111")).toBe(true);
  });
  it("does not flag a deleted draft or an unseen id", () => {
    expect(isDuplicateDraft(entries, "d:bbbb2222")).toBe(false);
    expect(isDuplicateDraft(entries, "d:cccc3333")).toBe(false);
  });
});
