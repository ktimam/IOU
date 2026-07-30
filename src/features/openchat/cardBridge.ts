// Pure postMessage-bridge helpers for the /openchat/card page (the app-rendered
// confirmable card OpenChat embeds as a storage-partitioned iframe in the chat
// bubble). See fork-notes/08-app-rendered-cards.md §"Bridge protocol".
//
// This module is DOM-free and React-free so the wire logic — parse an inbound
// init, seed the form, build the outbound confirm payload — is unit-testable in
// isolation. OpenChatCardPage.tsx owns the actual window.postMessage / listener
// plumbing and the rendering; it delegates every value decision to the pure
// functions here.
//
// The iframe is storage-partitioned (embedded cross-origin), so this code MUST
// NOT touch the IOU canister or the user's identity — it only renders + collects
// values and hands them back over the bridge.

import type { EntryDraft } from "../entries/draft";
import type { Direction } from "../entries/types";

// The bridge message type strings, both directions. Exactly the values in the
// build contract; kept in one table so page + tests can't drift.
export const CARD_MSG = {
  // iframe (app) → host
  ready: "oc:card:ready",
  resize: "oc:card:resize",
  confirm: "oc:card:confirm",
  cancel: "oc:card:cancel",
  // host → iframe (app)
  init: "oc:card:init",
  busy: "oc:card:busy",
} as const;

// The init protocol version this page speaks. parseInit rejects any other.
export const CARD_INIT_VERSION = 1 as const;

// Upper bound on how many entries a MULTI card will render. A real "several transactions in one
// message" extraction is a handful; this only exists so a hostile/oversized init can't ask the page to
// render hundreds of thousands of EntryRows and hang the frame. Excess entries are dropped.
export const MAX_CARD_ENTRIES = 100;

export type CardTheme = "light" | "dark";

// The normalized init context the page renders against. `data` is the extraction
// object (loose EntryDraft prefill); theme + readonly drive presentation.
export type CardInitContext = {
  chatKey?: string;
  appId?: string;
  actionId?: string;
  theme: CardTheme;
  readonly: boolean;
};

// The init `data` is EITHER a bare EntryDraft (SINGLE mode — the current, byte-identical behavior)
// OR an object carrying a non-empty `entries` array (MULTI mode — a batch of EntryDrafts rendered
// as N editable rows). `entries` is optional, so a single-entry card's data still satisfies this
// type. initEntries(data) is the sole detector: non-empty entries → MULTI, else → SINGLE.
export type CardInitData = EntryDraft & { entries?: EntryDraft[] };

export type CardInit = {
  data: CardInitData;
  context: CardInitContext;
};

// The editable form the page collects. Every field is a plain string except the
// demo `tags` multiselect. `kind` is a passthrough (not edited by the card UI):
// "" means the extraction carried no kind, so buildConfirmPayload omits it and
// parseDraft re-infers it. `date` is likewise a passthrough of the prefill date.
export type CardFormState = {
  kind: "iou" | "settlement" | "";
  amount: string;
  currency: string;
  direction: Direction;
  note: string;
  date: string;
  tags: string[];
};

// The confirm payload handed back to the host. It is an EntryDraft (which IOU's
// parseDraft already accepts) plus a demonstrative `tags` array parseDraft
// ignores as an unknown field.
export type CardConfirmPayload = EntryDraft & { tags?: string[] };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse an inbound postMessage into a normalized CardInit, or null when it is
 * not a well-formed `oc:card:init` (wrong type, wrong/missing version, not an
 * object). Foreign frames (React devtools, webpack HMR, etc.) all fall through
 * to null so the page ignores them. `data` and `context` are defaulted, never
 * trusted verbatim.
 */
export function parseInit(msg: unknown): CardInit | null {
  if (!isPlainObject(msg)) return null;
  if (msg.type !== CARD_MSG.init) return null;
  if (msg.version !== CARD_INIT_VERSION) return null;

  let data: CardInitData;
  if (isPlainObject(msg.data)) {
    const raw = msg.data as Record<string, unknown>;
    if (Array.isArray(raw.entries)) {
      // MULTI: validate `entries` is an array of objects — drop any non-object element so a
      // malformed row can't crash initToFormState, and cap the count so an oversized init can't hang
      // the frame. A non-array `entries` falls through to SINGLE.
      const entries = raw.entries.filter(isPlainObject).slice(0, MAX_CARD_ENTRIES) as EntryDraft[];
      data = { ...(raw as EntryDraft), entries };
    } else {
      data = raw as EntryDraft;
    }
  } else {
    data = {};
  }

  const ctxIn = isPlainObject(msg.context) ? msg.context : {};
  const context: CardInitContext = {
    theme: ctxIn.theme === "light" ? "light" : "dark",
    readonly: ctxIn.readonly === true,
    ...(typeof ctxIn.chatKey === "string" ? { chatKey: ctxIn.chatKey } : {}),
    ...(typeof ctxIn.appId === "string" ? { appId: ctxIn.appId } : {}),
    ...(typeof ctxIn.actionId === "string" ? { actionId: ctxIn.actionId } : {}),
  };

  return { data, context };
}

// Parse an inbound `oc:card:busy` — the host's progress signal while a confirm/cancel round-trips
// (deposit + fan-out). Returns { busy } or null for anything else, so the page's one listener can try
// this alongside parseInit. Like parseInit it trusts only the SHAPE (a bare boolean), never any
// origin-carried data — the message conveys no secret and drives presentation only.
export function parseBusy(msg: unknown): { busy: boolean } | null {
  if (!isPlainObject(msg)) return null;
  if (msg.type !== CARD_MSG.busy) return null;
  if (typeof msg.busy !== "boolean") return null;
  return { busy: msg.busy };
}

/** Seed the editable form from the (loose, untrusted) extraction object. */
// Currency symbols worth honouring when a message writes the symbol instead of the ISO code.
const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "£": "GBP",
  "€": "EUR",
  "¥": "JPY",
  "₹": "INR",
  "ج.م": "EGP",
};

/**
 * Did the MESSAGE actually state this currency, or did the extraction model invent it?
 *
 * The model routinely emits a currency the message never mentions ("Owe 300 uber" -> USD), and the
 * prompt asking it to omit one is not binding on a small on-device model. We can check deterministically
 * because IOU's own `from_message` rule copies the message text into `note` — so the note IS the
 * message. A currency counts as stated when its ISO code appears as a WHOLE word (so "USD" does not
 * match inside a longer token) or when a symbol that maps to it appears.
 *
 * Unverifiable (no note) counts as NOT stated: deferring to the user's own default currency is the
 * safer, more predictable outcome, and it is exactly what they asked for.
 */
export function currencyStatedIn(text: string, code: string): boolean {
  const c = code.trim().toUpperCase();
  if (c === "" || text.trim() === "") return false;
  if (new RegExp(`(?:^|[^A-Za-z])${c}(?:[^A-Za-z]|$)`, "i").test(text)) return true;
  return Object.entries(CURRENCY_SYMBOLS).some(([sym, mapped]) => mapped === c && text.includes(sym));
}

export function initToFormState(data: EntryDraft, seedCurrency = ""): CardFormState {
  const kind = data.kind === "settlement" || data.kind === "iou" ? data.kind : "";
  const amount = data.amount != null ? String(data.amount) : "";
  // Empty ("") is the sentinel for "no currency → let the REAL IOU app fill the user's default
  // (prefs.defaultCurrency) at import". The card iframe is storage-partitioned and CANNOT read those
  // prefs, so it must NOT invent a currency; it shows a "Your IOU default" option for this state and
  // buildConfirmPayload omits currency so baseWithDefaultCurrency resolves it against the default of
  // whoever pressed Add to IOU.
  //
  // `seedCurrency` overrides that deferral with the DEPLOYMENT's card currency (Config.card_currency,
  // fetched anonymously — see cardCurrency.ts). It is app-level on purpose: the frame cannot identify
  // its viewer (measured: no localStorage / IndexedDB / caches / BroadcastChannel / Storage Access),
  // and a value keyed by the chat is contested between users (an OpenChat direct-chat key names only
  // the COUNTERPARTY, so it is shared by everyone who chats with that person). One global value is
  // the only thing every viewer resolves identically, so both members of a card see — and import —
  // the same code. Unset => "" => today's per-user deferral, unchanged.
  //
  // We land in that state both when the extraction omits a currency AND when it supplies one the
  // message never stated — the model guesses "USD" for a bare "Owe 300 uber", which otherwise sailed
  // straight past the default-currency logic and imported as USD for an EGP user. A currency the
  // message DID state is still honoured (see currencyStatedIn); the user can always pick one anyway.
  const claimed = typeof data.currency === "string" ? data.currency.trim() : "";
  const currency =
    claimed !== "" && currencyStatedIn(String(data.note ?? ""), claimed)
      ? claimed.toUpperCase()
      : seedCurrency.trim().toUpperCase(); // the app card currency, else "" (resolve at import)
  const direction: Direction = data.direction === "debt" ? "debt" : "credit";
  const note = typeof data.note === "string" ? data.note : "";
  const date = typeof data.date === "string" ? data.date : "";
  return { kind, amount, currency, direction, note, date, tags: [] };
}

/**
 * MULTI-mode fan-out. When the init `data` carries a non-empty `entries` array (the multi-entry
 * card), seed one editable form state per element using the SAME initToFormState logic the single
 * card uses — so each row prefills, defaults, and normalizes identically. Returns null for the
 * SINGLE path (absent / empty / non-array entries), which tells the page to render exactly today's
 * one-entry UI. Non-object elements are treated as an empty draft (defensive; parseInit already
 * filters them out on the wire).
 */
export function initEntries(data: CardInitData, seedCurrency = ""): CardFormState[] | null {
  const entries = data?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries.map((e) => initToFormState(isPlainObject(e) ? (e as EntryDraft) : {}, seedCurrency));
}

/**
 * Build the confirm payload from the edited form. Emits the EntryDraft shape
 * parseDraft accepts ({kind?, amount, currency, direction, date?, note}) plus a
 * demo `tags` array only when at least one is selected. `amount` is a JS number
 * when the field parses to a finite value, else the raw string (so downstream
 * validation surfaces a bad amount rather than silently coercing it).
 */
export function buildConfirmPayload(state: CardFormState): CardConfirmPayload {
  const trimmedAmount = state.amount.trim();
  const amountNum = Number(trimmedAmount);
  const amount: number | string =
    trimmedAmount !== "" && Number.isFinite(amountNum) ? amountNum : state.amount;

  const payload: CardConfirmPayload = {
    amount,
    direction: state.direction,
    note: state.note,
  };
  // Omit currency when the user left it on "Default" ("") so the REAL IOU app injects
  // prefs.defaultCurrency at import (baseWithDefaultCurrency). A picked currency is passed through.
  const currency = state.currency.trim().toUpperCase();
  if (currency !== "") payload.currency = currency;
  if (state.kind !== "") payload.kind = state.kind;
  if (state.date.trim() !== "") payload.date = state.date;
  if (state.tags.length > 0) payload.tags = state.tags;
  return payload;
}

/**
 * MULTI-mode confirm payload: the edited array of EntryDrafts, one element per row, each built with
 * the SAME buildConfirmPayload the single card uses. Handed back UNWRAPPED (a top-level array, not
 * `{ entries: [...] }`) — IOU's canister side (parseDraftBatch) imports the array element-by-element.
 */
export function buildMultiConfirmPayload(states: CardFormState[]): CardConfirmPayload[] {
  return states.map((s) => buildConfirmPayload(s));
}

// ── Outbound message builders (iframe → host) ────────────────────────────────
// Thin, so the page can't misspell a bridge type and tests can assert the wire.

export function buildReady(): { type: typeof CARD_MSG.ready } {
  return { type: CARD_MSG.ready };
}

export function buildResize(height: number): { type: typeof CARD_MSG.resize; height: number } {
  return { type: CARD_MSG.resize, height };
}

// Accepts a single EntryDraft (SINGLE mode) or an array of them (MULTI mode). The payload is passed
// through verbatim — the host distinguishes the two by whether payload is an array (parseDraftBatch
// handles both), so the same bridge type carries both shapes.
export function buildConfirm(
  payload: CardConfirmPayload | CardConfirmPayload[],
): { type: typeof CARD_MSG.confirm; payload: CardConfirmPayload | CardConfirmPayload[] } {
  return { type: CARD_MSG.confirm, payload };
}

export function buildCancel(): { type: typeof CARD_MSG.cancel } {
  return { type: CARD_MSG.cancel };
}
