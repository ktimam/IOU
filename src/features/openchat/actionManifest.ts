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
    typeof viteEnv?.VITE_PUBLIC_ORIGIN === "string" ? viteEnv.VITE_PUBLIC_ORIGIN : undefined;
  const nodeEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  const fromNode = nodeEnv?.OC_APP_PUBLIC_ORIGIN;
  return (fromVite ?? fromNode ?? "http://127.0.0.1:3000").trim().replace(/\/+$/, "");
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
no prose, no code fences, and do not repeat the schema. When the message describes a SINGLE
transaction, respond with ONE JSON object. When it describes MULTIPLE distinct transactions,
respond with a JSON ARRAY of such objects, one object per transaction. One LINE can hold several
transactions: read every amount in the input and emit one object for EACH of them. Never merge two
amounts into one object, and never leave an amount out. Never repeat the same transaction twice.
One amount occurrence means exactly one object, not separate objects for both ledger perspectives
or for both possible kinds. Choose exactly one "kind" and one "direction" for each amount occurrence.
Each object may contain these fields:
- "kind": "iou" when the money is a future obligation (a reservation, a booking, rent, an
  instalment, or money owed to be paid later); "settlement" when the money has already moved
  (already paid, sent, transferred, or received).
- "amount": the amount in major currency units, as a JSON number (never a string).
- "currency": the 3-letter ISO currency code. OPTIONAL - omit it when the message states no
  currency; IOU then uses the user's default currency.
- "direction": "credit" when the amount is owed TO the user; "debt" when the user owes it.
- "date": the transaction or due date as YYYY-MM-DD. Infer the year from "Today is" below. For a
  date RANGE like "1-7 July" or "July 1-7", use the START date (for example 2026-07-01). For a
  relative date like "tomorrow" or "next Friday", resolve it against today.
- "note": a short description taken from the input.
- "message": for image input, copy the shortest exact visible text that contains the amount and
  currency when shown. Never paraphrase it. For plain-text input, OpenChat supplies the exact source.
Include a field only when the input supports it; omit any field you are unsure of. Never invent
an amount, a counterparty, or any other value that is not present in the input.`;

// The canister attester rounds major units to integer minor units. Half a minor unit is the exact
// smallest positive major-unit value that rounds to one; the maximum remains within JavaScript's
// exact integer range after multiplying by 100.
export const IOU_MIN_MAJOR_AMOUNT = 0.005;
export const IOU_MAX_MAJOR_AMOUNT = Number.MAX_SAFE_INTEGER / 100;

// Extraction rules registered alongside the prompt (OpenChat's generic rules engine executes
// them; the keywords/values here are IOU's data). "override" keyword_map + normalize run in the
// deterministic post-pass, so IOU's own type vocabulary and numeric forms like "26k" are policy,
// not inference.
export const IOU_EXTRACTION_RULES: AiActionRule[] = [
  {
    kind: "keyword_map",
    field: "kind",
    mode: "override",
    map: [
      {
        value: "iou",
        keywords: [
          "reservation",
          "booking",
          "rent",
          "due",
          "owed",
          "owes",
          // Bare present-tense "owe" — the most natural phrasing ("Owe 300 uber"). This was previously
          // omitted because keywords were matched as raw SUBSTRINGS, where "owe" fires on "power",
          // "shower" and "flower"; OpenChat now matches keywords on WORD BOUNDARIES, so it is safe and
          // a message that just says "owe …" finally gets a suggestion. The pronoun phrasings below
          // are now redundant for matching but kept: they are also read as the type vocabulary.
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
        keywords: ["paid", "sent", "transferred", "settled", "received"],
      },
    ],
  },
  // Stamp the raw message onto `message`, NOT `note`. OpenChat applies this rule to EVERY element of
  // a multi-transaction extraction with the same text, so pointing it at `note` gave all three rows of
  // "Owe me 300 uber 150 food / 500 movies" the whole message as their description. `note` is now left
  // as the model wrote it (per transaction); `message` is the evidence currencyStatedIn and extractTs
  // read. Still unconditional: the evidence must be present on every row, never on some of them.
  { kind: "from_message", field: "message", maxLength: 200 },
  { kind: "normalize", field: "amount", ops: ["k_m_suffix"] },
  { kind: "normalize", field: "currency", ops: ["uppercase", "trim"] },
  { kind: "instruction", text: "Amounts like '26k' mean 26000." },
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
    properties: {
      kind: { enum: ["settlement", "iou"] },
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
      },
      direction: { enum: ["credit", "debt"] },
      date: {
        type: "string",
        minLength: 10,
        maxLength: 10,
        format: "date",
      },
      note: { type: "string", maxLength: 4_096, format: "utf8-no-nul" },
      // Declared so conformToSchema keeps it — an undeclared key is dropped before the card is built.
      message: { type: "string", maxLength: 200, format: "utf8-no-nul" },
    },
    // Only `amount` is required — it can't be recovered if absent. `currency` is intentionally NOT
    // required: IOU fills a missing currency from the user's default (prefs.defaultCurrency) on
    // import (baseWithDefaultCurrency), so requiring it here would wrongly drop a no-currency message
    // at OpenChat's post-generation gate before IOU can default it.
    required: ["amount"],
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
      { key: "message", label: "Message" },
    ],
    directionLabels: {
      credit: "Owed to you",
      debt: "You owe",
    },
  },
  callback: { path: "/v1/openchat/drafts", auth: "openchat-provenance" },
  delivery: { mode: "action_inbox" },
  perUserKeys: true,
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
  ],
};

// ── Private template compatibility boundary ────────────────────────────────────────────────────
// Account types are private E2E data. OpenChat's manifest is public and user-global, so values
// accepted by these compatibility helpers are never serialized into the manifest.
// Matching happens locally after import against only the linked account.
export type ManifestTemplate = { id: string; name: string; keywords?: string[] };

/** Public rule set for registration; private account templates are deliberately ignored. */
export function buildIouRules(_templates: ManifestTemplate[]): AiActionRule[] {
  // Manifests are public and global to a user. Account template names and keywords are private.
  return [...IOU_EXTRACTION_RULES];
}

/** Public output schema; it contains no fields derived from private account templates. */
export function buildIouOutputSchema(_templates: ManifestTemplate[]): Record<string, unknown> {
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
