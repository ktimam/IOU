// Unit spec for the pure shared-templates module (pairTemplates.ts).
//
// SHARED transaction types per account: each pair member publishes an
// encrypted blob of the templates they chose to share into THEIR OWN slot
// on the Pair record (templates_a_* / templates_b_*, sealed under the
// active sheet's K_sheet). Both members read both slots via get_pair and
// merge CLIENT-SIDE with this pure, commutative, rev-based merge.
//
// Written failing-first: this file describes the full merge contract
// (disjoint union, same-id higher-rev wins, tombstones, both-edit
// conflict convergence) before pairTemplates.ts existed.

import { describe, it, expect } from "vitest";
import {
  type SharedTemplate,
  encodePairSlot,
  decodePairSlot,
  mergePairTemplates,
  visibleTemplates,
  nextRev,
  upsertSlot,
  combineTemplates,
} from "./pairTemplates";

// ── fixtures ─────────────────────────────────────────────────────────

function tpl(over: Partial<SharedTemplate> & { id: string }): SharedTemplate {
  return {
    name: `Type ${over.id}`,
    direction: "credit",
    txn_type: "iou",
    rev: 1,
    updatedAt: 1_000,
    ...over,
  };
}

const reservation = tpl({
  id: "resv",
  name: "Reservation",
  fee_percent: 20,
  fee_fixed_minor: 100_000,
  currency: "EGP",
  keywords: ["reservation", "deposit"],
});

// ── codec ────────────────────────────────────────────────────────────

describe("pair slot codec", () => {
  it("round-trips a slot through encode/decode", () => {
    const slot = [reservation, tpl({ id: "rent", name: "Rent" })];
    expect(decodePairSlot(encodePairSlot(slot))).toEqual(slot);
  });

  it("decodes absent / empty input to an empty slot (pre-upgrade Pair)", () => {
    expect(decodePairSlot(null)).toEqual([]);
    expect(decodePairSlot(undefined)).toEqual([]);
    expect(decodePairSlot(new Uint8Array(0))).toEqual([]);
  });

  it("accepts plain number[] bytes (Candid vec nat8 decodes as number[])", () => {
    const bytes = Array.from(encodePairSlot([reservation]));
    expect(decodePairSlot(bytes)).toEqual([reservation]);
  });

  it("degrades garbage to an empty slot instead of throwing", () => {
    expect(decodePairSlot(new TextEncoder().encode("not json"))).toEqual([]);
    expect(decodePairSlot(new TextEncoder().encode('{"a":1}'))).toEqual([]);
    expect(decodePairSlot(new TextEncoder().encode("null"))).toEqual([]);
  });

  it("drops malformed items but keeps valid ones", () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify([reservation, { name: "no id or rev" }, 42, null]),
    );
    expect(decodePairSlot(bytes)).toEqual([reservation]);
  });
});

// ── merge: union ─────────────────────────────────────────────────────

describe("mergePairTemplates: union", () => {
  it("disjoint ids merge to the union, stably sorted", () => {
    const a = [tpl({ id: "b1", name: "Bravo" }), tpl({ id: "a1", name: "Alpha" })];
    const b = [tpl({ id: "c1", name: "Charlie" })];
    const merged = mergePairTemplates(a, b);
    expect(merged.map((t) => t.id)).toEqual(["a1", "b1", "c1"]);
  });

  it("empty/absent slots yield the non-empty slot (solo pair: slot A only)", () => {
    expect(mergePairTemplates([reservation], [])).toEqual([reservation]);
    expect(mergePairTemplates([], [reservation])).toEqual([reservation]);
    expect(mergePairTemplates([], [])).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const a = [tpl({ id: "x", rev: 1 })];
    const b = [tpl({ id: "x", rev: 2, name: "Winner" })];
    const aCopy = structuredClone(a);
    const bCopy = structuredClone(b);
    mergePairTemplates(a, b);
    expect(a).toEqual(aCopy);
    expect(b).toEqual(bCopy);
  });
});

// ── merge: conflicts ─────────────────────────────────────────────────

describe("mergePairTemplates: same-id conflicts", () => {
  it("higher rev wins regardless of slot", () => {
    const v1 = tpl({ id: "x", rev: 1, name: "Old" });
    const v2 = tpl({ id: "x", rev: 2, name: "New" });
    expect(mergePairTemplates([v1], [v2])).toEqual([v2]);
    expect(mergePairTemplates([v2], [v1])).toEqual([v2]);
  });

  it("equal rev: higher updatedAt wins", () => {
    const older = tpl({ id: "x", rev: 2, updatedAt: 1_000, name: "Older" });
    const newer = tpl({ id: "x", rev: 2, updatedAt: 2_000, name: "Newer" });
    expect(mergePairTemplates([older], [newer])).toEqual([newer]);
    expect(mergePairTemplates([newer], [older])).toEqual([newer]);
  });

  it("full tie (both-edit conflict): deterministic and COMMUTATIVE — both clients converge", () => {
    const mine = tpl({ id: "x", rev: 3, updatedAt: 5_000, name: "Edited by A" });
    const theirs = tpl({ id: "x", rev: 3, updatedAt: 5_000, name: "Edited by B" });
    const ab = mergePairTemplates([mine], [theirs]);
    const ba = mergePairTemplates([theirs], [mine]);
    expect(ab).toEqual(ba); // convergence is the contract
    expect(ab).toHaveLength(1);
    expect(["Edited by A", "Edited by B"]).toContain(ab[0].name);
  });

  it("edit partner's template (copy-on-write): the rev+1 override in MY slot wins; partner slot untouched", () => {
    const partnerSlot = [tpl({ id: "resv", rev: 1, name: "Reservation" })];
    const mySlot = upsertSlot(
      [],
      tpl({ id: "resv", rev: 2, updatedAt: 9_000, name: "Reservation (20%)" }),
    );
    const merged = mergePairTemplates(partnerSlot, mySlot);
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe("Reservation (20%)");
    expect(merged[0].rev).toBe(2);
    // the partner's slot still holds their rev-1 original
    expect(partnerSlot[0].rev).toBe(1);
  });
});

// ── merge: tombstones ────────────────────────────────────────────────

describe("mergePairTemplates: tombstones", () => {
  it("a higher-rev tombstone hides the template from the visible view", () => {
    const a = [tpl({ id: "resv", rev: 2, name: "Reservation" })];
    const b = [tpl({ id: "resv", rev: 3, deleted: true })];
    const merged = mergePairTemplates(a, b);
    expect(merged).toHaveLength(1);
    expect(merged[0].deleted).toBe(true);
    expect(visibleTemplates(merged)).toEqual([]);
  });

  it("a later rev-4 republish resurrects a rev-3 tombstoned template", () => {
    const b = [tpl({ id: "resv", rev: 3, deleted: true })];
    const a = [tpl({ id: "resv", rev: 4, name: "Reservation v2" })];
    const merged = mergePairTemplates(a, b);
    expect(visibleTemplates(merged)).toHaveLength(1);
    expect(visibleTemplates(merged)[0].name).toBe("Reservation v2");
  });

  it("a stale (lower-rev) tombstone does NOT hide a newer republish", () => {
    const a = [tpl({ id: "resv", rev: 1, deleted: true })];
    const b = [tpl({ id: "resv", rev: 2, name: "Back again" })];
    expect(visibleTemplates(mergePairTemplates(a, b))[0].name).toBe("Back again");
  });
});

// ── helpers ──────────────────────────────────────────────────────────

describe("nextRev / upsertSlot", () => {
  it("nextRev is 1 for an unseen id and max+1 for a seen one", () => {
    expect(nextRev([], "resv")).toBe(1);
    expect(nextRev([tpl({ id: "resv", rev: 3 })], "resv")).toBe(4);
    expect(nextRev([tpl({ id: "resv", rev: 3, deleted: true })], "resv")).toBe(4);
    expect(nextRev([tpl({ id: "other", rev: 9 })], "resv")).toBe(1);
  });

  it("upsertSlot replaces by id and appends new ids", () => {
    const slot = upsertSlot([tpl({ id: "a", rev: 1 })], tpl({ id: "a", rev: 2 }));
    expect(slot).toHaveLength(1);
    expect(slot[0].rev).toBe(2);
    const grown = upsertSlot(slot, tpl({ id: "b" }));
    expect(grown.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

// ── combineTemplates: personal + shared for the picker / manifest ────

describe("combineTemplates", () => {
  const personal = [
    { id: "p1", name: "Personal only", direction: "credit" as const, txn_type: "iou" as const },
    { id: "both", name: "Personal version", direction: "credit" as const, txn_type: "iou" as const },
  ];
  const shared = [
    tpl({ id: "both", name: "Shared version", rev: 2 }),
    tpl({ id: "s1", name: "Shared only", rev: 1 }),
  ];

  it("unions personal and shared; on an id collision the SHARED one wins (pair context)", () => {
    const combined = combineTemplates(personal, shared);
    expect(combined.map((t) => t.id).sort()).toEqual(["both", "p1", "s1"]);
    expect(combined.find((t) => t.id === "both")?.name).toBe("Shared version");
  });

  it("keeps personal order first, then shared", () => {
    const combined = combineTemplates(personal, shared);
    expect(combined.map((t) => t.id)).toEqual(["p1", "both", "s1"]);
  });

  it("tombstoned shared envelopes are ignored (they don't shadow a personal template)", () => {
    const combined = combineTemplates(personal, [
      tpl({ id: "both", rev: 3, deleted: true }),
    ]);
    expect(combined.map((t) => t.id)).toEqual(["p1", "both"]);
    expect(combined.find((t) => t.id === "both")?.name).toBe("Personal version");
  });

  it("works with an empty side", () => {
    expect(combineTemplates([], shared).map((t) => t.id)).toEqual(["both", "s1"]);
    expect(combineTemplates(personal, []).map((t) => t.id)).toEqual(["p1", "both"]);
  });
});
