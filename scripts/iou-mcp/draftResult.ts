// Connector core (transport-agnostic) for the IOU chat bridge — Milestone 1.
//
// The chat (Claude/ChatGPT) does the screenshot vision/extraction on the user's
// OWN subscription and calls a tool with the extracted fields. This module
// turns those fields into a validated, canonical IOU "draft" — the SAME schema
// the in-app "✨ From AI draft" importer (Milestone 0) consumes, with the SAME
// deterministic `draft_id`, so however the draft reaches the app (paste now;
// relay/push/deep-link later) it dedupes to exactly one entry.
//
// KEY-BLIND BY CONSTRUCTION: this never touches K_sheet, the IC identity, or the
// canister. It only validates and normalizes a draft. The encrypted write
// happens later, on the user's device, in the IOU app's confirm screen. So the
// connector adds no key-custody trust surface — it only ever sees the draft
// fields, which the user already handed to their AI.
//
// It deliberately reuses src/features/entries/draft.ts so the connector and the
// app cannot drift on validation or the idempotency id.

import { parseDraft } from "../../src/features/entries/draft";

export type PrepareInput = {
  kind?: "settlement" | "iou";
  amount?: number | string;
  currency?: string;
  direction?: "credit" | "debt";
  date?: string;
  counterparty?: string;
  note?: string;
  fee_percent?: number;
  fee_fixed?: number | string;
  schedule?: { due_date: string; percent?: number }[];
  draft_id?: string;
};

// The clean draft object emitted for the app to import (paste / link / relay).
export type CanonicalDraft = {
  kind: "settlement" | "iou";
  amount: number; // major units
  currency: string;
  direction: "credit" | "debt";
  date: string; // YYYY-MM-DD
  note?: string;
  fee_percent?: number;
  fee_fixed?: number; // major units
  schedule?: { due_date: string; percent: number }[];
  draft_id: string;
};

export type PrepareResult =
  | {
      ok: true;
      draft: CanonicalDraft;
      draftId: string;
      summary: string;
      pasteJson: string; // ready to paste into "✨ From AI draft"
      deepLink: string; // for the future in-app receiver (M1b)
    }
  | { ok: false; errors: string[] };

function base64url(s: string): string {
  // Node + browser safe.
  const b64 =
    typeof Buffer !== "undefined"
      ? Buffer.from(s, "utf8").toString("base64")
      : btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build the universal-link the in-app receiver will eventually handle. The
 * draft rides in the URL fragment (not sent to the host) for a touch less
 * exposure; the receiver parses `#d=...`. Host is configurable. */
export function buildDeepLink(draft: CanonicalDraft, host: string): string {
  const base = host.replace(/\/+$/, "");
  return `${base}/import#d=${base64url(JSON.stringify(draft))}`;
}

/**
 * Validate + normalize the chat-extracted fields into a canonical draft.
 * Returns the draft (+ a paste-ready JSON, a deep link, a one-line summary and
 * the deterministic draft_id), or a list of human-readable errors.
 */
export function buildDraftResult(
  input: PrepareInput,
  opts: { host?: string } = {},
): PrepareResult {
  const res = parseDraft(input);
  if (!res.ok) return { ok: false, errors: res.errors };

  const init = res.value.initial;
  const grossMinor = init.fee ? init.fee.gross_amount_minor : init.amount_minor ?? 0;
  const draft: CanonicalDraft = {
    kind: (init.txn_type as "settlement" | "iou") ?? "settlement",
    amount: grossMinor / 100,
    currency: init.currency ?? "",
    direction: init.direction ?? "credit",
    date: new Date(init.ts ?? Date.now()).toISOString().slice(0, 10),
    ...(init.note ? { note: init.note } : {}),
    ...(init.fee
      ? {
          fee_percent: init.fee.percent,
          ...(init.fee.fixed_minor ? { fee_fixed: init.fee.fixed_minor / 100 } : {}),
        }
      : {}),
    ...(init.schedule
      ? {
          schedule: init.schedule.map((p) => ({
            due_date: new Date(p.due_ts).toISOString().slice(0, 10),
            percent: p.percent,
          })),
        }
      : {}),
    draft_id: res.value.draftId,
  };

  const host = opts.host ?? process.env.IOU_APP_URL ?? "https://iou.app";
  return {
    ok: true,
    draft,
    draftId: res.value.draftId,
    summary: res.value.summary,
    pasteJson: JSON.stringify(draft, null, 2),
    deepLink: buildDeepLink(draft, host),
  };
}
