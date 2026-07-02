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
// A surface is a page of THIS app that OpenChat can open. kind = "chat_link" is the one OpenChat
// knows today: it opens the page after the first confirmed action in a chat so the user can link
// that chat inside the app; kinds OpenChat does not know are ignored. The URL may carry
// placeholders OpenChat substitutes before opening: {chatKey} (the canonical chat key, same
// format as the delivery provenance: "group:<principal>" / "channel:<principal>:<id>") and
// {appId}. display: "sheet" = embedded in-app (iframe in a bottom sheet); "external" = opened in
// the system browser / new tab.

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

export type IouActionManifest = {
  id: string;
  version: string;
  title: string;
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
  // encrypted to THAT user's own registered key (paired once per user via a 6-digit link code —
  // see ActionInboxSettings "Connect to OpenChat") instead of the single app-level key.
  perUserKeys: boolean;
  // Pages of this app OpenChat can open (see IouAppSurface above). Registered alongside the
  // actions; OpenChat treats a missing list as empty.
  surfaces: IouAppSurface[];
};

// Extraction prompt for text-or-image input. Deliberately free of example VALUES (a small
// on-device model can echo literals from the prompt into its answer); it names every field and
// states the semantics instead.
export const IOU_EXTRACTION_PROMPT = `You are extracting a single money transaction for a 2-person
shared ledger. The input is a chat message: plain text, an image (for example a receipt, a bank
transfer screenshot, or a booking confirmation), or both. Respond with ONLY one compact JSON
object and nothing else - no prose, no code fences, and do not repeat the schema.
The object may contain these fields:
- "kind": "iou" when the money is a future obligation (a reservation, a booking, rent, an
  instalment, or money owed to be paid later); "settlement" when the money has already moved
  (already paid, sent, transferred, or received).
- "amount": the amount in major currency units, as a JSON number (never a string).
- "currency": the 3-letter ISO currency code.
- "direction": "credit" when the amount is owed TO the user; "debt" when the user owes it.
- "date": the transaction or due date, formatted YYYY-MM-DD.
- "note": a short description taken from the input.
Include a field only when the input supports it; omit any field you are unsure of. Never invent
an amount, a counterparty, or any other value that is not present in the input.`;

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
  { kind: "from_message", field: "note", maxLength: 200 },
  { kind: "normalize", field: "amount", ops: ["k_m_suffix"] },
  { kind: "normalize", field: "currency", ops: ["uppercase", "trim"] },
  { kind: "instruction", text: "Amounts like '26k' mean 26000." },
];

export const iouActionManifest: IouActionManifest = {
  id: "iou.entry.import",
  version: "1",
  title: "Add to IOU",
  trigger: { on: "image_message", command: "iou" },
  prompt: IOU_EXTRACTION_PROMPT,
  outputSchema: {
    type: "object",
    properties: {
      kind: { enum: ["settlement", "iou"] },
      // number ONLY: string amounts like "26k" are handled by the k_m_suffix normalize rule
      // before schema conformance, so anything still non-numeric here is dropped, not forwarded.
      amount: { type: "number" },
      currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      direction: { enum: ["credit", "debt"] },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      note: { type: "string" },
    },
    required: ["amount", "currency"],
  },
  rules: IOU_EXTRACTION_RULES,
  card: {
    fields: [
      { key: "amount", label: "Amount" },
      { key: "currency", label: "Currency" },
      { key: "direction", label: "Direction" },
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
  // Surfaces: pages of IOU that OpenChat can open on our behalf. display: "external" opens them as
  // a FIRST-PARTY tab in the OS browser — an embedded iframe would get storage-partitioned by the
  // OpenChat host origin (WebView2/modern browsers partition third-party frame storage), so it
  // could not see this user's IOU session or sheets. The origin is fixed at registration time
  // (see resolvePublicOrigin).
  surfaces: [
    // "chat_link": opened after the first confirmed action in a chat (and from the chat's Apps
    // settings) so the user can pick which sheet that chat's drafts land in. {chatKey} is
    // substituted by OpenChat.
    {
      kind: "chat_link",
      url: `${resolvePublicOrigin()}/openchat/link-chat?chat={chatKey}`,
      display: "external",
    },
    // "connect": the pairing-code entry page — OpenChat's consent sheet offers it as a one-tap
    // "open the right page" shortcut next to the 6-digit code. The #openchat-connect hash scrolls
    // to (and focuses) the code input in ActionInboxSettings.
    {
      kind: "connect",
      url: `${resolvePublicOrigin()}/settings#openchat-connect`,
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
  ],
};

/** Serialize the manifest for registration with OpenChat's integration hook. */
export function renderManifestJson(): string {
  return JSON.stringify(iouActionManifest, null, 2);
}
