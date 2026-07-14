// CSV export of a sheet's entries, in a Google-Sheets-friendly
// format.
//
// The CSV is RFC 4180-ish: commas between fields, double-quotes
// around any field that contains a comma/quote/newline, escaped
// quotes by doubling. Google Sheets auto-detects the format on
// import (File -> Import -> Upload -> "Replace current sheet"
// and the column types are inferred from the data).

import type { EntryPayload } from "./types";
import { orientDirection } from "./balance";

const COLUMNS = [
  "date", // YYYY-MM-DD
  "kind", // expense | payment
  "txn_type", // settlement | iou
  "currency", // e.g. USD
  "amount", // NET major units (after any fee) — what counts to the balance
  "gross_amount", // pre-fee face value (empty if no fee)
  "fee_percent", // fee % deducted (empty if no fee)
  "fee_fixed", // flat fee deducted (empty if none)
  "direction", // Credit | Debit
  "due_dates", // "YYYY-MM-DD:NN%; …" for IOUs (empty for settlements)
  "note", // free text
  "convert_from_currency", // empty if not a conversion
  "convert_from_amount", // empty if not a conversion
  "convert_rate", // empty if not a conversion
  "convert_source", // e.g. frankfurter.app
  "created_by", // "you" or "them"
  "edited", // "true" / "false"
];

export function entriesToCsv(
  rows: Array<{
    payload: EntryPayload;
    created_by_me: boolean;
    edited: boolean;
  }>,
): string {
  const lines: string[] = [COLUMNS.join(",")];
  for (const r of rows) {
    const p = r.payload;
    const cells = [
      isoDate(p.ts),
      p.kind,
      p.txn_type ?? "iou",
      p.currency,
      (p.amount_minor / 100).toFixed(2),
      p.fee ? (p.fee.gross_amount_minor / 100).toFixed(2) : "",
      p.fee ? String(p.fee.percent) : "",
      p.fee && p.fee.fixed_minor ? (p.fee.fixed_minor / 100).toFixed(2) : "",
      // Orient the stored (author-relative) direction to the exporting viewer, matching the UI.
      orientDirection(p.direction, r.created_by_me) === "credit" ? "Credit" : "Debit",
      dueDatesCsv(p),
      p.note,
      p.convert?.from_currency ?? "",
      p.convert ? (p.convert.from_amount_minor / 100).toFixed(2) : "",
      p.convert?.rate.toString() ?? "",
      p.convert?.rate_source ?? "",
      r.created_by_me ? "you" : "them",
      r.edited ? "true" : "false",
    ];
    lines.push(cells.map(escapeCsvCell).join(","));
  }
  return lines.join("\n") + "\n";
}

// "YYYY-MM-DD:NN%; …" for IOUs; empty for settlements. IOUs with no
// explicit schedule are a single portion due at the entry date.
function dueDatesCsv(p: EntryPayload): string {
  if (p.txn_type === "settlement") return "";
  const sched =
    p.schedule && p.schedule.length ? p.schedule : [{ due_ts: p.ts, percent: 100 }];
  return sched.map((s) => `${isoDate(s.due_ts)}:${s.percent}%`).join("; ");
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function escapeCsvCell(s: string): string {
  if (s == null) return "";
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Trigger a browser download of the CSV as a Blob. */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("downloadCsv is browser-only");
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Free the blob URL after a tick.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
