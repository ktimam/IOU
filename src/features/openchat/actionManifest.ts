// The IOU "AI-action" descriptor that IOU registers with OpenChat's generic
// app-integration hook. It declares WHAT to extract, the output schema (= the
// EntryDraft the IOU app already parses), the in-chat Confirm-card layout, and
// where to forward the confirmed draft. OpenChat runs its generic
// on-device-model + Confirm-card machinery against this config — nothing
// IOU-specific lives in OpenChat. See docs/chat-agent.md.

import type { Direction } from "../entries/types";

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
  // Where OpenChat forwards the confirmed draft (the legacy IOU relay ingestion path).
  callback: { path: string; auth: "openchat-provenance" };
  // How a confirmed action is delivered. "action_inbox" = OpenChat encrypts the confirmed draft to the
  // consumer's registered recipient_public_key and deposits it on-chain (relay-free; the consumer reads +
  // decrypts it locally). "relay" = the legacy off-chain webhook above. The recipient_public_key is
  // per-device and supplied at registration, not in this static manifest (see ActionInboxSettings).
  delivery: { mode: "action_inbox" } | { mode: "relay" };
};

export const IOU_EXTRACTION_PROMPT = `You are extracting a single money transaction from an image
for a 2-person shared ledger. Output ONLY a compact JSON object with these fields and nothing else:
{"kind":"settlement","amount":<number in major units>,"currency":"<3-letter ISO code>",
"direction":"credit"|"debt","date":"YYYY-MM-DD","note":"<short description>"}.
"direction" is "credit" if the amount is owed TO the user, "debt" if the user owes it.
If unsure of a field, omit it. Never invent an amount or a counterparty.`;

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
      amount: { type: ["number", "string"] },
      currency: { type: "string", pattern: "^[A-Za-z]{3}$" },
      direction: { enum: ["credit", "debt"] },
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      note: { type: "string" },
    },
    required: ["amount", "currency"],
  },
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
};

/** Serialize the manifest for registration with OpenChat's integration hook. */
export function renderManifestJson(): string {
  return JSON.stringify(iouActionManifest, null, 2);
}
