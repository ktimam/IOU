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
      "date,kind,currency,amount,direction,note," +
        "convert_from_currency,convert_from_amount,convert_rate," +
        "convert_source,created_by,edited",
    );
  });

  it("emits an ISO date and the major-unit amount", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: true, edited: false },
    ]);
    expect(csv).toContain("2026-06-12,expense,USD,12.50,debt,lunch");
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

  it("writes empty cells for non-convert rows", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: false, edited: false },
    ]);
    const line = csv.split("\n")[1];
    const cells = line.split(",");
    // convert_from_currency, convert_from_amount, convert_rate,
    // convert_source
    expect(cells[6]).toBe("");
    expect(cells[7]).toBe("");
    expect(cells[8]).toBe("");
    expect(cells[9]).toBe("");
    expect(cells[10]).toBe("them");
    expect(cells[11]).toBe("false");
  });
});
