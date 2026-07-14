// Pure entry-building math extracted from EntryForm so the net/convert/fee logic
// is unit-testable without rendering the form. buildEntryPayload reproduces the
// exact computation EntryForm.submit performs (validation + convert + fee →
// EntryPayload); the form now delegates to it.

import type { ConvertPayload, Direction, EntryPayload, FeePayload, TxnType } from "./types";
import { netAfterFee } from "./balance";

/** A due-date row as the form holds it (date string + percent). */
export type ScheduleRowInput = { date: string; percent: number };

/** The convert selection when the toggle is on and a rate has loaded. */
export type ConvertInput = {
  to: string;
  rate: number;
  rateSource: string;
  rateFetchedAt: number;
};

export type EntryFormInput = {
  amountStr: string; // GROSS/face value, major units (e.g. "12.50")
  currency: string;
  direction: Direction;
  note: string;
  dateYmd: string; // "YYYY-MM-DD"
  txnType: TxnType;
  feePercent: number;
  feeFixedStr: string; // major units (e.g. "5.00")
  feeFixedCurrency: string; // "" ⇒ same as the entry currency
  schedule: ScheduleRowInput[];
  convert?: ConvertInput | null; // present iff the convert toggle is on with a loaded rate
  draftId?: string;
};

export type BuildEntryResult =
  | { ok: true; payload: EntryPayload }
  | { ok: false; error: string };

/** Round a major-unit form string to integer minor units (0 on blank/NaN). */
export function toMinorMajor(str: string): number {
  return Math.round((parseFloat(str) || 0) * 100);
}

/** UTC-midnight ms for a "YYYY-MM-DD" string (matches EntryForm). */
export function ymdToTs(ymd: string): number {
  return new Date(ymd + "T00:00:00Z").getTime();
}

/**
 * Build the EntryPayload from form inputs, mirroring EntryForm.submit exactly:
 *   - amount must be > 0;
 *   - IOU schedules need ≥1 row and (for multi-row) must total 100%;
 *   - a convert selection restates the entry in the target currency at the fetched rate;
 *   - the fee reduces the NET (amount_minor) by percent + any SAME-currency fixed fee; a fixed fee
 *     in a DIFFERENT currency is carried on `fee.fixed_currency` (its own balance line — see balance.ts)
 *     and does NOT reduce the net.
 */
export function buildEntryPayload(input: EntryFormInput): BuildEntryResult {
  const amountMinor = toMinorMajor(input.amountStr);
  if (!amountMinor || amountMinor <= 0) {
    return { ok: false, error: "amount must be > 0" };
  }

  const percentTotal = input.schedule.reduce((t, r) => t + (Number(r.percent) || 0), 0);
  let schedulePayload: EntryPayload["schedule"];
  if (input.txnType === "iou") {
    if (input.schedule.length === 0) return { ok: false, error: "add at least one due date" };
    if (input.schedule.length > 1 && percentTotal !== 100) {
      return { ok: false, error: "due-date percentages must total 100%" };
    }
    schedulePayload = input.schedule.map((r) => ({
      due_ts: ymdToTs(r.date),
      percent: input.schedule.length === 1 ? 100 : Number(r.percent) || 0,
    }));
  }

  const ts = ymdToTs(input.dateYmd);
  const feeFixedMinor = toMinorMajor(input.feeFixedStr);
  const convertedMinor = input.convert ? Math.round(amountMinor * input.convert.rate) : null;

  let convert: ConvertPayload | undefined;
  if (input.convert && convertedMinor != null) {
    convert = {
      from_currency: input.currency,
      from_amount_minor: amountMinor,
      to_currency: input.convert.to,
      to_amount_minor: convertedMinor,
      rate: input.convert.rate,
      rate_source: input.convert.rateSource,
      rate_fetched_at: input.convert.rateFetchedAt,
    };
  }

  const baseMinor = convert ? convertedMinor! : amountMinor;
  const entryCurrency = convert ? input.convert!.to : input.currency;
  const useFee = input.txnType === "iou" && (input.feePercent > 0 || feeFixedMinor > 0);
  const feeCurrency = input.feeFixedCurrency || entryCurrency;
  const fixedForeign = feeFixedMinor > 0 && feeCurrency !== entryCurrency;
  const fee: FeePayload | undefined = useFee
    ? {
        percent: input.feePercent,
        fixed_minor: feeFixedMinor,
        ...(fixedForeign ? { fixed_currency: feeCurrency } : {}),
        gross_amount_minor: baseMinor,
      }
    : undefined;

  const payload: EntryPayload = {
    ts,
    kind: input.txnType === "settlement" ? "payment" : "expense",
    currency: entryCurrency,
    amount_minor: useFee ? netAfterFee(baseMinor, input.feePercent, fixedForeign ? 0 : feeFixedMinor) : baseMinor,
    direction: input.direction,
    note: input.note,
    txn_type: input.txnType,
    ...(schedulePayload ? { schedule: schedulePayload } : {}),
    ...(fee ? { fee } : {}),
    convert,
    ...(input.draftId ? { draft_id: input.draftId } : {}),
  };
  return { ok: true, payload };
}
