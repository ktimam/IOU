// Parse an UNTRUSTED "entry draft" into EntryForm defaults.
//
// Milestone 0 of the chat bridge (docs/chat-agent.md): the user's own AI
// (Claude/ChatGPT) extracts a money transfer / reservation into a small JSON
// "draft"; that draft is imported into IOU (pasted now; via deep link / push
// later) and pre-fills the EntryForm. The draft NEVER writes directly — it only
// seeds the human-confirmed form, which then encrypts on-device and calls
// add_entry (the existing templateToInitial → EntryForm → onSubmit seam).
//
// Therefore every field here is treated as hostile input (a malicious paste or
// a prompt-injected screenshot could carry a wrong amount/currency/direction):
// validate types and ranges, fold unknown extras away, and surface errors. The
// `direction` is only a HINT the user confirms/flips on the form.

import type { Direction, EntryPayload, TxnType, DuePortion } from "./types";

export type DraftSchedulePortion = { due_date: string; percent?: number };

// The loose wire shape a chat/AI (or a deep link) produces. All fields are
// optional/loose on input; parseDraft validates and normalizes.
export type EntryDraft = {
  kind?: TxnType; // "settlement" | "iou"; inferred from fee/schedule if absent
  amount?: number | string; // GROSS / face value, MAJOR units (e.g. 25 or "25.00")
  currency?: string; // 3-letter ISO-4217-ish
  direction?: Direction; // hint; default "credit"
  date?: string; // YYYY-MM-DD; default today (UTC)
  counterparty?: string; // informational (folded into the note)
  note?: string;
  fee_percent?: number; // IOU only, 0..100
  fee_fixed?: number | string; // IOU only, MAJOR units
  schedule?: DraftSchedulePortion[]; // IOU only
  draft_id?: string; // idempotency key; derived deterministically if absent
};

export type ParsedDraft = {
  // Form defaults to hand to <EntryForm initial=...> (the confirm surface).
  initial: Partial<EntryPayload>;
  // Stable idempotency id (provided or derived) — used to dedupe re-imports.
  draftId: string;
  // One-line human summary for the import UI.
  summary: string;
};

export type ParseResult =
  | { ok: true; value: ParsedDraft }
  | { ok: false; errors: string[] };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a major-unit amount ("25", "25.00", 25) to integer minor units. */
function toMinor(v: unknown): number | null {
  const n =
    typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** YYYY-MM-DD → ms epoch at UTC midnight (matching EntryForm), or null. */
function dateToTs(d: string): number | null {
  if (!DATE_RE.test(d)) return null;
  const ts = Date.parse(d + "T00:00:00Z");
  return Number.isFinite(ts) ? ts : null;
}

function todayTsUtc(): number {
  return Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
}

// Small, stable, synchronous (non-crypto) hash for a deterministic idempotency
// id when the draft doesn't carry one — so re-importing the same draft is
// idempotent. FNV-1a over a normalized field string. Not security-sensitive.
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ("00000000" + h.toString(16)).slice(-8);
}

/**
 * Validate + normalize an untrusted draft into EntryForm defaults.
 * Returns typed form defaults + a stable draftId, or a list of errors.
 */
export function parseDraft(input: unknown): ParseResult {
  const errors: string[] = [];
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["draft must be a JSON object"] };
  }
  const d = input as Record<string, unknown>;

  // kind / txn_type (infer when absent: fee/schedule ⇒ iou, else settlement)
  let kind: TxnType;
  if (d.kind === "settlement" || d.kind === "iou") {
    kind = d.kind;
  } else if (d.kind == null) {
    kind =
      d.schedule != null || d.fee_percent != null || d.fee_fixed != null
        ? "iou"
        : "settlement";
  } else {
    errors.push('kind must be "settlement" or "iou"');
    kind = "settlement";
  }

  // amount (gross/face value, major → minor)
  const grossMinor = toMinor(d.amount);
  if (grossMinor == null || grossMinor <= 0) {
    errors.push("amount must be a positive number");
  }

  // currency (3 ASCII letters → upper)
  let currency = "";
  if (typeof d.currency === "string" && /^[A-Za-z]{3}$/.test(d.currency.trim())) {
    currency = d.currency.trim().toUpperCase();
  } else {
    errors.push("currency must be a 3-letter code (e.g. USD)");
  }

  // direction (hint, user confirms/flips)
  let direction: Direction = "credit";
  if (d.direction === "credit" || d.direction === "debt") direction = d.direction;
  else if (d.direction != null) errors.push('direction must be "credit" or "debt"');

  // date (default today, UTC)
  let ts: number = todayTsUtc();
  if (typeof d.date === "string") {
    const t = dateToTs(d.date);
    if (t == null) errors.push("date must be YYYY-MM-DD");
    else ts = t;
  } else if (d.date != null) {
    errors.push("date must be a YYYY-MM-DD string");
  }

  // note (+ counterparty folded in for visibility; there is no counterparty
  // field — IOU is a 2-person ledger, the partner is implicit)
  const noteParts: string[] = [];
  if (typeof d.note === "string" && d.note.trim()) noteParts.push(d.note.trim());
  if (typeof d.counterparty === "string" && d.counterparty.trim()) {
    noteParts.push(`(${d.counterparty.trim()})`);
  }
  const note = noteParts.join(" ");

  // IOU fee + schedule
  let feePercent = 0;
  let feeFixedMinor = 0;
  let schedule: DuePortion[] | undefined;
  if (kind === "iou") {
    if (d.fee_percent != null) {
      const fp = Number(d.fee_percent);
      if (!Number.isFinite(fp) || fp < 0 || fp > 100) errors.push("fee_percent must be 0..100");
      else feePercent = fp;
    }
    if (d.fee_fixed != null) {
      const ff = toMinor(d.fee_fixed);
      if (ff == null || ff < 0) errors.push("fee_fixed must be a non-negative number");
      else feeFixedMinor = ff;
    }
    if (d.schedule != null) {
      if (!Array.isArray(d.schedule) || d.schedule.length === 0) {
        errors.push("schedule must be a non-empty array");
      } else {
        const portions: DuePortion[] = [];
        let pctTotal = 0;
        for (const row of d.schedule as unknown[]) {
          if (row == null || typeof row !== "object") {
            errors.push("schedule rows must be objects");
            continue;
          }
          const r = row as Record<string, unknown>;
          const due = typeof r.due_date === "string" ? dateToTs(r.due_date) : null;
          if (due == null) {
            errors.push("schedule.due_date must be YYYY-MM-DD");
            continue;
          }
          const pct = r.percent == null ? undefined : Number(r.percent);
          if (pct != null && (!Number.isFinite(pct) || pct < 0 || pct > 100)) {
            errors.push("schedule.percent must be 0..100");
            continue;
          }
          portions.push({ due_ts: due, percent: pct ?? 0 });
          pctTotal += pct ?? 0;
        }
        if (portions.length === 1) {
          portions[0].percent = 100;
        } else if (portions.length > 1 && Math.round(pctTotal) !== 100) {
          errors.push("schedule percents must total 100");
        }
        if (portions.length) schedule = portions;
      }
    }
  }

  if (errors.length) return { ok: false, errors };

  const hasFee = kind === "iou" && (feePercent > 0 || feeFixedMinor > 0);
  const initial: Partial<EntryPayload> = {
    ts,
    currency,
    amount_minor: grossMinor!,
    direction,
    note,
    txn_type: kind,
    ...(hasFee
      ? {
          fee: {
            percent: feePercent,
            fixed_minor: feeFixedMinor,
            gross_amount_minor: grossMinor!,
          },
        }
      : {}),
    ...(schedule ? { schedule } : {}),
  };

  // Idempotency id: use the provided one, else derive deterministically from
  // the normalized fields so the same draft re-imported maps to one entry.
  const provided =
    typeof d.draft_id === "string" && d.draft_id.trim() ? d.draft_id.trim() : null;
  const normalized = JSON.stringify({
    kind,
    grossMinor,
    currency,
    direction,
    ymd: new Date(ts).toISOString().slice(0, 10),
    note,
    feePercent,
    feeFixedMinor,
    schedule: schedule?.map((p) => [p.due_ts, p.percent]) ?? null,
  });
  const draftId = provided ?? `d:${fnv1a(normalized)}`;
  initial.draft_id = draftId;

  const summary =
    `${kind === "settlement" ? "Settlement" : "IOU"} ` +
    `${(grossMinor! / 100).toFixed(2)} ${currency} · ` +
    `${direction === "credit" ? "owed to you" : "you owe"}` +
    `${note ? ` · ${note}` : ""}`;

  return { ok: true, value: { initial, draftId, summary } };
}

/**
 * Has a non-deleted entry with this draft_id already been written? Used to
 * dedupe re-imports of the same draft (the Milestone-0 form of exactly-once;
 * the silent-write/tap/inbox paths in later milestones share the same key).
 */
export function isDuplicateDraft(
  existing: { deleted: boolean; payload: { draft_id?: string } }[],
  draftId: string,
): boolean {
  return existing.some((e) => !e.deleted && e.payload.draft_id === draftId);
}
