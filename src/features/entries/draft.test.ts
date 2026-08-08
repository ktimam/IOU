import { describe, it, expect } from "vitest";
import {
  parseDraft,
  isDuplicateDraft,
  extractTs,
  baseWithDefaultCurrency,
  parseDraftBatch,
  parsedToPayload,
  batchSummary,
  messageEvidence,
} from "./draft";
import type { EntryPayload } from "./types";

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

  it("carries the template's foreign fixed-fee currency onto the imported entry", () => {
    // Template base = a USD IOU whose fixed fee is charged in EGP. The chat draft carries no
    // fee-currency field, so the entry's fee must inherit EGP from the template — not default to USD.
    const base = {
      txn_type: "iou" as const,
      currency: "USD",
      fee: { percent: 0, fixed_minor: 100000, fixed_currency: "EGP", gross_amount_minor: 0 },
    };
    const r = parseDraft({ amount: 600, currency: "USD", note: "reservation 1-5 july" }, base);
    if (!r.ok) throw new Error("expected ok, got: " + r.errors.join("; "));
    expect(r.value.initial.currency).toBe("USD");
    expect(r.value.initial.fee).toEqual({
      percent: 0,
      fixed_minor: 100000,
      fixed_currency: "EGP",
      gross_amount_minor: 60000,
    });
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

// ── Issue 3: default currency (precedence message > template > IOU default) ──────────────────────
describe("baseWithDefaultCurrency", () => {
  it("injects the default currency when there is no base at all", () => {
    expect(baseWithDefaultCurrency(undefined, "USD")).toEqual({ currency: "USD" });
  });

  it("injects the default currency into a base that has no currency", () => {
    const base = { txn_type: "iou" as const, note: "reservation" };
    expect(baseWithDefaultCurrency(base, "EGP")).toEqual({
      txn_type: "iou",
      note: "reservation",
      currency: "EGP",
    });
  });

  it("leaves a base that already carries a currency unchanged (template wins over default)", () => {
    const base = { currency: "GBP", txn_type: "iou" as const };
    expect(baseWithDefaultCurrency(base, "USD")).toEqual({ currency: "GBP", txn_type: "iou" });
  });

  it("does nothing when the default is not a valid 3-letter code", () => {
    expect(baseWithDefaultCurrency(undefined, "")).toBeUndefined();
    expect(baseWithDefaultCurrency(undefined, "dollars")).toBeUndefined();
    const base = { note: "x" };
    expect(baseWithDefaultCurrency(base, "12")).toBe(base); // untouched, same reference
  });

  it("normalizes the injected default to upper case", () => {
    expect(baseWithDefaultCurrency(undefined, "usd")).toEqual({ currency: "USD" });
  });

  it("a message with no currency + no template now DEFAULTS instead of erroring", () => {
    // The end-to-end wiring: the SheetPage passes baseWithDefaultCurrency(templateBase, default).
    const res = parseDraft({ amount: 5, note: "coffee" }, baseWithDefaultCurrency(undefined, "USD"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.initial.currency).toBe("USD");
  });

  it("a message currency still beats the injected default", () => {
    const res = parseDraft({ amount: 5, currency: "EUR" }, baseWithDefaultCurrency(undefined, "USD"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.initial.currency).toBe("EUR");
  });
});

// ── Issue 2: parseDraftBatch (single object OR top-level array → many drafts, one card) ──────────
describe("parseDraftBatch", () => {
  it("parses a single OBJECT into one draft (backward compatible)", () => {
    const { drafts, errors } = parseDraftBatch({ amount: 25, currency: "USD", note: "one" });
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].initial.amount_minor).toBe(2500);
  });

  it("parses an ARRAY of 3 into 3 drafts with distinct draftIds", () => {
    const { drafts, errors } = parseDraftBatch([
      { amount: 10, currency: "USD", note: "a" },
      { amount: 20, currency: "USD", note: "b" },
      { amount: 30, currency: "USD", note: "c" },
    ]);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(3);
    const ids = drafts.map((d) => d.draftId);
    expect(new Set(ids).size).toBe(3); // all distinct
    // draftId and initial.draft_id stay in lock-step for every element.
    for (const d of drafts) expect(d.initial.draft_id).toBe(d.draftId);
  });

  it("keeps distinct draftIds even for byte-identical array elements", () => {
    const { drafts } = parseDraftBatch([
      { amount: 50, currency: "USD", note: "same" },
      { amount: 50, currency: "USD", note: "same" },
    ]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].draftId).not.toBe(drafts[1].draftId);
  });

  it("collects the valid elements and pushes one error per invalid element (no whole-batch fail)", () => {
    const { drafts, errors } = parseDraftBatch([
      { amount: 10, currency: "USD", note: "ok1" },
      { amount: 0, currency: "USD", note: "bad" }, // amount 0 → invalid
      { amount: 30, currency: "USD", note: "ok2" },
    ]);
    expect(drafts).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/amount/i);
  });

  it("a provided draft_id wins (never suffixed) even inside an array", () => {
    const { drafts } = parseDraftBatch([
      { amount: 10, currency: "USD", draft_id: "ext-1" },
      { amount: 20, currency: "USD", draft_id: "ext-2" },
    ]);
    expect(drafts.map((d) => d.draftId)).toEqual(["ext-1", "ext-2"]);
  });

  it("empty array → no drafts, no errors", () => {
    expect(parseDraftBatch([])).toEqual({ drafts: [], errors: [] });
  });

  it("all-invalid array → no drafts, one error per element", () => {
    const { drafts, errors } = parseDraftBatch([
      { amount: 0, currency: "USD" },
      { amount: -1, currency: "USD" },
    ]);
    expect(drafts).toHaveLength(0);
    expect(errors).toHaveLength(2);
  });

  it("a single invalid OBJECT → no drafts, the raw parse errors", () => {
    const { drafts, errors } = parseDraftBatch({ amount: 0, currency: "USD" });
    expect(drafts).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join(" ")).toMatch(/amount/i);
  });

  it("applies the default currency per element (array elements with no currency default)", () => {
    const { drafts } = parseDraftBatch(
      [{ amount: 10, note: "a" }, { amount: 20, currency: "EUR", note: "b" }],
      undefined,
      "USD",
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0].initial.currency).toBe("USD"); // defaulted
    expect(drafts[1].initial.currency).toBe("EUR"); // message currency wins
  });

  it("accepts a per-element resolver for `base` (each element may carry its own template ref)", () => {
    // Two elements route to two different template bases; the resolver is called per element.
    const resolve = (raw: unknown): Partial<EntryPayload> | undefined => {
      const t = (raw as { template?: string }).template;
      if (t === "Reservation") return { txn_type: "iou", currency: "EGP" };
      if (t === "Cash") return { txn_type: "settlement", currency: "GBP" };
      return undefined;
    };
    const { drafts } = parseDraftBatch(
      [
        { amount: 100, template: "Reservation", note: "resv" },
        { amount: 5, template: "Cash", note: "cash" },
      ],
      resolve,
    );
    expect(drafts).toHaveLength(2);
    expect(drafts[0].initial.currency).toBe("EGP");
    expect(drafts[0].initial.txn_type).toBe("iou");
    expect(drafts[1].initial.currency).toBe("GBP");
    expect(drafts[1].initial.txn_type).toBe("settlement");
  });

  it("tells a per-element resolver whether it is resolving a real multi-entry payload", () => {
    const contexts: unknown[] = [];
    const resolver = (_raw: unknown, ...rest: unknown[]) => {
      contexts.push(rest[0]);
      return undefined;
    };

    parseDraftBatch(
      [
        { amount: 10, currency: "USD", note: "a" },
        { amount: 20, currency: "USD", note: "b" },
      ],
      resolver,
    );
    expect(contexts).toEqual([
      { index: 0, total: 2, multiEntry: true },
      { index: 1, total: 2, multiEntry: true },
    ]);

    contexts.length = 0;
    parseDraftBatch({ amount: 10, currency: "USD", note: "single" }, resolver);
    expect(contexts).toEqual([{ index: 0, total: 1, multiEntry: false }]);
  });
});

// ── parsedToPayload: complete a ParsedDraft.initial into a full EntryPayload (batch write path) ──
describe("parsedToPayload", () => {
  it("completes a settlement initial into a full EntryPayload (kind=payment)", () => {
    const r = parseDraft({ kind: "settlement", amount: 25, currency: "USD", note: "lunch", date: "2026-06-20" });
    if (!r.ok) throw new Error("expected ok");
    const p = parsedToPayload(r.value.initial);
    expect(p.kind).toBe("payment");
    expect(p.txn_type).toBe("settlement");
    expect(p.currency).toBe("USD");
    expect(p.amount_minor).toBe(2500);
    expect(p.note).toBe("lunch");
    expect(p.schedule).toBeUndefined();
    expect(p.fee).toBeUndefined();
  });

  it("completes an IOU initial (kind=expense) carrying fee + schedule + ids", () => {
    const r = parseDraft(
      {
        kind: "iou",
        amount: 1000,
        currency: "EGP",
        fee_percent: 20,
        schedule: [{ due_date: "2026-07-01", percent: 50 }, { due_date: "2026-08-01", percent: 50 }],
        draft_id: "ext-9",
      },
    );
    if (!r.ok) throw new Error("expected ok");
    r.value.initial.import_message_id = "mid-1";
    const p = parsedToPayload(r.value.initial);
    expect(p.kind).toBe("expense");
    expect(p.txn_type).toBe("iou");
    expect(p.fee?.percent).toBe(20);
    expect(p.schedule).toHaveLength(2);
    expect(p.draft_id).toBe("ext-9");
    expect(p.import_message_id).toBe("mid-1");
  });
});

// ── batchSummary: the pending-card one-liner (count for multi, summary for single) ──────────────
describe("batchSummary", () => {
  it("shows the entry COUNT and each summary for a multi-entry card", () => {
    const res = parseDraftBatch([
      { amount: 10, currency: "USD", note: "a" },
      { amount: 20, currency: "USD", note: "b" },
    ]);
    const s = batchSummary(res);
    expect(s).toMatch(/^2 entries:/);
    expect(s).toContain("a");
    expect(s).toContain("b");
  });

  it("shows the single summary for a one-entry card (byte-identical to parseDraft)", () => {
    const res = parseDraftBatch({ amount: 10, currency: "USD", note: "solo" });
    expect(batchSummary(res)).toBe(res.drafts[0].summary);
  });

  it("shows a can't-import line when nothing parsed", () => {
    const res = parseDraftBatch({ amount: 0, currency: "USD" });
    expect(batchSummary(res)).toMatch(/can't import/i);
  });
});

// `note` used to carry TWO meanings: the human description of one transaction AND the raw message
// text that currency verification and date recovery mine. With one entry those are the same string,
// so the overload was invisible. With three they cannot be — every row of
// "Owe me 300 uber 150 food / 500 movies" got the whole message as its description. The manifest now
// stamps the raw text on `message` and leaves `note` as the model wrote it.
describe("message vs note — the evidence is separate from the description", () => {
  const MSG = "Owe me 300 uber 150 food 500 movies";

  it("keeps each entry's OWN note in a multi-entry batch", () => {
    const { drafts } = parseDraftBatch([
      { amount: 300, currency: "EGP", note: "uber", message: MSG },
      { amount: 150, currency: "EGP", note: "food", message: MSG },
      { amount: 500, currency: "EGP", note: "movies", message: MSG },
    ]);
    expect(drafts.map((d) => d.initial.note)).toEqual(["uber", "food", "movies"]);
  });

  it("recovers the DATE from `message`, not from the per-entry note", () => {
    // "Reservation" alone carries no date; the message does. Before the split this worked only
    // because note WAS the message — a short note would have silently dated the entry today.
    const { drafts } = parseDraftBatch([
      { amount: 25000, currency: "EGP", note: "Reservation", message: "Reservation 1-7 Aug 25000 EGP" },
    ]);
    const ts = drafts[0].initial.ts ?? 0;
    expect(new Date(ts).toISOString().slice(5, 10)).toBe("08-01");
  });

  it("uses only the Date field reviewed on an OpenChat card", () => {
    const hiddenGuess = {
      amount: 350,
      currency: "EGP",
      note: "CLEANING FEE 2023-04-05",
      message: "CLEANING FEE 2024-06-07",
    };
    const withoutDate = parseDraftBatch([hiddenGuess], undefined, undefined, {
      dateEvidence: "explicit-only",
    });
    expect(new Date(withoutDate.drafts[0].initial.ts ?? 0).toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );

    const reviewedDate = parseDraftBatch(
      [{ ...hiddenGuess, date: "2026-08-08" }],
      undefined,
      undefined,
      { dateEvidence: "explicit-only" },
    );
    expect(new Date(reviewedDate.drafts[0].initial.ts ?? 0).toISOString().slice(0, 10)).toBe(
      "2026-08-08",
    );
  });

  it("falls back to `note` for drafts written before the split", () => {
    // A card posted before this change carries the raw text in `note` and no `message` at all.
    const { drafts } = parseDraftBatch([{ amount: 25000, currency: "EGP", note: "Reservation 1-7 Aug 25000 EGP" }]);
    expect(new Date(drafts[0].initial.ts ?? 0).toISOString().slice(5, 10)).toBe("08-01");
  });

  it("a SINGLE entry with no model note falls back to the message (today's behaviour)", () => {
    const { drafts } = parseDraftBatch([{ amount: 300, currency: "EGP", message: "Owe 300 for uber" }]);
    expect(drafts[0].initial.note).toBe("Owe 300 for uber");
  });

  it("a MULTI entry with no model note does NOT get the whole message stamped on it", () => {
    // Leaving it empty is right: labelling one row with all three transactions is the original bug.
    const { drafts } = parseDraftBatch([
      { amount: 300, currency: "EGP", message: MSG },
      { amount: 150, currency: "EGP", note: "food", message: MSG },
    ]);
    expect(drafts[0].initial.note).toBe("");
    expect(drafts[1].initial.note).toBe("food");
  });

  it("messageEvidence prefers message, falls back to note, else empty", () => {
    expect(messageEvidence({ message: "m", note: "n" })).toBe("m");
    expect(messageEvidence({ note: "n" })).toBe("n");
    expect(messageEvidence({ message: "   ", note: "n" })).toBe("n");
    expect(messageEvidence({})).toBe("");
  });
});

// ── The reported message, end to end on IOU's side ───────────────────────────
//
// The OpenChat half of this pipeline is pinned in aiAction.test.ts against a reply captured verbatim
// from the on-device model. This is the same payload arriving HERE — the array the app card hands
// back on "Add all N entries" — so the two halves are guarded against the same real case and a drop
// cannot hide in the seam between the repos.
//
// The user reported this message twice: first every entry got the whole message as its note and one
// value was duplicated while another vanished, then later that only two entries arrived at all.
describe("parseDraftBatch — 'Owe me 300 uber 150 food\n\n500 movies'", () => {
  // Exactly what the model produced, post-passed, as the card hands it over.
  const CONFIRMED = [
    { kind: "iou", amount: 300, currency: "USD", direction: "credit", note: "Uber ride", message: "Owe me 300 uber 150 food\n\n500 movies" },
    { kind: "iou", amount: 150, currency: "USD", direction: "credit", note: "Food", message: "Owe me 300 uber 150 food\n\n500 movies" },
    { kind: "iou", amount: 500, currency: "USD", direction: "credit", note: "Movies", message: "Owe me 300 uber 150 food\n\n500 movies" },
  ];

  // Read back in MAJOR units so the expectations match the message the user typed.
  // NaN rather than 0 for a missing amount: a dropped value must fail the comparison loudly instead
  // of reading as a legitimate zero.
  const majors = (ds: ReturnType<typeof parseDraftBatch>["drafts"]) =>
    ds.map((d) => (d.initial.amount_minor ?? NaN) / 100);

  it("imports ALL THREE — two from one line, one from the next", () => {
    const { drafts, errors } = parseDraftBatch(CONFIRMED);
    expect(errors).toEqual([]);
    expect(majors(drafts)).toEqual([300, 150, 500]);
  });

  it("gives each entry its own note, not the shared message", () => {
    // The message is carried on every element as EVIDENCE (currency verification, date recovery). It
    // must never become the description — that was the first bug: three rows all reading
    // "Owe me 300 uber 150 food 500 movies".
    const { drafts } = parseDraftBatch(CONFIRMED);
    expect(drafts.map((d) => d.initial.note)).toEqual(["Uber ride", "Food", "Movies"]);
    for (const d of drafts) {
      expect(d.initial.note).not.toContain("500 movies");
    }
  });

  it("keeps 150 even though 300 appears first on the same line", () => {
    // Named for the exact report ("it repeated 300 egp and didn't use 150 egp"). Distinct amounts on
    // one line must stay distinct entries — no merge, no dedupe by line.
    const { drafts } = parseDraftBatch(CONFIRMED);
    const amounts = majors(drafts);
    expect(amounts).toContain(150);
    expect(amounts.filter((a) => a === 300)).toHaveLength(1);
  });

  it("keeps the good entries when one element is unusable", () => {
    // A partial import beats no import: the user can add the rest by hand, but a rejected CARD loses
    // everything and gives no hint which element was at fault.
    const { drafts, errors } = parseDraftBatch([CONFIRMED[0], { amount: 0, currency: "USD", note: "Food" }, CONFIRMED[2]]);
    expect(majors(drafts)).toEqual([300, 500]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
