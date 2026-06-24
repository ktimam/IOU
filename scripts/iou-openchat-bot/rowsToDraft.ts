// Map an OpenChat ActionCard's confirmed `rows` (label/value pairs the human
// saw and confirmed) back into an IOU draft the relay/app will accept.
//
// The labels/values come from the IOU Ai-action card layout that IOU registers
// (src/features/openchat/actionManifest.ts): Amount / Currency / Direction /
// Note, with direction rendered in plain language ("Owed to you" / "You owe").
// This is the inverse of that rendering. The app's parseDraft re-validates, so
// this only needs to produce the loose draft shape (EntryDraft).

export type ActionCardRow = { label: string; value: string };

export type OpenChatDraft = {
  kind: "settlement";
  amount?: number;
  currency?: string;
  direction?: "credit" | "debt";
  note?: string;
};

const DIRECTION: Record<string, "credit" | "debt"> = {
  "owed to you": "credit",
  "you owe": "debt",
};

/** Build an IOU draft from confirmed ActionCard rows, or null if unusable. */
export function rowsToDraft(rows: ActionCardRow[]): OpenChatDraft | null {
  const get = (label: string): string | undefined =>
    rows.find((r) => r.label.trim().toLowerCase() === label)?.value?.trim();

  const amountRaw = get("amount");
  const currency = get("currency");
  const amount = amountRaw != null ? Number(amountRaw.replace(/[^0-9.]/g, "")) : undefined;
  const dirRaw = get("direction")?.toLowerCase() ?? "";
  const direction = DIRECTION[dirRaw];
  const note = get("note");

  if (!Number.isFinite(amount as number) || !(amount! > 0) || !currency) return null;

  return {
    kind: "settlement",
    amount,
    currency: currency.toUpperCase(),
    ...(direction ? { direction } : {}),
    ...(note ? { note } : {}),
  };
}
