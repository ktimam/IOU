// Pure template → entry-defaults mapping, extracted from SheetPage so the fee handling and the
// RELATIVE-schedule → absolute-due-date anchoring are unit-testable. A matched template's output
// here is the `base` parseDraft merges an imported chat draft onto (and the seed for the manual
// "+ Add" form).

import type { EntryPayload } from "../entries/types";
import type { TxnTemplate } from "./TemplatesContext";

/**
 * Convert a template to EntryForm defaults. The template's schedule is RELATIVE (offset days from an
 * anchor, or the start of next month); it is resolved to absolute UTC-midnight due dates anchored at
 * `anchorTs` — TODAY by default (the manual picker) or the transaction date a chat draft carried, so
 * a portion "due in 0 days" lands on that date rather than today. A fixed fee in a different currency
 * carries `fixed_currency` (its own balance line); a same-currency fixed fee folds into the net.
 */
export function templateToInitial(t: TxnTemplate, anchorTs?: number): Partial<EntryPayload> {
  const gross = t.amount_minor ?? 0;
  const feePct = t.fee_percent ?? 0;
  const feeFixed = t.fee_fixed_minor ?? 0;
  const hasFee = t.txn_type === "iou" && (feePct > 0 || feeFixed > 0);

  let schedule: EntryPayload["schedule"];
  if (t.txn_type === "iou" && t.schedule && t.schedule.length) {
    const anchor = new Date(anchorTs ?? Date.now());
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth();
    const base = Date.UTC(y, m, anchor.getUTCDate());
    schedule = t.schedule.map((p) => ({
      due_ts:
        p.anchor === "start_of_next_month"
          ? Date.UTC(y, m + 1, 1) // rolls over in December correctly
          : base + p.offset_days * 86_400_000,
      percent: p.percent,
    }));
  }

  return {
    currency: t.currency,
    amount_minor: t.amount_minor,
    direction: t.direction,
    note: t.note ?? "",
    txn_type: t.txn_type,
    fee: hasFee
      ? {
          percent: feePct,
          fixed_minor: feeFixed,
          // Only a foreign fixed fee carries a currency; same-currency (absent) folds into the net.
          ...(feeFixed > 0 && t.fee_fixed_currency ? { fixed_currency: t.fee_fixed_currency } : {}),
          gross_amount_minor: gross,
        }
      : undefined,
    ...(schedule ? { schedule } : {}),
  };
}
