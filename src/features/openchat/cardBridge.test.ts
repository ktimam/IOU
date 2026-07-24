import { describe, it, expect } from "vitest";
import {
  parseInit,
  initToFormState,
  initEntries,
  buildConfirmPayload,
  buildMultiConfirmPayload,
  buildReady,
  buildResize,
  buildConfirm,
  buildCancel,
  CARD_MSG,
  type CardFormState,
} from "./cardBridge";
import { parseDraft, parseDraftBatch } from "../entries/draft";

describe("parseInit — accepts only a well-formed oc:card:init", () => {
  it("accepts a valid init and normalizes data + context", () => {
    const parsed = parseInit({
      type: "oc:card:init",
      version: 1,
      data: { kind: "iou", amount: 42.5, currency: "eur", direction: "debt", note: "rent" },
      context: { chatKey: "group:aaaaa-aa", appId: "iou.entry.import", theme: "light", readonly: false },
    });
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.data.amount).toBe(42.5);
    expect(parsed.data.currency).toBe("eur");
    expect(parsed.context.theme).toBe("light");
    expect(parsed.context.readonly).toBe(false);
    expect(parsed.context.chatKey).toBe("group:aaaaa-aa");
    expect(parsed.context.appId).toBe("iou.entry.import");
  });

  it("defaults theme to dark and readonly to false when context is missing/partial", () => {
    const parsed = parseInit({ type: "oc:card:init", version: 1, data: { amount: 1 } });
    expect(parsed).not.toBeNull();
    if (!parsed) return;
    expect(parsed.context.theme).toBe("dark");
    expect(parsed.context.readonly).toBe(false);
    expect(parsed.data.amount).toBe(1);
  });

  it("carries readonly:true through", () => {
    const parsed = parseInit({
      type: "oc:card:init",
      version: 1,
      data: {},
      context: { theme: "dark", readonly: true },
    });
    expect(parsed?.context.readonly).toBe(true);
  });

  it("coerces a missing/non-object data to an empty object", () => {
    const parsed = parseInit({ type: "oc:card:init", version: 1 });
    expect(parsed).not.toBeNull();
    expect(parsed?.data).toEqual({});
    const arr = parseInit({ type: "oc:card:init", version: 1, data: [1, 2, 3] });
    expect(arr?.data).toEqual({});
  });

  it("rejects bogus / foreign messages", () => {
    expect(parseInit(null)).toBeNull();
    expect(parseInit(undefined)).toBeNull();
    expect(parseInit(42)).toBeNull();
    expect(parseInit("oc:card:init")).toBeNull();
    expect(parseInit([])).toBeNull();
    // wrong type
    expect(parseInit({ type: "oc:card:confirm", version: 1, data: {} })).toBeNull();
    // wrong / missing version
    expect(parseInit({ type: "oc:card:init", data: {} })).toBeNull();
    expect(parseInit({ type: "oc:card:init", version: 2, data: {} })).toBeNull();
    expect(parseInit({ type: "oc:card:init", version: "1", data: {} })).toBeNull();
    // an unrelated postMessage (e.g. React devtools / webpack)
    expect(parseInit({ source: "react-devtools-bridge", payload: {} })).toBeNull();
  });
});

describe("initToFormState — prefill", () => {
  it("seeds every field from the extraction object", () => {
    const s = initToFormState({
      kind: "iou",
      amount: 1000,
      currency: "egp",
      direction: "debt",
      note: "Reservation",
      date: "2026-08-01",
    });
    expect(s).toEqual<CardFormState>({
      kind: "iou",
      amount: "1000",
      currency: "EGP",
      direction: "debt",
      note: "Reservation",
      date: "2026-08-01",
      tags: [],
    });
  });

  it("defaults currency to USD and direction to credit when absent", () => {
    const s = initToFormState({ amount: 5 });
    expect(s.currency).toBe("USD");
    expect(s.direction).toBe("credit");
    expect(s.amount).toBe("5");
    // kind absent → "" (omitted from payload so parseDraft re-infers)
    expect(s.kind).toBe("");
    expect(s.date).toBe("");
    expect(s.note).toBe("");
  });

  it("keeps a string amount as-is and blanks a missing amount", () => {
    expect(initToFormState({ amount: "25.00" }).amount).toBe("25.00");
    expect(initToFormState({}).amount).toBe("");
  });
});

describe("buildConfirmPayload — edited values", () => {
  it("emits an EntryDraft parseDraft accepts", () => {
    const payload = buildConfirmPayload({
      kind: "iou",
      amount: "42.50",
      currency: "usd",
      direction: "credit",
      note: "dinner",
      date: "2026-06-24",
      tags: [],
    });
    expect(payload.amount).toBe(42.5);
    expect(payload.currency).toBe("USD");
    expect(payload.direction).toBe("credit");
    expect(payload.kind).toBe("iou");
    expect(payload.date).toBe("2026-06-24");
    // demo tags omitted when none selected
    expect("tags" in payload).toBe(false);

    const r = parseDraft(payload);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.initial.amount_minor).toBe(4250);
      expect(r.value.initial.direction).toBe("credit");
      expect(r.value.initial.currency).toBe("USD");
    }
  });

  it("round-trips direction / currency / amount edits", () => {
    const base: CardFormState = {
      kind: "",
      amount: "7",
      currency: "gbp",
      direction: "credit",
      note: "",
      date: "",
      tags: [],
    };
    const flipped = buildConfirmPayload({ ...base, direction: "debt", currency: "jpy", amount: "300" });
    expect(flipped.direction).toBe("debt");
    expect(flipped.currency).toBe("JPY");
    expect(flipped.amount).toBe(300);
    // kind "" is omitted so parseDraft infers it
    expect("kind" in flipped).toBe(false);
    // date "" is omitted
    expect("date" in flipped).toBe(false);
  });

  it("includes the demo tags only when at least one is selected", () => {
    const payload = buildConfirmPayload({
      kind: "settlement",
      amount: "10",
      currency: "USD",
      direction: "credit",
      note: "",
      date: "",
      tags: ["work", "reimbursable"],
    });
    expect((payload as { tags?: string[] }).tags).toEqual(["work", "reimbursable"]);
    // parseDraft ignores the unknown `tags` field (safe/demonstrative)
    expect(parseDraft(payload).ok).toBe(true);
  });

  it("keeps a non-numeric amount as a raw string so downstream validation surfaces it", () => {
    const payload = buildConfirmPayload({
      kind: "",
      amount: "",
      currency: "USD",
      direction: "credit",
      note: "",
      date: "",
      tags: [],
    });
    expect(payload.amount).toBe("");
    expect(parseDraft(payload).ok).toBe(false);
  });
});

describe("outbound message builders", () => {
  it("builds the four host-bound messages with the exact bridge types", () => {
    expect(buildReady()).toEqual({ type: CARD_MSG.ready });
    expect(buildReady().type).toBe("oc:card:ready");
    expect(buildResize(320)).toEqual({ type: "oc:card:resize", height: 320 });
    const p = { amount: 1, currency: "USD", direction: "credit" as const };
    expect(buildConfirm(p)).toEqual({ type: "oc:card:confirm", payload: p });
    expect(buildCancel()).toEqual({ type: "oc:card:cancel" });
  });

  it("wraps a MULTI-mode array payload under the same confirm type (unwrapped array)", () => {
    const arr = [
      { amount: 1, currency: "USD", direction: "credit" as const },
      { amount: 2, currency: "EUR", direction: "debt" as const },
    ];
    expect(buildConfirm(arr)).toEqual({ type: "oc:card:confirm", payload: arr });
  });
});

// ── MULTI mode (data.entries) ────────────────────────────────────────────────

describe("parseInit — MULTI mode (data.entries)", () => {
  it("carries a non-empty entries array through as data.entries", () => {
    const parsed = parseInit({
      type: "oc:card:init",
      version: 1,
      data: {
        entries: [
          { amount: 10, currency: "usd", direction: "credit", note: "a" },
          { amount: 20, currency: "eur", direction: "debt", note: "b" },
        ],
      },
      context: { theme: "dark", readonly: false },
    });
    expect(parsed).not.toBeNull();
    expect(Array.isArray(parsed?.data.entries)).toBe(true);
    expect(parsed?.data.entries?.length).toBe(2);
  });

  it("keeps only object elements (validate array-of-objects)", () => {
    const parsed = parseInit({
      type: "oc:card:init",
      version: 1,
      data: { entries: [{ amount: 1 }, 5, null, "x", { amount: 2 }] },
    });
    expect(parsed?.data.entries?.length).toBe(2);
  });

  it("a bare EntryDraft (no entries) stays SINGLE — no entries key added", () => {
    const parsed = parseInit({
      type: "oc:card:init",
      version: 1,
      data: { amount: 7, currency: "usd" },
    });
    expect(parsed?.data.entries).toBeUndefined();
  });
});

describe("initEntries — MULTI vs SINGLE detection", () => {
  it("returns one form state per entry (MULTI), each via the single initToFormState logic", () => {
    const states = initEntries({
      entries: [
        { kind: "iou", amount: 100, currency: "egp", direction: "debt", note: "rent" },
        { amount: 5, currency: "usd", direction: "credit", note: "lunch" },
      ],
    });
    expect(states).not.toBeNull();
    expect(states).toHaveLength(2);
    expect(states![0]).toEqual<CardFormState>({
      kind: "iou",
      amount: "100",
      currency: "EGP",
      direction: "debt",
      note: "rent",
      date: "",
      tags: [],
    });
    expect(states![1].currency).toBe("USD");
    expect(states![1].direction).toBe("credit");
    // byte-identical to calling initToFormState per element
    expect(states![1]).toEqual(
      initToFormState({ amount: 5, currency: "usd", direction: "credit", note: "lunch" }),
    );
  });

  it("returns null for the SINGLE / absent path", () => {
    expect(initEntries({})).toBeNull();
    expect(initEntries({ amount: 5 })).toBeNull(); // bare EntryDraft (single)
    expect(initEntries({ entries: [] })).toBeNull(); // empty → single
    expect(initEntries({ entries: undefined })).toBeNull(); // absent → single
  });
});

describe("buildMultiConfirmPayload — edited array round-trip", () => {
  const states: CardFormState[] = [
    { kind: "iou", amount: "42.50", currency: "usd", direction: "credit", note: "dinner", date: "", tags: [] },
    { kind: "", amount: "300", currency: "jpy", direction: "debt", note: "", date: "", tags: [] },
  ];

  it("yields an UNWRAPPED array, one element per state, each matching buildConfirmPayload", () => {
    const payload = buildMultiConfirmPayload(states);
    expect(Array.isArray(payload)).toBe(true);
    expect(payload).toHaveLength(2);
    // element 0 round-trips amount/currency/direction/note (+ kind)
    expect(payload[0]).toMatchObject({
      amount: 42.5,
      currency: "USD",
      direction: "credit",
      note: "dinner",
      kind: "iou",
    });
    // element 1: kind "" omitted, currency uppercased, amount coerced to number
    expect(payload[1]).toMatchObject({ amount: 300, currency: "JPY", direction: "debt" });
    expect("kind" in payload[1]).toBe(false);
    // each element is exactly what the single builder produces
    expect(payload[0]).toEqual(buildConfirmPayload(states[0]));
    expect(payload[1]).toEqual(buildConfirmPayload(states[1]));
  });

  it("imports element-by-element through parseDraftBatch (the canister side)", () => {
    const payload = buildMultiConfirmPayload([
      { kind: "", amount: "10", currency: "USD", direction: "credit", note: "a", date: "", tags: [] },
      { kind: "", amount: "20", currency: "EUR", direction: "debt", note: "b", date: "", tags: [] },
    ]);
    const { drafts, errors } = parseDraftBatch(payload);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].initial.amount_minor).toBe(1000);
    expect(drafts[0].initial.direction).toBe("credit");
    expect(drafts[1].initial.amount_minor).toBe(2000);
    expect(drafts[1].initial.direction).toBe("debt");
  });
});
