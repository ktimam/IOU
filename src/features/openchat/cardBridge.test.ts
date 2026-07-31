import { describe, it, expect } from "vitest";
import {
  parseInit,
  parseBusy,
  currencyStatedIn,
  initToFormState,
  initEntries,
  buildConfirmPayload,
  buildMultiConfirmPayload,
  buildReady,
  buildResize,
  buildConfirm,
  buildCancel,
  CARD_MSG,
  MAX_CARD_ENTRIES,
  type CardFormState,
} from "./cardBridge";
import { parseDraft, parseDraftBatch, baseWithDefaultCurrency } from "../entries/draft";

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
      // The note must STATE the currency for it to be seeded — an unstated one now defers to the
      // user's default (see the currencyStatedIn tests below).
      note: "Reservation 1000 EGP",
      date: "2026-08-01",
    });
    expect(s).toEqual<CardFormState>({
      kind: "iou",
      amount: "1000",
      currency: "EGP",
      direction: "debt",
      note: "Reservation 1000 EGP",
      date: "2026-08-01",
    });
  });

  it("leaves currency EMPTY (defer to IOU default) and direction credit when absent", () => {
    const s = initToFormState({ amount: 5 });
    // "" is the "Your IOU default" sentinel: the storage-partitioned card can't read the user's
    // prefs.defaultCurrency, so it must NOT invent USD — buildConfirmPayload omits currency and the
    // real IOU app fills the default at import (baseWithDefaultCurrency).
    expect(s.currency).toBe("");
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
    });
    expect(payload.amount).toBe(42.5);
    expect(payload.currency).toBe("USD");
    expect(payload.direction).toBe("credit");
    expect(payload.kind).toBe("iou");
    expect(payload.date).toBe("2026-06-24");

    const r = parseDraft(payload);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.initial.amount_minor).toBe(4250);
      expect(r.value.initial.direction).toBe("credit");
      expect(r.value.initial.currency).toBe("USD");
    }
  });

  it("OMITS currency when left on Default ('') so the IOU default is filled at import", () => {
    const payload = buildConfirmPayload({
      kind: "iou",
      amount: "120",
      currency: "",
      direction: "credit",
      note: "groceries",
      date: "",
    });
    expect("currency" in payload).toBe(false);
    // The real sheet import parses the currency-less draft against a base carrying the user's
    // default (baseWithDefaultCurrency), so the entry resolves to that default — not a card-invented
    // USD. A user whose IOU default is EGP gets EGP.
    const r = parseDraft(payload, baseWithDefaultCurrency(undefined, "EGP"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.initial.currency).toBe("EGP");
  });

  it("round-trips direction / currency / amount edits", () => {
    const base: CardFormState = {
      kind: "",
      amount: "7",
      currency: "gbp",
      direction: "credit",
      note: "",
      date: "",
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


  it("keeps a non-numeric amount as a raw string so downstream validation surfaces it", () => {
    const payload = buildConfirmPayload({
      kind: "",
      amount: "",
      currency: "USD",
      direction: "credit",
      note: "",
      date: "",
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

describe("parseBusy — host progress signal", () => {
  it("accepts a well-formed oc:card:busy with a boolean", () => {
    expect(parseBusy({ type: "oc:card:busy", busy: true })).toEqual({ busy: true });
    expect(parseBusy({ type: "oc:card:busy", version: 1, busy: false })).toEqual({ busy: false });
  });

  it("returns null for the wrong type, a non-boolean busy, or a non-object", () => {
    expect(parseBusy({ type: "oc:card:init", busy: true })).toBeNull();
    expect(parseBusy({ type: "oc:card:busy", busy: "yes" })).toBeNull();
    expect(parseBusy({ type: "oc:card:busy" })).toBeNull();
    expect(parseBusy(null)).toBeNull();
    expect(parseBusy("oc:card:busy")).toBeNull();
  });

  it("does not collide with parseInit (each ignores the other's message)", () => {
    expect(parseInit({ type: "oc:card:busy", busy: true })).toBeNull();
    expect(parseBusy({ type: CARD_MSG.init, version: 1, data: {}, context: {} })).toBeNull();
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

  it("caps entries at MAX_CARD_ENTRIES so an oversized init can't hang the frame", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ amount: i + 1, currency: "USD", direction: "credit" }));
    const parsed = parseInit({ type: "oc:card:init", version: 1, data: { entries: many }, context: { theme: "dark", readonly: false } });
    expect(parsed?.data.entries?.length).toBe(MAX_CARD_ENTRIES);
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
        { kind: "iou", amount: 100, currency: "egp", direction: "debt", note: "rent 100 EGP" },
        { amount: 5, currency: "usd", direction: "credit", note: "lunch 5 USD" },
      ],
    });
    expect(states).not.toBeNull();
    expect(states).toHaveLength(2);
    expect(states![0]).toEqual<CardFormState>({
      kind: "iou",
      amount: "100",
      currency: "EGP",
      direction: "debt",
      note: "rent 100 EGP",
      date: "",
    });
    expect(states![1].currency).toBe("USD");
    expect(states![1].direction).toBe("credit");
    // byte-identical to calling initToFormState per element (same note, so the same currency rule
    // applies to both — a MULTI entry is seeded exactly like a single one)
    expect(states![1]).toEqual(
      initToFormState({ amount: 5, currency: "usd", direction: "credit", note: "lunch 5 USD" }),
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
    { kind: "iou", amount: "42.50", currency: "usd", direction: "credit", note: "dinner", date: "" },
    { kind: "", amount: "300", currency: "jpy", direction: "debt", note: "", date: "" },
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
      { kind: "", amount: "10", currency: "USD", direction: "credit", note: "a", date: "" },
      { kind: "", amount: "20", currency: "EUR", direction: "debt", note: "b", date: "" },
    ]);
    const { drafts, errors } = parseDraftBatch(payload);
    expect(errors).toEqual([]);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].initial.amount_minor).toBe(1000);
    expect(drafts[0].initial.direction).toBe("credit");
    expect(drafts[1].initial.amount_minor).toBe(2000);
    expect(drafts[1].initial.direction).toBe("debt");
  });

  it("omits currency PER ROW left on Default ('') so each defers to the IOU default at import", () => {
    // A mixed batch: row 0 on "Default", row 1 picked EUR — the default is a per-element decision.
    const payload = buildMultiConfirmPayload([
      { kind: "", amount: "10", currency: "", direction: "credit", note: "a", date: "" },
      { kind: "", amount: "20", currency: "eur", direction: "debt", note: "b", date: "" },
    ]);
    expect("currency" in payload[0]).toBe(false);
    expect(payload[1].currency).toBe("EUR");
    // At import the currency-less element resolves to the injected default, the EUR element keeps EUR.
    const { drafts, errors } = parseDraftBatch(payload, undefined, "EGP");
    expect(errors).toEqual([]);
    expect(drafts[0].initial.currency).toBe("EGP");
    expect(drafts[1].initial.currency).toBe("EUR");
  });
});

describe("currencyStatedIn / model-invented currency defers to the user's default", () => {
  it("treats a currency the message never stated as NOT stated", () => {
    // The real report: child wrote "Owe 300 uber" (no currency) and the on-device model emitted USD,
    // so an EGP user's entry imported as USD.
    expect(currencyStatedIn("Owe 300 uber", "USD")).toBe(false);
    expect(currencyStatedIn("cleaning fee 350", "EGP")).toBe(false);
    expect(currencyStatedIn("", "USD")).toBe(false);
  });

  it("honours a currency the message DID state (code or symbol)", () => {
    expect(currencyStatedIn("Owe 300 USD for uber", "USD")).toBe(true);
    expect(currencyStatedIn("owe 300 usd", "USD")).toBe(true);
    expect(currencyStatedIn("rent 5000 EGP", "EGP")).toBe(true);
    expect(currencyStatedIn("paid $300", "USD")).toBe(true);
    expect(currencyStatedIn("paid £20", "GBP")).toBe(true);
  });

  it("does not match a code inside a longer word", () => {
    expect(currencyStatedIn("usduber", "USD")).toBe(false);
    expect(currencyStatedIn("crusade", "USD")).toBe(false);
  });

  it("initToFormState DROPS an unstated currency so the IOU default wins at import", () => {
    const s = initToFormState({ amount: 300, currency: "USD", direction: "debt", note: "Owe 300 uber" });
    expect(s.currency).toBe("");                       // -> "Your IOU default" in the card
    const payload = buildConfirmPayload(s);
    expect("currency" in payload).toBe(false);          // -> omitted on the wire
    const r = parseDraft(payload, baseWithDefaultCurrency(undefined, "EGP"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.initial.currency).toBe("EGP");   // the presser's default
  });

  it("initToFormState KEEPS a currency the message stated", () => {
    const s = initToFormState({ amount: 300, currency: "usd", direction: "debt", note: "Owe 300 USD uber" });
    expect(s.currency).toBe("USD");
    expect(buildConfirmPayload(s).currency).toBe("USD");
  });
});

// The default currency is a PER-USER fact, and the card must leave it to import to resolve.
//
// A tempting shortcut is to have the card show a code fetched by chatKey (we built and reverted
// exactly that — see the MemoryId 21 note in lib.rs). It cannot work: an OpenChat direct-chat key
// names only the COUNTERPARTY, so `direct:<father>` is the same string for every user who chats with
// him — mother's and child's values collide on one entry. And it answers the wrong question: a
// father-created sheet is USD, so an EGP user's "Owe 300 uber" would import as USD, which is the very
// bug the deferral exists to prevent. These tests pin the per-user contract so that shortcut can't
// come back unnoticed.
// The DEPLOYMENT's card currency (Config.card_currency), fetched anonymously by the frame.
//
// It is app-level, not per viewer, because the frame cannot identify its viewer (measured: no
// localStorage / IndexedDB / caches / BroadcastChannel / Storage Access from inside OpenChat's
// `credentialless` iframe) and a chat-keyed value is contested between users (an OpenChat direct-chat
// key names only the counterparty). Both members of a card therefore see and import the SAME code —
// an accepted trade-off, since it is a pre-selection anyone can change before confirming.
describe("app card currency seed", () => {
  it("fills a message that stated no currency, and travels in the payload", () => {
    const s = initToFormState({ amount: 300, direction: "debt", note: "Owe 300 uber" }, "EGP");
    expect(s.currency).toBe("EGP");
    expect(buildConfirmPayload(s).currency).toBe("EGP");
  });

  it("overrides a currency the model INVENTED (the note never stated it)", () => {
    const s = initToFormState(
      { amount: 300, currency: "USD", direction: "debt", note: "Owe 300 uber" },
      "EGP",
    );
    expect(s.currency).toBe("EGP");
  });

  it("does NOT override a currency the message actually stated", () => {
    const s = initToFormState(
      { amount: 300, currency: "USD", direction: "debt", note: "Owe 300 USD uber" },
      "EGP",
    );
    expect(s.currency).toBe("USD");
  });

  it("unset (\"\") keeps today's per-user deferral", () => {
    const s = initToFormState({ amount: 300, currency: "USD", direction: "debt", note: "Owe 300 uber" });
    expect(s.currency).toBe("");
    expect("currency" in buildConfirmPayload(s)).toBe(false);
  });

  it("normalizes a sloppy seed rather than putting junk on the wire", () => {
    expect(initToFormState({ amount: 1, note: "x" }, "  egp ").currency).toBe("EGP");
  });

  it("seeds every entry of a MULTI card", () => {
    const states = initEntries(
      { entries: [{ amount: 1, currency: "USD", note: "a" }, { amount: 2, note: "b" }, { amount: 3, currency: "USD", note: "c 3 USD" }] },
      "EGP",
    );
    // invented -> seeded, absent -> seeded, stated -> kept
    expect(states?.map((x) => x.currency)).toEqual(["EGP", "EGP", "USD"]);
  });
});

describe("with NO app card currency set, the default is resolved PER USER at import", () => {
  it("the SAME confirmed card yields each presser's own default", () => {
    // "Owe 300 uber" — no currency in the message (the model's invented USD is dropped upstream).
    const payload = buildConfirmPayload(
      initToFormState({ amount: 300, currency: "USD", direction: "debt", note: "Owe 300 uber" }),
    );
    expect("currency" in payload).toBe(false); // nothing on the wire to override the presser

    const child = parseDraft(payload, baseWithDefaultCurrency(undefined, "EGP"));
    const father = parseDraft(payload, baseWithDefaultCurrency(undefined, "USD"));
    expect(child.ok && child.value.initial.currency).toBe("EGP");
    expect(father.ok && father.value.initial.currency).toBe("USD");
  });

  it("MULTI mode defers every entry the message left unstated", () => {
    const states = initEntries({
      entries: [
        { amount: 1, currency: "USD", note: "a" }, // invented → dropped
        { amount: 2, note: "b" }, // absent → dropped
        { amount: 3, currency: "USD", note: "c 3 USD" }, // stated → kept
      ],
    });
    expect(states?.map((x) => x.currency)).toEqual(["", "", "USD"]);
    const wire = buildMultiConfirmPayload(states ?? []);
    expect(wire.map((p) => "currency" in p)).toEqual([false, false, true]);
  });

  it("never invents a currency from anything but the message itself", () => {
    // No chat key, no sheet, no cached pick can enter here — the signature takes only the extraction.
    expect(initToFormState({ amount: 300, currency: "EGP", note: "Owe 300 uber" }).currency).toBe("");
    expect(initToFormState({ amount: 300, note: "Owe 300 uber" }).currency).toBe("");
  });
});
