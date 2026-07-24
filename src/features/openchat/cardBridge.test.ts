import { describe, it, expect } from "vitest";
import {
  parseInit,
  initToFormState,
  buildConfirmPayload,
  buildReady,
  buildResize,
  buildConfirm,
  buildCancel,
  CARD_MSG,
  type CardFormState,
} from "./cardBridge";
import { parseDraft } from "../entries/draft";

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
});
