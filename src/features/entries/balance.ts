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
 * Expand an entry into dated portions. Splits `amount_minor` by each
 * portion's `percent` using rounding, giving the **last** portion the
 * remainder so the portions always sum exactly to `amount_minor` (no
 * rounding drift).
 */
export function portionsOf(e: EntryPayload): Portion[] {
  if (e.txn_type === "settlement") {
    return [
      { currency: e.currency, due_ts: e.ts, amount_minor: e.amount_minor, direction: e.direction },
    ];
  }
  const sched =
    e.schedule && e.schedule.length > 0 ? e.schedule : [{ due_ts: e.ts, percent: 100 }];
  const portions: Portion[] = [];
  let allocated = 0;
  for (let i = 0; i < sched.length; i++) {
    const isLast = i === sched.length - 1;
    const amt = isLast
      ? e.amount_minor - allocated
      : Math.round((e.amount_minor * sched[i].percent) / 100);
    allocated += amt;
    portions.push({
      currency: e.currency,
      due_ts: sched[i].due_ts,
      amount_minor: amt,
      direction: e.direction,
    });
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
 * Net (post-fee) minor amount for an IOU: gross minus `percent`%, rounded.
 * e.g. netAfterFee(100000, 20) === 80000.
 */
export function netAfterFee(grossMinor: number, percent: number): number {
  const p = Math.max(0, Math.min(100, percent));
  return Math.round(grossMinor * (1 - p / 100));
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
