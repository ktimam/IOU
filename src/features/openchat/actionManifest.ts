// The IOU "AI-action" descriptor that IOU registers with OpenChat's generic
// app-integration hook. It declares WHAT to extract, the output schema (= the
// EntryDraft the IOU app already parses), the in-chat Confirm-card layout, and
// where to forward the confirmed draft. OpenChat runs its generic
// on-device-model + Confirm-card machinery against this config — nothing
// IOU-specific lives in OpenChat. See docs/chat-agent.md.

import type { Direction } from "../entries/types";

// --- Extraction rules (mirrors OpenChat's AiActionRule TS domain shape) -------------------------
// Generic vocabulary interpreted by OpenChat's rules engine; the IOU-specific keywords/values below
// are data in THIS manifest. "hint" rules only steer the prompt; "override" rules run in OpenChat's
// deterministic post-pass and beat the model's output.

export type AiActionRuleMode = "hint" | "override";

export type AiActionNormalizeOp =
  | "k_m_suffix"
  | "strip_symbols"
  | "uppercase"
  | "lowercase"
  | "trim";

export type AiActionRule =
  | {
      kind: "keyword_map";
      field: string;
      mode: AiActionRuleMode;
      map: { value: string; keywords: string[] }[];
    }
  | { kind: "from_message"; field: string; maxLength?: number }
  | { kind: "normalize"; field: string; ops: AiActionNormalizeOp[] }
  | { kind: "instruction"; text: string }
  | { kind: "context"; provide: "today"[] };

// --- App surfaces (mirrors OpenChat's AiAppSurface TS domain shape) -----------------------------
// A surface is a page of THIS app that OpenChat can open. Kinds OpenChat does not know are ignored.
// Surface URLs may contain only the public {appId} placeholder. App-scoped chat/message/user
// coordinates travel over authenticated canister calls or the private card bridge, never a URL.
// display: "sheet" = embedded in-app (iframe in a bottom sheet); "external" = opened in the system
// browser / new tab.

export type IouSurfaceDisplay = "sheet" | "external";

export type IouAppSurface = {
  kind: string;
  url: string;
  display: IouSurfaceDisplay;
};

/**
 * The public origin IOU's surface URLs are registered under. The URL must be absolute at
 * REGISTRATION time, and this module is shared by two very different callers, so resolution
 * checks both environments (never import.meta-only, never process-only):
 *   - Vite bundle (the in-app "Link to OpenChat" button): `VITE_PUBLIC_ORIGIN`, baked in at
 *     build time;
 *   - plain node (scripts/register-openchat-app.ts runs via tsx, where `import.meta.env` does
 *     not exist): `OC_APP_PUBLIC_ORIGIN`, read at registration time;
 *   - default: http://127.0.0.1:3000 — the dev server's own origin (vite.config sets
 *     host: "127.0.0.1", port: 3000). This MUST be the EXACT origin the user browses IOU on,
 *     scheme+host+port: the surface page reuses the user's already-signed-in session, and the
 *     browser stores that session (II delegation / dev identity) per-origin. "localhost" and
 *     "127.0.0.1" are DIFFERENT origins even on the same port, so the old localhost:3000 default
 *     silently failed — the page opened cross-origin from the signed-in tab, saw no session, and
 *     re-prompted as an empty (sheet-less) principal. Override with OC_APP_PUBLIC_ORIGIN /
 *     VITE_PUBLIC_ORIGIN for a real (asset-canister / prod) deployment.
 * `process` is reached via globalThis so the module stays browser-safe (no node types needed).
 */
export function resolvePublicOrigin(): string {
  const viteEnv = (import.meta as { env?: Record<string, unknown> }).env;
  const fromVite =
    typeof viteEnv?.VITE_PUBLIC_ORIGIN === "string"
      ? viteEnv.VITE_PUBLIC_ORIGIN
      : undefined;
  const nodeEnv = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  const fromNode = nodeEnv?.OC_APP_PUBLIC_ORIGIN;
  return (fromVite ?? fromNode ?? "http://127.0.0.1:3000")
    .trim()
    .replace(/\/+$/, "");
}

// The IOU app icon OpenChat's directory renders, inlined as a base64 data: URI (favicon.svg) so
// nothing is fetched cross-origin — no IP/timing leak to IOU's host, no CSP surprise.
export const IOU_ICON_DATA_URI =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPHJlY3QgeD0iMS41IiB5PSIxLjUiIHdpZHRoPSI2MSIgaGVpZ2h0PSI2MSIgcng9IjE1IiBmaWxsPSIjMTEyNjFGIiBzdHJva2U9IiM1RkUzQjMiIHN0cm9rZS13aWR0aD0iMiIvPgogIDxjaXJjbGUgY3g9IjMyIiBjeT0iMzAiIHI9IjE0IiBmaWxsPSJub25lIiBzdHJva2U9IiM1RkUzQjMiIHN0cm9rZS13aWR0aD0iNSIvPgogIDxjaXJjbGUgY3g9IjMyIiBjeT0iMjYuNSIgcj0iMy4zIiBmaWxsPSIjNUZFM0IzIi8+CiAgPHBhdGggZD0iTTMwIDI5IEwyOC41IDM3IEwzNS41IDM3IEwzNCAyOSBaIiBmaWxsPSIjNUZFM0IzIi8+Cjwvc3ZnPg==";

export type IouActionManifest = {
  id: string;
  version: string;
  title: string;
  // App icon shown in OpenChat's directory (a data: URI — see IOU_ICON_DATA_URI).
  iconUrl: string;
  trigger: { on: "image_message"; command?: string };
  prompt: string;
  // JSON-schema-ish description of the draft OpenChat must produce. Mirrors
  // src/features/entries/draft.ts `EntryDraft` (re-validated on the IOU side).
  outputSchema: Record<string, unknown>;
  // What the in-chat Confirm card shows. Direction is rendered in PLAIN language
  // so a human can catch an inversion before confirming.
  card: {
    fields: { key: string; label: string }[];
    directionLabels: Record<Direction, string>;
  };
  // Extraction rules OpenChat applies around the model run (prompt guidance + deterministic
  // post-pass). See AiActionRule above.
  rules: AiActionRule[];
  // Where OpenChat forwards the confirmed draft (the legacy IOU relay ingestion path).
  callback: { path: string; auth: "openchat-provenance" };
  // How a confirmed action is delivered. "action_inbox" = OpenChat encrypts the confirmed draft to the
  // consumer's registered recipient_public_key and deposits it on-chain (relay-free; the consumer reads +
  // decrypts it locally). "relay" = the legacy off-chain webhook above. The recipient_public_key is
  // per-device and supplied at registration, not in this static manifest (see ActionInboxSettings).
  delivery: { mode: "action_inbox" } | { mode: "relay" };
  // Multi-user delivery keys: when true, OpenChat delivers each user's confirmed actions
  // encrypted to THAT user's own registered key (paired once per user via a high-entropy claim token —
  // see ActionInboxSettings "Connect to OpenChat") instead of the single app-level key.
  perUserKeys: boolean;
  // Explicit app-authoritative fan-out: IOU resolves the exact routed shared account and returns
  // only opaque per-recipient delivery coordinates. Omitted/"confirmer" actions stay confirmer-only.
  recipientScope: "confirmer" | "app_authorized";
  // When true, OpenChat auto-proposes this action on IMAGE messages (its on-device vision model
  // extracts the receipt/photo). Maps to the action's `accepts_image` capability in the wire.
  acceptsImage: boolean;
  // Pages of this app OpenChat can open (see IouAppSurface above). Registered alongside the
  // actions; OpenChat treats a missing list as empty.
  surfaces: IouAppSurface[];
};

// Extraction prompt for text-or-image input. Deliberately free of example VALUES (a small
// on-device model can echo literals from the prompt into its answer); it names every field and
// states the semantics instead.
export const IOU_EXTRACTION_PROMPT = `You are extracting money transactions for a 2-person shared
ledger. The input is a chat message: plain text, an image (for example a receipt, a bank transfer
screenshot, or a booking confirmation), or both. Respond with ONLY compact JSON and nothing else -
no prose, no code fences, and do not repeat the schema.

CARDINALITY — APPLY THIS BEFORE CLASSIFICATION:
1. Count distinct ledger transactions, not every printed number. Dates, times, IDs, quantities,
   percentages, and exchange rates are not transaction amounts. A transaction amount is an amount
   attached to a distinct item, charge, payment, or obligation. Headings, labels, parties, and the two
   ledger perspectives are not additional transactions. For one receipt or payment, line-item prices,
   subtotal, tax, tip, cash tendered, change, running balance, and repeated displays of its total are
   not separate transactions unless the source explicitly describes a separate charge to record.
2. Exactly one distinct transaction amount is a SINGLE transaction and means exactly ONE JSON
   object, never an array. One amount occurrence means exactly one object. Never create separate
   debtor and creditor views, separate kinds, or duplicate objects for that one transaction.
3. Two or more distinct transaction amounts are MULTIPLE transactions and mean a JSON ARRAY with
   exactly one object per transaction, in reading order. One LINE can hold several transactions:
   emit one object for EACH distinct transaction amount. Never merge two amounts that belong to
   distinct transactions, never leave an amount out when it belongs to a distinct transaction, and
   never emit the same transaction twice. Never repeat the same transaction twice. Equal amounts
   tied to distinct transaction descriptions are separate transactions; a repeated display of the
   same transaction is not.

Each object may contain these fields:
- "kind": "iou" when the money is a future obligation (a reservation, a booking, rent, an
  instalment, or money owed to be paid later); "settlement" when the money has already moved
  (already paid, sent, transferred, or received).
- "amount": the amount in major currency units, as a JSON number (never a string).
- "currency": the 3-letter ISO currency code. OPTIONAL - omit it when the message states no
  currency; IOU then uses the user's default currency.
- "direction": phrases such as "owed to you", "you are owed", "you owe me", "due to you", or
  "payable to you" mean "credit". Phrases such as "I owe", "we owe", "owed by you", "due from
  you", or "payable by you" mean "debt". Output the literal JSON value "credit" or "debt"; never
  copy a source phrase into "direction". The bare shorthand "owe 200 uber" means "debt" unless a
  more specific phrase such as "owe me" says the other person owes the sender.
  Keep the source's viewpoint; do not invert it.
- "date": the transaction or due date as YYYY-MM-DD, but only when the source itself contains a
  date or an explicit relative-date phrase. A host calendar anchor, when supplied for text input,
  is reference context only for resolving relative phrases. Never output today's date unless the
  source itself says "today". If there are no visible date digits or date words in the source, omit
  "date". For a date range, use the start date. For image input, inspect Date, Transaction date,
  Booking date, and Due date labels. Put the visibly printed year first, the visible month second,
  and the visible day last; ignore the time. Do not copy or blend any date from these instructions.
- "note": a short description taken from the input.
- When an image has attached chat text, use that exact text as "note". It is the user's intentional
  description and takes precedence over a Note/Description/Memo row read from the image. Without
  attached text, prefer an explicitly labelled image note over a nearby heading.
- "message": OpenChat supplies a bounded exact-source prefix for plain-text input. For image input,
  when an exact visible relationship phrase determines direction, copy ONLY that phrase here as
  transient direction evidence. Do not copy a title, merchant, description, or other image text.
  Omit "message" when no such phrase is visible; OpenChat removes this transient image value before
  building the card or payload.
Include a field only when the input supports it; omit any field you are unsure of. Never invent
an amount, a counterparty, or any other value that is not present in the input.

FINAL COUNT CHECK: the number of output objects MUST equal the number of distinct transactions.
One transaction means one object, not an array. For one distinct transaction amount, the first
non-whitespace output character MUST be { and the last non-whitespace output character MUST be }.
Do not wrap that object in []. Each object must choose exactly one "kind" and one "direction".`;

// Phone-class WebGPU is most reliable when the small VLM has one bounded attention job per pass.
// OpenChat's v2 image prompt pipeline projects each pass onto only its declared fields, so this core
// pass cannot invent a date/note/direction and the lower-detail pass cannot alter the amount. Both
// passes use the selected vision model directly; no OCR or text-reader output participates.
export const IOU_IMAGE_EXTRACTION_PROMPT = `Read the financial document. Return ONLY one JSON object, or a reading-order JSON array for separate transactions. Each object may use only "amount", "currency", and "kind".

Use the single authoritative paid, transferred, total, or amount-due value once per transaction; preserve decimals and standard k-thousands. Ignore balances, IDs, accounts, references, dates, times, quantities, percentages, exchange rates, line-item arithmetic, repeated totals, parties, and descriptions. Currency is the exact visible three-letter ISO code beside that amount; compare all three printed letters before answering. The only permitted "kind" values are "settlement" for money visibly completed moving or a payment/transfer visibly succeeded, and "iou" for future, due, owed, requested, reserved, booked, or unpaid money. Output one of those exact strings; never copy a document label such as total, status, or amount-due as "kind". A receipt or total alone is not proof of payment. Omit uncertainty; invent nothing.`;

// Keep calendar conversion out of the VLM. A phone-sized model is substantially more reliable at
// copying the visible day/month-name/year than at both reading and reordering those components in
// one generation. The opted-in schema normalizer below performs the deterministic English-month to
// ISO conversion after inference; an already-ISO source remains valid unchanged.
export const IOU_IMAGE_DATE_EXTRACTION_PROMPT = `Read only visibly printed values beside an explicit Date, Transaction date, Payment date, Booking date, Due date, Note, Description, or Memo label in this image detail. Return ONLY one JSON object using only "date" and "note", or a reading-order JSON array for separate transactions.

For "date", transcribe the complete visible date instead of performing a calendar conversion. For an English month name, copy the visible day, month word, and four-digit year in printed order with single spaces; omit the time. If a month word is printed, retain that same word and never output month digits in its place. Read all four year digits from their printed shapes, especially the final digit; never substitute a familiar or likely year. Do not translate the month or reorder components. Copy an already strict YYYY-MM-DD date unchanged. Any other numeric-only date order is ambiguous, so omit "date". Before responding, compare every copied date token to the image.

For "note", prefer the value visibly beside an explicit Note, Description, or Memo label. If none exists, copy only the short transaction or item description directly attached to the authoritative amount. Never use a sender, receiver, From, To, account, reference, total, amount-due label, status, filename, metadata, or text from these instructions as the note. A footer instruction to keep or retain the receipt is not a note. Omit either field when its supported value is not visible. Never infer, substitute, or blend values.`;

// The canister attester rounds major units to integer minor units. Half a minor unit is the exact
// smallest positive major-unit value that rounds to one; the maximum remains within JavaScript's
// exact integer range after multiplying by 100.
export const IOU_MIN_MAJOR_AMOUNT = 0.005;
export const IOU_MAX_MAJOR_AMOUNT = Number.MAX_SAFE_INTEGER / 100;

// Optional plain-text evidence vocabulary for currencies whose normalized ISO value may differ
// from the literal source token. OpenChat uses this only because the currency schema opts into the
// generic text-evidence policy; image-only extraction is unaffected.
export const IOU_CURRENCY_EVIDENCE_MAP: {
  value: string;
  keywords: string[];
}[] = [
  {
    value: "USD",
    keywords: ["$", "dollar", "dollars", "US dollar", "US dollars"],
  },
  { value: "GBP", keywords: ["£", "pound sterling", "pounds sterling"] },
  { value: "EUR", keywords: ["€", "euro", "euros"] },
  { value: "JPY", keywords: ["¥", "yen"] },
  { value: "INR", keywords: ["₹", "rupee", "rupees"] },
  {
    value: "EGP",
    // Tesseract reads the large `EGP` glyph on verified InstaPay receipts as exact `cp`, `ecp`, or
    // `tcp`. OpenChat accepts these app-declared tokens only for OCR, immediately beside one amount,
    // and only when this single target owns them; typed messages never use these aliases.
    keywords: [
      "E£",
      "Egyptian pound",
      "Egyptian pounds",
      "ج.م",
      "cp",
      "ecp",
      "tcp",
    ],
  },
];

// Extraction rules registered alongside the prompt (OpenChat's generic rules engine executes
// them; the keywords/values here are IOU's data). "override" keyword_map + normalize run in the
// deterministic post-pass, so IOU's neutral transaction-intent vocabulary and numeric forms like
// "26k" are policy, not inference. Saved-type names/keywords are private account data and must
// never appear here merely to make that type trigger a proposal.
export const IOU_EXTRACTION_RULES: AiActionRule[] = [
  {
    kind: "keyword_map",
    field: "kind",
    mode: "override",
    map: [
      {
        value: "iou",
        keywords: [
          "due",
          "owed",
          "owes",
          // Bare present-tense "owe" — the most natural phrasing ("Owe 300 uber"). This was previously
          // omitted because keywords were matched as raw SUBSTRINGS, where "owe" fires on "power",
          // "shower" and "flower"; OpenChat now matches keywords on WORD BOUNDARIES, so it is safe and
          // a message that just says "owe …" finally gets a suggestion. The pronoun phrasings below
          // are redundant for matching but remain explicit, neutral ledger-intent cues.
          "owe",
          "i owe",
          "you owe",
          "we owe",
          "they owe",
          "owe me",
          "owe you",
          "owe him",
          "owe her",
          "owe them",
          "instalment",
          "installment",
        ],
      },
      {
        value: "settlement",
        keywords: [
          "paid",
          "sent",
          "transferred",
          "settled",
          "received",
          // Bounded completion phrases visible on bank/payment confirmations. Avoid a bare
          // "successful" keyword: a successful reservation is not proof that money moved.
          "transaction successful",
          "transaction was successful",
          "payment successful",
          "payment was successful",
          "transfer successful",
          "transfer was successful",
          // Exact completion phrases shown by Arabic payment apps. Keep these as full phrases:
          // bare `بنجاح`/`ناجح` can describe a reservation or another non-payment event.
          // Tesseract's isolated Arabic+English semantic pass preserves the exact completed-operation
          // prefix even when the final success word is damaged; neither bare constituent is accepted.
          "تمت العملية",
          "تمت العملية بنجاح",
          "تمت المعاملة بنجاح",
          "تم التحويل بنجاح",
          "تم الدفع بنجاح",
        ],
      },
    ],
  },
  {
    kind: "keyword_map",
    field: "direction",
    mode: "override",
    map: [
      {
        value: "credit",
        keywords: [
          "owed to you",
          "you are owed",
          "due to you",
          "payable to you",
          "you owe",
          "owe me",
          "owes me",
        ],
      },
      {
        value: "debt",
        keywords: [
          "i owe",
          "we owe",
          "owe you",
          "owe him",
          "owe her",
          "owe them",
          "owed by you",
          "due from you",
          "payable by you",
          "owe",
        ],
      },
    ],
  },
  {
    kind: "keyword_map",
    field: "currency",
    mode: "hint",
    map: IOU_CURRENCY_EVIDENCE_MAP,
  },
  // Stamp plain-text input onto `message`, NOT `note`. OpenChat applies this rule to EVERY element of
  // a multi-transaction extraction with the same text, so pointing it at `note` gave all three rows of
  // "Owe me 300 uber 150 food / 500 movies" the whole message as their description. `note` is now left
  // as the model wrote it (per transaction); `message` remains optional for image-only input because
  // the image itself is the source and a model-authored text echo adds no trustworthy evidence.
  { kind: "from_message", field: "message", maxLength: 200 },
  { kind: "normalize", field: "amount", ops: ["k_m_suffix"] },
  { kind: "normalize", field: "currency", ops: ["uppercase", "trim"] },
  // OpenChat appends the calendar anchor only for opted-in text input. Image-only inference never
  // receives host date text, so a vision model cannot mistake it for visible receipt evidence.
  { kind: "context", provide: ["today"] },
  { kind: "instruction", text: "Amounts like '26k' mean 26000." },
  {
    kind: "instruction",
    text: 'FINAL FORMAT CHECK: map visible phrases like "YOU OWE ME" to exactly "direction":"credit" and "I OWE YOU" to exactly "direction":"debt"; bare shorthand like "OWE 200 UBER" means "debt"; never use the phrase itself as the direction value. For image input, copy only the exact visible relationship phrase into "message" as transient evidence, never a title or description. Any host calendar anchor is reference only: for a source date range use its start and its missing year only; remove "date" unless the source visibly states a date or relative-date phrase. One transaction must be one object, never an array.',
  },
];

export const iouActionManifest: IouActionManifest = {
  id: "iou.entry.import",
  version: "1",
  title: "Add to IOU",
  iconUrl: IOU_ICON_DATA_URI,
  trigger: { on: "image_message", command: "iou" },
  prompt: IOU_EXTRACTION_PROMPT,
  outputSchema: {
    type: "object",
    // Each selected-model pass owns disjoint fields. OpenChat discards undeclared keys before it
    // merges the results, then applies the ordinary rules/schema/defaults/required checks.
    "x-openchat-image-prompt-template": {
      version: 1,
      template: IOU_IMAGE_EXTRACTION_PROMPT,
      includeRuleGuidance: false,
    },
    // Additive to the v1 compact prompt above: older OpenChat clients still get the stable compact
    // core extraction, while clients that understand focused passes also read the date separately.
    "x-openchat-image-focused-passes": {
      version: 2,
      primaryFields: ["amount", "currency", "kind"],
      primaryMaxTokens: 64,
      passes: [
        {
          template: IOU_IMAGE_DATE_EXTRACTION_PROMPT,
          fields: ["date", "note"],
          includeRuleGuidance: false,
          includeMessage: false,
          maxTokens: 48,
          imageRegion: "lower_half",
        },
      ],
    },
    // Invocation order belongs to the app manifest. In a browser, try the user's selected image
    // model only after OpenChat proves it has a usable accelerated path; unavailable, failed, empty,
    // or incomplete model output falls back to the bounded source-grounded reader declared below.
    // This policy is model- and language-agnostic. Typed text keeps its deterministic parser path.
    "x-openchat-browser-image-strategy": {
      version: 1,
      primary: "selected_model",
      requireAcceleration: true,
      fallback: "source_grounded",
    },
    // Opt into OpenChat's generic, deterministic source-grounded transaction parser. Typed input
    // goes straight through this parser; image input reaches it as the bounded fallback above. The
    // parser reads enum/default/date policy from ordinary property schemas and keyword semantics
    // from `rules`; these options only map fields and declare bounded document labels. It fails
    // closed on conflicting totals, currencies, relationship phrases, or dates.
    "x-openchat-source-grounded-transactions": {
      version: 1,
      amountField: "amount",
      currencyField: "currency",
      kindField: "kind",
      directionField: "direction",
      dateField: "date",
      noteField: "note",
      sourceField: "message",
      // Typed monetary source without an explicit paid/sent/received cue is an obligation in IOU.
      // OCR must provide explicit kind evidence below, so this fallback cannot relabel a model's
      // partial settlement as an IOU merely because the secondary reader saw only an amount.
      fallbackKind: "iou",
      // A bank/receipt image often names both parties without identifying the chat author's side.
      // Start its editable card at "you owe me"; an exact visible relationship phrase still wins.
      // This is OCR-only: typed text continues to use the ordinary direction property default.
      ocrDefaultDirection: "credit",
      // A source-grounded fallback may complement a failed model only when it actually observed the
      // transaction kind. This is a mapped field name, not language- or app-specific host logic.
      requireOcrEvidenceFields: ["kind"],
      maximumItems: 16,
      authoritativeAmountLabels: ["amount due", "total", "transfer amount"],
      dateLabels: ["due date", "date"],
      noteLabels: ["note", "description", "memo"],
      ignoredLineLabels: ["reference"],
      titleLineKeywords: [
        "receipt",
        "request",
        "transaction successful",
        "transaction was successful",
        "powered by",
      ],
      relationshipLabelPrefixes: ["status", "direction"],
    },
    // Explicitly opt plain-text multi-entry shorthand into OpenChat's bounded, source-only
    // amount/label parser. IOU's declared rules/defaults still supply and validate semantics.
    "x-openchat-text-sequence": {
      numberField: "amount",
      labelField: "note",
      minimumItems: 2,
      // These complete command phrases continue to authorize shorthand embedded after an anchor.
      anchors: ["owe me", "owe"],
      // Also accept an unanchored sequence only when the ENTIRE message is a strictly alternating
      // amount/short-label list. OpenChat rejects prose, identifiers and unmatched numeric text.
      unanchoredMode: "whole_message",
      // An anchor-free amount/label list is otherwise indistinguishable from a quantity list. Keep
      // this public app policy deliberately closed; anchored shorthand remains free-form.
      unanchoredLabels: ["food", "uber", "shopping"],
    },
    // A fully explicit `label amount ISO; ...` list is safer and faster to read from source than to
    // ask a small model to preserve its cardinality. OpenChat accepts it only when every segment
    // matches the bounded declarative grammar; otherwise normal model inference remains in charge.
    "x-openchat-delimited-text-sequence": {
      delimiter: "semicolon",
      numberField: "amount",
      labelField: "note",
      currencyField: "currency",
      minimumItems: 2,
    },
    properties: {
      // Deterministic shorthand has no model-authored classification. The app therefore declares
      // its neutral obligation default; explicit settlement keyword rules continue to override it.
      kind: {
        type: "string",
        enum: ["settlement", "iou"],
        default: "iou",
        // Real Qwen3-VL evidence showed a complete receipt candidate whose target `kind` field was
        // the short settlement label paid/payment/transfer rather than the canonical enum token.
        // OpenChat matches these as whole target-field values only; it never scans note/message.
        "x-openchat-enum-aliases": {
          settlement: ["paid", "payment", "transfer"],
        },
        // Text shorthand keeps the neutral IOU default, but an image model must explicitly classify
        // the transaction. A missing/invalid image kind stays missing so the bounded fallback runs.
        "x-openchat-require-explicit-for-image-only": true,
      },
      // number ONLY: string amounts like "26k" are handled by the k_m_suffix normalize rule
      // before schema conformance, so anything still non-numeric here is dropped, not forwarded.
      // minimum mirrors the attester's round-to-minor boundary, so positive values that still round
      // to zero are dropped before provenance instead of producing an app-rejected card.
      amount: {
        type: "number",
        minimum: IOU_MIN_MAJOR_AMOUNT,
        maximum: IOU_MAX_MAJOR_AMOUNT,
      },
      // OpenChat deliberately rejects JSON Schema `pattern`: app-supplied regex execution is
      // unbounded. These bounded declarative constraints are deterministic; IOU's authenticated
      // attester remains authoritative.
      currency: {
        type: "string",
        minLength: 3,
        maxLength: 3,
        format: "ascii-uppercase",
        "x-openchat-require-text-evidence": true,
      },
      // Ambiguous two-person shorthand has no author-relative direction evidence. Keep direction
      // required, but provide a visible editable debt fallback instead of discarding the action.
      // For image input only, the user's preferred editable fallback is "you owe me" (credit).
      // OpenChat applies it only when the field remains truly absent after aliases and rules, so an
      // explicit/conflicting model value still wins or fails closed. Typed text keeps the ordinary
      // debt fallback below.
      direction: {
        type: "string",
        enum: ["credit", "debt"],
        default: "debt",
        "x-openchat-default-for-image-only": "credit",
      },
      date: {
        type: "string",
        minLength: 10,
        maxLength: 10,
        format: "date",
        // The focused VLM copies a visible English named-month date rather than converting it.
        // OpenChat normalizes that unambiguous source form before enforcing these canonical
        // ten-character bounds; numeric-only non-ISO dates remain invalid and fail closed.
        "x-openchat-normalize-date": true,
        // For one text transaction, prefer an unambiguous date in the authoritative source over a
        // small model copying the nearby host calendar anchor. Ranges resolve to their start.
        "x-openchat-date-from-text": true,
        // Vision models often use the visible label as the JSON key. OpenChat resolves this alias
        // before date normalization and drops it on any conflicting target/alias values.
        "x-openchat-property-aliases": ["due_date"],
      },
      note: { type: "string", maxLength: 4_096, format: "utf8-no-nul" },
      // Declared so conformToSchema keeps it — an undeclared key is dropped before the card is built.
      message: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        format: "utf8-no-nul",
        "x-openchat-omit-for-image-only": true,
      },
    },
    // Amount and kind define the ledger semantics and still fail closed when absent. Direction
    // remains required after applying the declared, visible editable fallback above. Currency stays
    // optional because IOU fills it from the exact viewer's one account default in private card
    // context (and again at import for legacy payloads). `message` is optional too: OpenChat supplies
    // authoritative text input itself, while a vision model's text echo is not proof of what an image
    // contains.
    required: ["amount", "kind", "direction"],
  },
  rules: IOU_EXTRACTION_RULES,
  card: {
    fields: [
      { key: "amount", label: "Amount" },
      { key: "currency", label: "Currency" },
      // Public closed enum only ("iou" | "settlement"). This is deliberately
      // distinct from a private saved account type such as "Rent".
      { key: "kind", label: "Type" },
      { key: "direction", label: "Direction" },
      { key: "date", label: "Date" },
      { key: "note", label: "Note" },
    ],
    directionLabels: {
      credit: "Owed to you",
      debt: "You owe",
    },
  },
  callback: { path: "/v1/openchat/drafts", auth: "openchat-provenance" },
  delivery: { mode: "action_inbox" },
  perUserKeys: true,
  recipientScope: "app_authorized",
  // IOU extracts from receipt images, so opt into OpenChat's auto-propose-on-image chip.
  acceptsImage: true,
  // Surfaces: pages of IOU that OpenChat can open on our behalf. display: "external" opens them as
  // a FIRST-PARTY tab in the OS browser — an embedded iframe would get storage-partitioned by the
  // OpenChat host origin (WebView2/modern browsers partition third-party frame storage), so it
  // could not see this user's IOU session or sheets. The origin is fixed at registration time
  // (see resolvePublicOrigin).
  surfaces: [
    // "connect": the pairing-code entry page — OpenChat's consent sheet offers it as a one-tap
    // "open the right page" shortcut next to the claim token. The #openchat-connect hash scrolls
    // to (and focuses) the code input in ActionInboxSettings.
    {
      kind: "connect",
      url: `${resolvePublicOrigin()}/settings#openchat-connect`,
      display: "external",
    },
    // "chat_link": each invocation receives a different one-time opaque token. It is neither a
    // chat coordinate nor a stable handle: IOU immediately scrubs it from the browser URL, then
    // its canister redeems it through the pinned UserIndex using the signed-in caller's exact
    // app-subject binding. This is what lets several chats independently choose different sheets.
    {
      kind: "chat_link",
      url: `${resolvePublicOrigin()}/settings#openchat-routing/{chatLinkToken}`,
      display: "external",
    },
    // "home": the app's own webpage, offered from OpenChat's app-directory detail sheet.
    // display: "sheet" embeds it INSIDE the OpenChat window (its iframe host). Note the embedded
    // copy is storage-partitioned by the OpenChat origin, so it shows the signed-OUT landing
    // state — fine for a look around; the host's "Open in browser" escape hatch reaches the full
    // signed-in app.
    {
      kind: "home",
      url: resolvePublicOrigin(),
      display: "sheet",
    },
    // "card": IOU's OWN app-rendered confirmable card (see fork-notes/08-app-rendered-cards.md).
    // OpenChat looks the app up by the card's actionId, finds this surface, and embeds
    // /openchat/card in the chat bubble instead of drawing its own rows. display: "sheet" =
    // embedded iframe. The page has no IOU browser session. A private roster is
    // released only through a viewer/card/recipient-key-bound capability, and
    // the selected type returns as an encrypted reference. If absent, OpenChat
    // uses its generic built-in card renderer.
    {
      kind: "card",
      url: `${resolvePublicOrigin()}/openchat/card`,
      display: "sheet",
    },
    // "private_match": an invisible, credentialless matcher frame. OpenChat sends one exact NEW
    // message only after separate per-chat user consent and a fresh transport-key-bound capability.
    // The frame decrypts only the linked sheet's roster and returns a boolean; no Saved-type
    // name/id/keyword/count is registered or posted back to OpenChat.
    {
      kind: "private_match",
      url: `${resolvePublicOrigin()}/openchat/private-match`,
      display: "sheet",
    },
  ],
};

// ── Private template compatibility boundary ────────────────────────────────────────────────────
// Account types are private E2E data. OpenChat's manifest is public and user-global, so values
// accepted by these compatibility helpers are never serialized into the manifest.
// Matching happens privately against only the account linked to that chat. With an explicit
// durable chat-to-sheet link, an isolated matcher may use those encrypted values to
// suggest IOU; this public manifest still cannot see or publish them.
export type ManifestTemplate = {
  id: string;
  name: string;
  keywords?: string[];
};

/** Public rule set for registration; private account templates are deliberately ignored. */
export function buildIouRules(_templates: ManifestTemplate[]): AiActionRule[] {
  // Manifests are public and global to a user. Account template names and keywords are private.
  return [...IOU_EXTRACTION_RULES];
}

/** Public output schema; it contains no fields derived from private account templates. */
export function buildIouOutputSchema(
  _templates: ManifestTemplate[],
): Record<string, unknown> {
  const schema = JSON.parse(JSON.stringify(iouActionManifest.outputSchema)) as {
    properties: Record<string, unknown>;
    [k: string]: unknown;
  };
  return schema;
}

/** Serialize the manifest for registration with OpenChat's integration hook. */
export function renderManifestJson(): string {
  return JSON.stringify(iouActionManifest, null, 2);
}
