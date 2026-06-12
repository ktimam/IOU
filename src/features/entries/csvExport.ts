// CSV export of a sheet's entries, in a Google-Sheets-friendly
// format.
//
// The CSV is RFC 4180-ish: commas between fields, double-quotes
// around any field that contains a comma/quote/newline, escaped
// quotes by doubling. Google Sheets auto-detects the format on
// import (File -> Import -> Upload -> "Replace current sheet"
// and the column types are inferred from the data).

import type { EntryPayload } from "./types";

const COLUMNS = [
  "date", // YYYY-MM-DD
  "kind", // expense | payment
  "currency", // e.g. USD
  "amount", // major units (e.g. 12.50)
  "direction", // credit | debt
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
      p.currency,
      (p.amount_minor / 100).toFixed(2),
      p.direction,
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
