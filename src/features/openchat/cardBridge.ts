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
import { isEncryptedTemplateRef } from "./templateRef";
import type { Direction } from "../entries/types";
import { IOU_CURRENCY_EVIDENCE_MAP } from "./actionManifest";
import { validatedSourceInterval } from "./sourceInterval";
export { dateFromSourceInterval } from "./sourceInterval";

// The bridge message type strings, both directions. Exactly the values in the
// build contract; kept in one table so page + tests can't drift.
export const CARD_MSG = {
  // host → iframe bootstrap (fresh for every iframe load)
  bootstrap: "oc:card:bootstrap",
  // iframe (app) → host
  ready: "oc:card:ready",
  privateContextReady: "oc:card:private-context-ready",
  privateContextStatus: "oc:card:private-context-status",
  resize: "oc:card:resize",
  confirm: "oc:card:confirm",
  confirmCollected: "oc:card:confirm-collected",
  cancel: "oc:card:cancel",
  // host → iframe (app)
  init: "oc:card:init",
  busy: "oc:card:busy",
  collectConfirm: "oc:card:collect-confirm",
  privateContextRequest: "oc:card:private-context-request",
} as const;

// The init protocol version this page speaks. parseInit rejects any other.
export const CARD_INIT_VERSION = 2 as const;
export const CARD_FRAME_NONCE_BYTES = 32;
export const CARD_RECIPIENT_KEY_SCHEME = "iou.vetkd.bls12-381.v1";
export const APP_SCOPED_CARD_CONTEXT_VERSION = 1 as const;

// Upper bound on how many entries a MULTI card will render. A real "several transactions in one
// message" extraction is a handful; this only exists so a hostile/oversized init can't ask the page to
// render hundreds of thousands of EntryRows and hang the frame. Excess entries are dropped.
export const MAX_CARD_ENTRIES = 100;

export type CardTheme = "light" | "dark";

export type AppScopedCardContextV1 = {
  contextVersion: typeof APP_SCOPED_CARD_CONTEXT_VERSION;
  appSubject: string;
  chatHandle: string;
  messageHandle: string;
  appId: number;
  appRevision: bigint;
  actionId: string;
};

export type CardPrivateContext = {
  capability: string;
  expiresAt: bigint;
  context: AppScopedCardContextV1;
};

// The normalized init context the page renders against. `data` is the extraction
// object (loose EntryDraft prefill); theme + readonly drive presentation.
export type CardInitContext = {
  appId: number;
  appRevision: bigint;
  actionId: string;
  theme: CardTheme;
  readonly: boolean;
  privateContext?: CardPrivateContext;
};

// The init `data` is EITHER a bare EntryDraft (SINGLE mode — the current, byte-identical behavior)
// OR an object carrying a non-empty `entries` array (MULTI mode — a batch of EntryDrafts rendered
// as N editable rows). `entries` is optional, so a single-entry card's data still satisfies this
// type. initEntries(data) is the sole detector: non-empty entries → MULTI, else → SINGLE.
export type CardInitData = EntryDraft & { entries?: EntryDraft[] };

export type CardInit = {
  frameNonce: string;
  data: CardInitData;
  context: CardInitContext;
};

// The editable form the page collects. Every public field is a plain string.
// `kind` is the public IOU/Settlement choice. A malformed legacy init can still produce "", but the
// form gate blocks collection until the user chooses a backend-valid value. `date` is a passthrough
// of the visible reviewed Date control.
export type CardFormState = {
  // Authoritative plain-text source, passed through without rendering or editing. It validates a
  // claimed text currency; OpenChat imports never derive Date from it. Image-only cards omit it.
  message?: string;
  kind: "iou" | "settlement" | "";
  // Selected account-scoped saved-Type id. It is populated only from the privately hydrated roster
  // for this card's exact linked sheet and exists only in iframe memory. Confirmation carries an
  // encrypted template_ref, never this id or its display name.
  templateId?: string;
  amount: string;
  currency: string;
  direction: Direction;
  note: string;
  date: string;
};

// The confirm payload handed back to the host: an EntryDraft, which IOU's parseDraft already accepts.
export type CardConfirmPayload = EntryDraft;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const U64_MAX = 18_446_744_073_709_551_615n;
const U32_MAX = 4_294_967_295;

function isCanonicalBase64Url(value: unknown, bytesLength: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const standard = value.replace(/-/g, "+").replace(/_/g, "/") + "=";
    const bytes = Uint8Array.from(atob(standard), (c) => c.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return bytes.length === bytesLength && canonical === value;
  } catch {
    return false;
  }
}

export function isCanonicalFrameNonce(value: unknown): value is string {
  return isCanonicalBase64Url(value, CARD_FRAME_NONCE_BYTES);
}

/** A UserIndex-issued app subject/chat/message handle: exactly 32 canonical bytes. */
export function isCanonicalAppScopedHandle(value: unknown): value is string {
  return isCanonicalBase64Url(value, 32);
}

export function parseBootstrap(msg: unknown): { frameNonce: string } | null {
  if (!isPlainObject(msg)) return null;
  if (msg.type !== CARD_MSG.bootstrap || msg.version !== CARD_INIT_VERSION) return null;
  return isCanonicalFrameNonce(msg.frameNonce) ? { frameNonce: msg.frameNonce } : null;
}

/** Exact target for iframe-to-parent messages after a trusted bootstrap. */
export function cardParentTargetOrigin(eventOrigin: string): string {
  return eventOrigin && eventOrigin !== "null" ? eventOrigin : "*";
}

const RAW_CORRELATION_FIELDS = [
  "userId",
  "user_id",
  "userIds",
  "chat",
  "chatKey",
  "chat_key",
  "messageId",
  "message_id",
  "threadRootMessageIndex",
  "thread_root_message_index",
  "confirmedBy",
  "confirmed_by",
] as const;

function hasRawCorrelationField(value: Record<string, unknown>): boolean {
  return RAW_CORRELATION_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function parseAppScopedContext(
  value: unknown,
  outer: Pick<CardInitContext, "appId" | "appRevision" | "actionId">,
): AppScopedCardContextV1 | null {
  if (!isPlainObject(value) || hasRawCorrelationField(value)) return null;
  if (
    value.contextVersion !== APP_SCOPED_CARD_CONTEXT_VERSION ||
    !isCanonicalAppScopedHandle(value.appSubject) ||
    !isCanonicalAppScopedHandle(value.chatHandle) ||
    !isCanonicalAppScopedHandle(value.messageHandle) ||
    typeof value.appId !== "number" ||
    !Number.isSafeInteger(value.appId) ||
    value.appId < 0 ||
    value.appId > U32_MAX ||
    typeof value.appRevision !== "bigint" ||
    value.appRevision < 0n ||
    value.appRevision > U64_MAX ||
    typeof value.actionId !== "string" ||
    value.actionId.length === 0 ||
    value.actionId.length > 128 ||
    value.appId !== outer.appId ||
    value.appRevision !== outer.appRevision ||
    value.actionId !== outer.actionId
  ) {
    return null;
  }
  return {
    contextVersion: APP_SCOPED_CARD_CONTEXT_VERSION,
    appSubject: value.appSubject,
    chatHandle: value.chatHandle,
    messageHandle: value.messageHandle,
    appId: value.appId,
    appRevision: value.appRevision,
    actionId: value.actionId,
  };
}

/**
 * Parse an inbound postMessage into a normalized CardInit, or null when it is
 * not a well-formed `oc:card:init` (wrong type, wrong/missing version, not an
 * object). Foreign frames (React devtools, webpack HMR, etc.) all fall through
 * to null so the page ignores them. `data` and `context` are defaulted, never
 * trusted verbatim.
 */
export function parseInit(msg: unknown, expectedFrameNonce: string): CardInit | null {
  if (!isPlainObject(msg)) return null;
  if (msg.type !== CARD_MSG.init) return null;
  if (msg.version !== CARD_INIT_VERSION) return null;
  if (!isCanonicalFrameNonce(expectedFrameNonce) || msg.frameNonce !== expectedFrameNonce) return null;

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

  if (!isPlainObject(msg.context)) return null;
  const ctxIn = msg.context;
  if (hasRawCorrelationField(ctxIn)) return null;
  if (
    typeof ctxIn.appId !== "number" ||
    !Number.isSafeInteger(ctxIn.appId) ||
    ctxIn.appId < 0 ||
    ctxIn.appId > U32_MAX ||
    typeof ctxIn.appRevision !== "bigint" ||
    ctxIn.appRevision < 0n ||
    ctxIn.appRevision > U64_MAX ||
    typeof ctxIn.actionId !== "string" ||
    ctxIn.actionId.length === 0 ||
    ctxIn.actionId.length > 128
  ) {
    return null;
  }
  const appCoordinates = {
    appId: ctxIn.appId,
    appRevision: ctxIn.appRevision,
    actionId: ctxIn.actionId,
  };
  let privateContext: CardPrivateContext | undefined;
  if (ctxIn.privateContext !== undefined) {
    if (!isPlainObject(ctxIn.privateContext) || hasRawCorrelationField(ctxIn.privateContext)) {
      return null;
    }
    const scopedContext = parseAppScopedContext(ctxIn.privateContext.context, appCoordinates);
    if (
      !isCanonicalFrameNonce(ctxIn.privateContext.capability) ||
      typeof ctxIn.privateContext.expiresAt !== "bigint" ||
      ctxIn.privateContext.expiresAt < 0n ||
      ctxIn.privateContext.expiresAt > U64_MAX ||
      !scopedContext
    ) {
      return null;
    }
    privateContext = {
      capability: ctxIn.privateContext.capability,
      expiresAt: ctxIn.privateContext.expiresAt,
      context: scopedContext,
    };
  }
  const context: CardInitContext = {
    appId: ctxIn.appId,
    appRevision: ctxIn.appRevision,
    actionId: ctxIn.actionId,
    theme: ctxIn.theme === "light" ? "light" : "dark",
    readonly: ctxIn.readonly === true,
    ...(privateContext ? { privateContext } : {}),
  };

  return { frameNonce: expectedFrameNonce, data, context };
}

// Parse an inbound `oc:card:busy` — the host's progress signal while a confirm/cancel round-trips
// (deposit + fan-out). Returns { busy } or null for anything else, so the page's one listener can try
// this alongside parseInit. Like parseInit it trusts only the SHAPE (a bare boolean), never any
// origin-carried data — the message conveys no secret and drives presentation only.
export function parseBusy(msg: unknown, expectedFrameNonce: string): { busy: boolean } | null {
  if (!isPlainObject(msg)) return null;
  if (msg.type !== CARD_MSG.busy) return null;
  if (msg.version !== CARD_INIT_VERSION || msg.frameNonce !== expectedFrameNonce) return null;
  if (typeof msg.busy !== "boolean") return null;
  return { busy: msg.busy };
}

export function parsePrivateContextRequest(msg: unknown, expectedFrameNonce: string): boolean {
  return (
    isPlainObject(msg) &&
    msg.type === CARD_MSG.privateContextRequest &&
    msg.version === CARD_INIT_VERSION &&
    msg.frameNonce === expectedFrameNonce
  );
}

// A payload may leave this iframe only in direct response to the host-owned confirmation button.
// The fresh request nonce is generated after that click and is single-use on the host; accepting an
// exact canonical nonce here keeps malformed or legacy unsolicited confirm messages out of the new
// collection path.
export function parseCollectConfirm(
  msg: unknown,
  expectedFrameNonce: string,
): { requestNonce: string } | null {
  if (!isPlainObject(msg)) return null;
  if (
    msg.type !== CARD_MSG.collectConfirm ||
    msg.version !== CARD_INIT_VERSION ||
    !isCanonicalFrameNonce(expectedFrameNonce) ||
    msg.frameNonce !== expectedFrameNonce ||
    !isCanonicalFrameNonce(msg.requestNonce)
  ) {
    return null;
  }
  return { requestNonce: msg.requestNonce };
}

/** Seed the editable form from the (loose, untrusted) extraction object. */
/**
 * Did the MESSAGE actually state this currency, or did the extraction model invent it?
 *
 * The model routinely emits a currency the message never mentions ("Owe 300 uber" -> USD), and the
 * prompt asking it to omit one is not binding on a small on-device model. We can check deterministically
 * because IOU's own `from_message` rule copies plain-text input into `message`. A currency counts as
 * stated when its ISO code appears as a WHOLE word (so "USD" does not
 * match inside a longer token) or when a symbol that maps to it appears.
 *
 * This check applies to authoritative plain-text evidence. Image-only inference deliberately has no
 * model-authored `message` echo; its schema-conformed currency stays visible for user review.
 */
export function currencyStatedIn(text: string, code: string): boolean {
  const c = code.trim().toUpperCase();
  if (c === "" || text.trim() === "") return false;
  const aliases = IOU_CURRENCY_EVIDENCE_MAP.find((entry) => entry.value === c)?.keywords ?? [];
  const folded = text.toLowerCase();
  const stated = (token: string) => {
    const candidate = token.toLowerCase();
    if (/[^\p{L}\p{N}\s]/u.test(candidate)) return folded.includes(candidate);
    return new RegExp(
      `(?:^|[^\\p{L}\\p{N}])${candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^\\p{L}\\p{N}]|$)`,
      "iu",
    ).test(text);
  };
  return stated(c) || aliases.some(stated);
}


export function initToFormState(data: EntryDraft, now: Date = new Date()): CardFormState {
  const kind = data.kind === "settlement" || data.kind === "iou" ? data.kind : "";
  const amount = data.amount != null ? String(data.amount) : "";
  // Empty ("") means the source did not provide trustworthy currency evidence. The credentialless
  // frame cannot read IOU browser storage, so it stays empty until the exact viewer's capability-bound
  // private context supplies that viewer's one account Default currency. This is deliberately not a
  // deployment/chat setting and never overwrites an explicit evidenced text/image currency.
  //
  // For plain text, OpenChat supplies the bounded exact-source prefix in `message`; a claimed
  // currency that excerpt did not state is a model guess and falls back to the exact viewer's Default
  // currency. Image-only inference intentionally omits `message`: the claimed currency came from the
  // pixels, remains editable, and
  // must stay visible rather than being silently replaced by an unrelated account default.
  const evidence =
    typeof data.message === "string" && data.message.trim() !== "" ? data.message : undefined;
  const claimed = typeof data.currency === "string" ? data.currency.trim() : "";
  const currency =
    claimed !== "" && (evidence === undefined || currencyStatedIn(evidence, claimed))
      ? claimed.toUpperCase()
      : "";
  const direction: Direction = data.direction === "debt" ? "debt" : "credit";
  const title = typeof data.note === "string" ? data.note : "";
  const interval = validatedSourceInterval(data.interval_start, data.interval_end, now);
  const range = interval !== undefined
    ? `From ${interval.start} to ${interval.end}`
    : undefined;
  const note = range === undefined || title === range || title.endsWith(` | ${range}`)
    ? title
    : title.trim() === "" ? range : `${title} | ${range}`;
  const explicitDate = typeof data.date === "string" ? data.date : "";
  const date = explicitDate.trim() !== ""
    ? explicitDate
    : interval?.date ?? "";
  // Carried only when the extraction actually routed to a type, so a card that never had one gains
  // no empty field (and buildConfirmPayload emits nothing new for it).
  return {
    ...(typeof data.message === "string" ? { message: data.message } : {}),
    kind,
    amount,
    currency,
    direction,
    note,
    date,
  };
}

/**
 * Fill a missing/untrusted currency from the exact viewer's one IOU account default, after the
 * capability-bound private context has been verified. Explicit evidenced card currency always wins.
 */
export function applyDefaultCurrency(
  state: CardFormState,
  defaultCurrency: string,
): CardFormState {
  const code = defaultCurrency.trim().toUpperCase();
  if (state.currency !== "" || !/^[A-Z]{3}$/.test(code)) return state;
  return { ...state, currency: code };
}

/**
 * MULTI-mode fan-out. When the init `data` carries a non-empty `entries` array (the multi-entry
 * card), seed one editable form state per element using the SAME initToFormState logic the single
 * card uses — so each row prefills, defaults, and normalizes identically. Returns null for the
 * SINGLE path (absent / empty / non-array entries), which tells the page to render exactly today's
 * one-entry UI. Non-object elements are treated as an empty draft (defensive; parseInit already
 * filters them out on the wire).
 */
export function initEntries(data: CardInitData): CardFormState[] | null {
  const entries = data?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  return entries.map((e) => initToFormState(isPlainObject(e) ? (e as EntryDraft) : {}));
}

/**
 * Build the confirm payload from the edited form. Emits the EntryDraft shape
 * parseDraft accepts ({kind?, amount, currency, direction, date?, note, message}).
 * `amount` is a JS number when the field parses to a finite value, else the raw
 * string (so downstream validation surfaces a bad amount rather than silently
 * coercing it).
 */
export function buildConfirmPayload(
  state: CardFormState,
  templateRef?: string,
): CardConfirmPayload {
  const trimmedAmount = state.amount.trim();
  const amountNum = Number(trimmedAmount);
  const amount: number | string =
    trimmedAmount !== "" && Number.isFinite(amountNum) ? amountNum : state.amount;

  const payload: CardConfirmPayload = {
    amount,
    direction: state.direction,
    note: state.note,
  };
  // Keep omission for legacy/unpaired payload compatibility. Current actionable cards hydrate the
  // viewer's one Default currency first and therefore emit a concrete code.
  const currency = state.currency.trim().toUpperCase();
  if (currency !== "") payload.currency = currency;
  // Preserve authoritative plain-text source context when present. OpenChat imports deliberately
  // resolve their date only from the reviewed Date field, never from this hidden text.
  if ((state.message ?? "").trim() !== "") payload.message = state.message;
  if (state.kind !== "") payload.kind = state.kind;
  // Return only the encrypted, row-bound saved-type reference. The plaintext id/name and roster
  // never enter OpenChat; IOU resolves the reference after the confirmed payload reaches the exact
  // linked sheet.
  if (isEncryptedTemplateRef(templateRef)) {
    payload.template_ref = templateRef;
  }
  const date = state.date.trim();
  if (date !== "") payload.date = date;
  return payload;
}

/**
 * MULTI-mode confirm payload: the edited array of EntryDrafts, one element per row, each built with
 * the SAME buildConfirmPayload the single card uses. Handed back UNWRAPPED (a top-level array, not
 * `{ entries: [...] }`) — IOU's canister side (parseDraftBatch) imports the array element-by-element.
 */
export function buildMultiConfirmPayload(
  states: CardFormState[],
  templateRefs: (string | undefined)[] = [],
): CardConfirmPayload[] {
  return states.map((s, index) => buildConfirmPayload(s, templateRefs[index]));
}

// ── Outbound message builders (iframe → host) ────────────────────────────────
// Thin, so the page can't misspell a bridge type and tests can assert the wire.

export function buildReady(frameNonce: string) {
  if (!isCanonicalFrameNonce(frameNonce)) throw new Error("invalid card frame nonce");
  return {
    type: CARD_MSG.ready,
    version: CARD_INIT_VERSION,
    frameNonce,
  } as const;
}

export function buildPrivateContextReady(frameNonce: string, recipientPublicKey: string) {
  if (!isCanonicalFrameNonce(frameNonce)) throw new Error("invalid card frame nonce");
  if (typeof recipientPublicKey !== "string" || !/^[A-Za-z0-9_-]{64}$/.test(recipientPublicKey)) {
    throw new Error("invalid card recipient public key");
  }
  return {
    type: CARD_MSG.privateContextReady,
    version: CARD_INIT_VERSION,
    frameNonce,
    privateContext: {
      recipientKeyScheme: CARD_RECIPIENT_KEY_SCHEME,
      recipientPublicKey,
    },
  } as const;
}

export function buildPrivateContextStatus(
  frameNonce: string,
  capability: string,
  status: "ready" | "error",
) {
  if (!isCanonicalFrameNonce(frameNonce) || !isCanonicalFrameNonce(capability)) {
    throw new Error("invalid private card context binding");
  }
  return {
    type: CARD_MSG.privateContextStatus,
    version: CARD_INIT_VERSION,
    frameNonce,
    capability,
    status,
  } as const;
}

export function buildResize(frameNonce: string, height: number) {
  return { type: CARD_MSG.resize, version: CARD_INIT_VERSION, frameNonce, height } as const;
}

// Accepts a single EntryDraft (SINGLE mode) or an array of them (MULTI mode). The payload is passed
// through verbatim — the host distinguishes the two by whether payload is an array (parseDraftBatch
// handles both), so the same bridge type carries both shapes.
export function buildConfirm(
  frameNonce: string,
  payload: CardConfirmPayload | CardConfirmPayload[],
) {
  return { type: CARD_MSG.confirm, version: CARD_INIT_VERSION, frameNonce, payload } as const;
}

export function buildCollectedConfirm(
  frameNonce: string,
  requestNonce: string,
  payload: CardConfirmPayload | CardConfirmPayload[],
) {
  if (!isCanonicalFrameNonce(frameNonce) || !isCanonicalFrameNonce(requestNonce)) {
    throw new Error("invalid card collection nonce");
  }
  return {
    type: CARD_MSG.confirmCollected,
    version: CARD_INIT_VERSION,
    frameNonce,
    requestNonce,
    payload,
  } as const;
}

export function buildCancel(frameNonce: string) {
  return { type: CARD_MSG.cancel, version: CARD_INIT_VERSION, frameNonce } as const;
}
