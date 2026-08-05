import { describe, expect, it } from "vitest";
import { decodeEntry, type EntryPayload, type FeePayload } from "./types";

const valid: EntryPayload = {
  ts: Date.UTC(2026, 7, 1),
  kind: "expense",
  currency: "USD",
  amount_minor: 1_000,
  direction: "debt",
  note: "valid",
  txn_type: "iou",
};

function decode(value: unknown): EntryPayload {
  return decodeEntry(
    new TextEncoder().encode(JSON.stringify(value)),
  );
}

describe("decodeEntry due schedule validation", () => {
  it.each([
    ["absent", undefined],
    ["one 100% portion", [{ due_ts: valid.ts, percent: 100 }]],
    [
      "multiple portions totaling 100%",
      [
        { due_ts: valid.ts, percent: 40 },
        { due_ts: valid.ts + 86_400_000, percent: 60 },
      ],
    ],
  ])("accepts a %s schedule", (_label, schedule) => {
    const payload =
      schedule === undefined ? valid : { ...valid, schedule };
    expect(decode(payload)).toEqual(payload);
  });

  it.each([
    ["present but empty", []],
    ["zero total", [{ due_ts: valid.ts, percent: 0 }]],
    ["99 total", [{ due_ts: valid.ts, percent: 99 }]],
    [
      "200 total",
      [
        { due_ts: valid.ts, percent: 100 },
        { due_ts: valid.ts + 1, percent: 100 },
      ],
    ],
    [
      "300 total",
      [
        { due_ts: valid.ts, percent: 100 },
        { due_ts: valid.ts + 1, percent: 100 },
        { due_ts: valid.ts + 2, percent: 100 },
      ],
    ],
  ])("rejects a schedule with %s", (_label, schedule) => {
    expect(() => decode({ ...valid, schedule })).toThrow(
      /invalid entry schedule/i,
    );
  });

  it("rejects a negative portion even when the signed total is exactly 100", () => {
    expect(() =>
      decode({
        ...valid,
        schedule: [
          { due_ts: valid.ts, percent: -1 },
          { due_ts: valid.ts + 1, percent: 101 },
        ],
      }),
    ).toThrow(/invalid entry schedule/i);
  });

  it("rejects null rather than treating it as an absent schedule", () => {
    expect(() => decode({ ...valid, schedule: null })).toThrow(
      /invalid entry schedule/i,
    );
  });

  it("rejects a due schedule on a settlement", () => {
    expect(() =>
      decode({
        ...valid,
        kind: "payment",
        txn_type: "settlement",
        schedule: [{ due_ts: valid.ts, percent: 100 }],
      }),
    ).toThrow(/invalid entry schedule/i);
  });
});

describe("decodeEntry fee semantics", () => {
  it.each([
    [
      "percent-only",
      800,
      { percent: 20, gross_amount_minor: 1_000 },
    ],
    [
      "same-currency fixed fee",
      700,
      {
        percent: 20,
        fixed_minor: 100,
        gross_amount_minor: 1_000,
      },
    ],
    [
      "explicit same-currency fixed fee",
      700,
      {
        percent: 20,
        fixed_minor: 100,
        fixed_currency: "USD",
        gross_amount_minor: 1_000,
      },
    ],
    [
      "case-insensitive same-currency fixed fee",
      700,
      {
        percent: 20,
        fixed_minor: 100,
        fixed_currency: "usd",
        gross_amount_minor: 1_000,
      },
    ],
    [
      "foreign fixed fee",
      800,
      {
        percent: 20,
        fixed_minor: 100,
        fixed_currency: "EGP",
        gross_amount_minor: 1_000,
      },
    ],
  ] satisfies [string, number, FeePayload][])(
    "accepts a consistent %s payload",
    (_label, amount_minor, fee) => {
      expect(decode({ ...valid, amount_minor, fee })).toMatchObject({
        amount_minor,
        fee,
      });
    },
  );

  it.each([
    [
      "fee on a settlement",
      {
        ...valid,
        kind: "payment",
        txn_type: "settlement",
        fee: { percent: 20, gross_amount_minor: 1_000 },
      },
    ],
    [
      "net inconsistent with percent",
      {
        ...valid,
        amount_minor: 999,
        fee: { percent: 20, gross_amount_minor: 1_000 },
      },
    ],
    [
      "net greater than gross",
      {
        ...valid,
        amount_minor: 1_001,
        fee: { percent: 0, gross_amount_minor: 1_000 },
      },
    ],
    [
      "fixed currency without a positive fixed fee",
      {
        ...valid,
        amount_minor: 1_000,
        fee: {
          percent: 0,
          fixed_minor: 0,
          fixed_currency: "EGP",
          gross_amount_minor: 1_000,
        },
      },
    ],
  ])("rejects %s", (_label, payload) => {
    expect(() => decode(payload)).toThrow(/invalid entry fee/i);
  });

  it("rejects null rather than treating it as an absent fee", () => {
    expect(() => decode({ ...valid, fee: null })).toThrow(
      /invalid entry fee/i,
    );
  });
});
