// Per-currency balance computation.
//
// For a sheet with two members (me, them):
//   * credit (them -> me): I am owed +amount
//   * debt   (me -> them): I owe   +amount
//
// Net per currency: sum(credit) - sum(debt).
//   > 0 => they owe me that much
//   < 0 => I owe them that much
//
// Converted entries are stored as the *destination* currency, so they
// roll up like normal entries. The original "from" currency is
// preserved on the entry's convert sub-payload for the history view.

import type { EntryPayload, Direction } from "./types";

export type Balance = {
  currency: string;
  amount_minor: number; // signed: positive = they owe me
};

// Direction is stored in the ENTRY AUTHOR's frame: "credit" = the OTHER member owes the author,
// "debt" = the author owes the other member. For a 2-person sheet where BOTH members add entries,
// a viewer who is NOT the author sees the mirror image, so their view must flip the direction. These
// helpers orient a stored (author-relative) direction to a given viewer, and are their own inverse
// (so an edit can orient-in and orient-out losslessly). `sameAuthor` = the viewer authored the entry.
export function flipDirection(d: Direction): Direction {
  return d === "credit" ? "debt" : "credit";
}
export function orientDirection(d: Direction, sameAuthor: boolean): Direction {
  return sameAuthor ? d : flipDirection(d);
}
/** Orient a whole entry payload's direction to the viewer (used for balance computation + display). */
export function orientPayload(p: EntryPayload, sameAuthor: boolean): EntryPayload {
  return sameAuthor ? p : { ...p, direction: flipDirection(p.direction) };
}

// A dated slice of an entry's amount. Settlements yield one portion due at
// the entry's `ts`; IOUs yield one portion per `schedule` row (or a single
// portion due at `ts` when no schedule is set / for legacy entries).
export type Portion = {
  currency: string;
  due_ts: number;
  amount_minor: number;
  direction: Direction;
};

/**
 * Expand an entry into dated portions. Splits the GROSS by each portion's
 * `percent` (last portion takes the rounding remainder), then deducts any
 * fee from the FINAL due(s) — so earlier installments are paid in full and
 * the fee lands on the last. Portions always sum to the net `amount_minor`.
 */
export function portionsOf(e: EntryPayload): Portion[] {
  if (e.txn_type === "settlement") {
    return [
      { currency: e.currency, due_ts: e.ts, amount_minor: e.amount_minor, direction: e.direction },
    ];
  }
  const sched =
    e.schedule && e.schedule.length > 0 ? e.schedule : [{ due_ts: e.ts, percent: 100 }];
  // amount_minor is the NET; with a fee the gross is on the fee sub-payload.
  const gross = e.fee ? e.fee.gross_amount_minor : e.amount_minor;
  const portions: Portion[] = [];
  let allocated = 0;
  for (let i = 0; i < sched.length; i++) {
    const isLast = i === sched.length - 1;
    const remaining = Math.max(0, gross - allocated);
    const amt = isLast
      ? remaining
      : Math.min(
          remaining,
          Math.max(0, Math.round((gross * sched[i].percent) / 100)),
        );
    allocated += amt;
    portions.push({
      currency: e.currency,
      due_ts: sched[i].due_ts,
      amount_minor: amt,
      direction: e.direction,
    });
  }
  // Deduct the entry-currency fee (percent + any SAME-currency fixed) from the final installment(s),
  // cascading backward only if the last can't absorb it. `gross − amount_minor` is exactly that
  // entry-currency fee — a fixed fee in another currency is not folded into `amount_minor`.
  if (e.fee) {
    let remainingFee = gross - e.amount_minor;
    for (let i = portions.length - 1; i >= 0 && remainingFee > 0; i--) {
      const take = Math.min(portions[i].amount_minor, remainingFee);
      portions[i].amount_minor -= take;
      remainingFee -= take;
    }
    // A fixed fee charged in a DIFFERENT currency is its own balance line: a deduction (opposite
    // direction), due with the final installment, totalled with other entries of that currency.
    const fc = e.fee.fixed_currency;
    if (
      fc &&
      fc.toUpperCase() !== e.currency.toUpperCase() &&
      (e.fee.fixed_minor ?? 0) > 0
    ) {
      portions.push({
        currency: fc,
        due_ts: sched[sched.length - 1].due_ts,
        amount_minor: e.fee.fixed_minor!,
        direction: e.direction === "credit" ? "debt" : "credit",
      });
    }
  }
  return portions;
}

function rollUp(byCurrency: Record<string, number>): Balance[] {
  return Object.entries(byCurrency)
    .filter(([, v]) => v !== 0)
    .map(([currency, amount_minor]) => ({ currency, amount_minor }))
    .sort((a, b) => Math.abs(b.amount_minor) - Math.abs(a.amount_minor));
}

/**
 * Net balance counting only portions that have matured by `cutoffTs`
 * (due_ts <= cutoffTs). Settlements count once their (instant) `ts`
 * passes. Used for the "this month" / "previous month" maturity views.
 */
export function computeBalancesAsOf(entries: EntryPayload[], cutoffTs: number): Balance[] {
  const byCurrency: Record<string, number> = {};
  for (const e of entries) {
    for (const p of portionsOf(e)) {
      if (p.due_ts > cutoffTs) continue;
      const sign = p.direction === "credit" ? +1 : -1;
      byCurrency[p.currency] = (byCurrency[p.currency] ?? 0) + sign * p.amount_minor;
    }
  }
  return rollUp(byCurrency);
}

/** Overall balance: every portion (100%), including not-yet-due ones. */
export function computeBalances(entries: EntryPayload[]): Balance[] {
  return computeBalancesAsOf(entries, Number.POSITIVE_INFINITY);
}

/** Last millisecond of the calendar month before the one containing `now` (UTC). */
export function endOfPrevMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - 1;
}

/**
 * Net (post-fee) minor amount for an IOU: gross minus `percent`% of the
 * gross, minus a flat `fixedMinor`, clamped at 0.
 * e.g. netAfterFee(100000, 20) === 80000;
 *      netAfterFee(500000, 20, 100000) === 300000.
 */
export function netAfterFee(
  grossMinor: number,
  percent: number,
  fixedMinor = 0,
): number {
  const p = Math.max(0, Math.min(100, percent));
  const pctAmount = Math.round((grossMinor * p) / 100);
  return Math.max(0, grossMinor - pctAmount - Math.max(0, fixedMinor));
}

/** Format a minor-unit amount in a human-friendly way. */
export function formatMinor(amount_minor: number, currency: string): string {
  // Assume 2 fraction digits for fiat (USD, EGP, EUR, ...). v1 has no
  // currency metadata; this is good enough for the default list.
  const major = amount_minor / 100;
  const sign = amount_minor < 0 ? "-" : "";
  const abs = Math.abs(major).toFixed(2);
  return `${sign}${abs} ${currency}`;
}
