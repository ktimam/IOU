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

import type { EntryPayload } from "./types";

export type Balance = {
  currency: string;
  amount_minor: number; // signed: positive = they owe me
};

export function computeBalances(entries: EntryPayload[]): Balance[] {
  const byCurrency: Record<string, number> = {};
  for (const e of entries) {
    const sign = e.direction === "credit" ? +1 : -1;
    byCurrency[e.currency] = (byCurrency[e.currency] ?? 0) + sign * e.amount_minor;
  }
  return Object.entries(byCurrency)
    .filter(([, v]) => v !== 0)
    .map(([currency, amount_minor]) => ({ currency, amount_minor }))
    .sort((a, b) => Math.abs(b.amount_minor) - Math.abs(a.amount_minor));
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
