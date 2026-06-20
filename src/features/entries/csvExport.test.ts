// CSV export format tests. Pure data, no DOM.

import { describe, it, expect } from "vitest";
import { entriesToCsv } from "./csvExport";
import type { EntryPayload } from "./types";

const sampleRow: EntryPayload = {
  ts: Date.UTC(2026, 5, 12, 14, 30),
  kind: "expense",
  currency: "USD",
  amount_minor: 1250,
  direction: "debt",
  note: "lunch",
};

describe("csvExport", () => {
  it("renders the header", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: true, edited: false },
    ]);
    const first = csv.split("\n")[0];
    expect(first).toBe(
      "date,kind,txn_type,currency,amount,gross_amount,fee_percent," +
        "direction,due_dates,note," +
        "convert_from_currency,convert_from_amount,convert_rate," +
        "convert_source,created_by,edited",
    );
  });

  it("emits ISO date, net amount, txn_type and Credit/Debit direction", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: true, edited: false },
    ]);
    // date,kind,txn_type,currency,amount,gross,fee,direction,due_dates,note
    expect(csv).toContain(
      "2026-06-12,expense,iou,USD,12.50,,,Debit,2026-06-12:100%,lunch",
    );
  });

  it("renders a fee row: net amount + gross + fee%", () => {
    const csv = entriesToCsv([
      {
        payload: {
          ...sampleRow,
          direction: "credit",
          txn_type: "iou",
          amount_minor: 80000, // net
          fee: { percent: 20, gross_amount_minor: 100000 },
        },
        created_by_me: true,
        edited: false,
      },
    ]);
    const line = csv.split("\n").find((l) => l.startsWith("2026-06-12"))!;
    // amount(net)=800.00, gross_amount=1000.00, fee_percent=20, Credit
    expect(line).toContain("iou,USD,800.00,1000.00,20,Credit,");
  });

  it("escapes commas, quotes, and newlines", () => {
    const csv = entriesToCsv([
      {
        payload: {
          ...sampleRow,
          note: 'comma, "quote", and\nnewline',
        },
        created_by_me: false,
        edited: false,
      },
    ]);
    // The note cell should be quoted; internal " doubled; embedded
    // \n kept inside the quotes.
    expect(csv).toContain(
      '"comma, ""quote"", and\nnewline"',
    );
  });

  it("renders the convert sub-payload", () => {
    const csv = entriesToCsv([
      {
        payload: {
          ...sampleRow,
          currency: "EGP",
          amount_minor: 61400,
          convert: {
            from_currency: "USD",
            from_amount_minor: 1250,
            to_currency: "EGP",
            to_amount_minor: 61400,
            rate: 49.12,
            rate_source: "frankfurter.app",
            rate_fetched_at: Date.now(),
          },
        },
        created_by_me: true,
        edited: true,
      },
    ]);
    const line = csv.split("\n").find((l) => l.startsWith("2026-06-12"));
    expect(line).toContain("EGP");
    expect(line).toContain("USD");
    expect(line).toContain("49.12");
    expect(line).toContain("frankfurter.app");
    expect(line!.endsWith("you,true")).toBe(true);
  });

  it("writes empty cells for non-fee, non-convert rows", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: false, edited: false },
    ]);
    const line = csv.split("\n")[1];
    const cells = line.split(",");
    expect(cells[5]).toBe(""); // gross_amount
    expect(cells[6]).toBe(""); // fee_percent
    // convert_from_currency, convert_from_amount, convert_rate, convert_source
    expect(cells[10]).toBe("");
    expect(cells[11]).toBe("");
    expect(cells[12]).toBe("");
    expect(cells[13]).toBe("");
    expect(cells[14]).toBe("them");
    expect(cells[15]).toBe("false");
  });
});
