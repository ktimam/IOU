// Per-viewer direction orientation (fix for "both members see 'owes you'").
// Direction is stored author-relative; each viewer must see the mirror, so the
// two members' balances are exact negatives of each other.

import { describe, it, expect } from "vitest";
import { flipDirection, orientDirection, orientPayload, computeBalances } from "./balance";
import type { EntryPayload } from "./types";

function entry(p: Partial<EntryPayload>): EntryPayload {
  return { ts: 0, kind: "expense", currency: "USD", amount_minor: 0, direction: "credit", note: "", ...p };
}

describe("direction orientation helpers", () => {
  it("flipDirection swaps credit/debt (and is its own inverse)", () => {
    expect(flipDirection("credit")).toBe("debt");
    expect(flipDirection("debt")).toBe("credit");
    expect(flipDirection(flipDirection("credit"))).toBe("credit");
  });

  it("orientDirection keeps the author's frame, flips for the partner", () => {
    expect(orientDirection("credit", true)).toBe("credit"); // I authored it
    expect(orientDirection("credit", false)).toBe("debt"); // partner authored it → I see the mirror
    expect(orientDirection("debt", false)).toBe("credit");
  });

  it("orientPayload flips only the direction, preserving amount/currency/fee", () => {
    const p = entry({ currency: "EUR", amount_minor: 12345, direction: "credit", note: "x" });
    expect(orientPayload(p, true)).toBe(p); // same author → unchanged reference
    const flipped = orientPayload(p, false);
    expect(flipped.direction).toBe("debt");
    expect(flipped.amount_minor).toBe(12345);
    expect(flipped.currency).toBe("EUR");
    expect(flipped.note).toBe("x");
  });
});

describe("cross-user balance is a perfect mirror", () => {
  // A settlement authored by A (B owes A 50) and one authored by B (A owes B 20), both USD.
  const shared = [
    { created_by: "A", payload: entry({ txn_type: "settlement", direction: "credit", amount_minor: 5000 }) },
    { created_by: "B", payload: entry({ txn_type: "settlement", direction: "credit", amount_minor: 2000 }) },
  ];
  const viewAs = (me: string) => computeBalances(shared.map((e) => orientPayload(e.payload, e.created_by === me)));

  it("A sees B owes them 30; B sees they owe A 30 (exact negatives)", () => {
    expect(viewAs("A")).toEqual([{ currency: "USD", amount_minor: 3000 }]); // +30 → B owes A
    expect(viewAs("B")).toEqual([{ currency: "USD", amount_minor: -3000 }]); // −30 → A owes B
  });

  it("every currency line is negated between the two members", () => {
    const multi = [
      { created_by: "A", payload: entry({ txn_type: "settlement", direction: "credit", currency: "USD", amount_minor: 8000 }) },
      { created_by: "A", payload: entry({ txn_type: "settlement", direction: "debt", currency: "EUR", amount_minor: 4000 }) },
      { created_by: "B", payload: entry({ txn_type: "settlement", direction: "credit", currency: "USD", amount_minor: 1000 }) },
    ];
    const a = computeBalances(multi.map((e) => orientPayload(e.payload, e.created_by === "A")));
    const b = computeBalances(multi.map((e) => orientPayload(e.payload, e.created_by === "B")));
    const bByCcy = Object.fromEntries(b.map((x) => [x.currency, x.amount_minor]));
    for (const line of a) expect(bByCcy[line.currency]).toBe(-line.amount_minor);
  });

  it("a partner-authored IOU keeps its schedule/amounts, only the sign flips", () => {
    const iou = entry({
      txn_type: "iou",
      direction: "credit",
      amount_minor: 100000,
      schedule: [{ due_ts: Date.UTC(2026, 5, 1), percent: 100 }],
    });
    const asAuthor = computeBalances([orientPayload(iou, true)]);
    const asPartner = computeBalances([orientPayload(iou, false)]);
    expect(asAuthor).toEqual([{ currency: "USD", amount_minor: 100000 }]);
    expect(asPartner).toEqual([{ currency: "USD", amount_minor: -100000 }]);
  });
});
