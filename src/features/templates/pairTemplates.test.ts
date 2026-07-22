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
  DISMISSED_CAP,
  encodePairSlot,
  decodePairSlot,
  mergePairTemplates,
  mergeDismissed,
  reconcileSlot,
  visibleTemplates,
  nextRev,
  upsertSlot,
  combineTemplates,
} from "./pairTemplates";
import type { TxnTemplate } from "./TemplatesContext";

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

const EMPTY_PAYLOAD = { templates: [], dismissed: [] };

describe("pair slot codec (v2 envelope)", () => {
  it("round-trips templates through encode/decode (empty dismissed by default)", () => {
    const slot = [reservation, tpl({ id: "rent", name: "Rent" })];
    expect(decodePairSlot(encodePairSlot(slot))).toEqual({
      templates: slot,
      dismissed: [],
    });
  });

  it("round-trips a full v2 payload: templates + dismissed messageIds", () => {
    const dismissed = ["340282366920938463463374607431768211455", "17"];
    expect(decodePairSlot(encodePairSlot([reservation], dismissed))).toEqual({
      templates: [reservation],
      dismissed,
    });
  });

  it("decodes a LEGACY v1 bare-array blob to {templates, dismissed: []}", () => {
    const legacyBytes = new TextEncoder().encode(JSON.stringify([reservation]));
    expect(decodePairSlot(legacyBytes)).toEqual({
      templates: [reservation],
      dismissed: [],
    });
  });

  it("decodes absent / empty input to an empty payload (pre-upgrade Pair)", () => {
    expect(decodePairSlot(null)).toEqual(EMPTY_PAYLOAD);
    expect(decodePairSlot(undefined)).toEqual(EMPTY_PAYLOAD);
    expect(decodePairSlot(new Uint8Array(0))).toEqual(EMPTY_PAYLOAD);
  });

  it("accepts plain number[] bytes (Candid vec nat8 decodes as number[])", () => {
    const bytes = Array.from(encodePairSlot([reservation]));
    expect(decodePairSlot(bytes)).toEqual({ templates: [reservation], dismissed: [] });
  });

  it("degrades garbage to an empty payload instead of throwing", () => {
    expect(decodePairSlot(new TextEncoder().encode("not json"))).toEqual(EMPTY_PAYLOAD);
    expect(decodePairSlot(new TextEncoder().encode('{"a":1}'))).toEqual(EMPTY_PAYLOAD);
    expect(decodePairSlot(new TextEncoder().encode("null"))).toEqual(EMPTY_PAYLOAD);
    expect(decodePairSlot(new TextEncoder().encode("42"))).toEqual(EMPTY_PAYLOAD);
  });

  it("drops malformed template items but keeps valid ones (both formats)", () => {
    const junk = [reservation, { name: "no id or rev" }, 42, null];
    const v1 = new TextEncoder().encode(JSON.stringify(junk));
    expect(decodePairSlot(v1)).toEqual({ templates: [reservation], dismissed: [] });
    const v2 = new TextEncoder().encode(JSON.stringify({ v: 2, templates: junk, dismissed: [] }));
    expect(decodePairSlot(v2)).toEqual({ templates: [reservation], dismissed: [] });
  });

  it("keeps only string dismissed ids; missing/garbage dismissed degrades to []", () => {
    const mixed = new TextEncoder().encode(
      JSON.stringify({ v: 2, templates: [], dismissed: ["a", 5, null, "b", {}] }),
    );
    expect(decodePairSlot(mixed)).toEqual({ templates: [], dismissed: ["a", "b"] });
    const missing = new TextEncoder().encode(JSON.stringify({ v: 2, templates: [reservation] }));
    expect(decodePairSlot(missing)).toEqual({ templates: [reservation], dismissed: [] });
    const nonArray = new TextEncoder().encode(
      JSON.stringify({ v: 2, templates: [], dismissed: "nope" }),
    );
    expect(decodePairSlot(nonArray)).toEqual(EMPTY_PAYLOAD);
  });
});

// ── dismissed union ──────────────────────────────────────────────────

describe("mergeDismissed", () => {
  it("is the de-duped union: a's insertion order first, then b's new ids", () => {
    expect(mergeDismissed(["1", "2"], ["2", "3"])).toEqual(["1", "2", "3"]);
    expect(mergeDismissed([], ["x"])).toEqual(["x"]);
    expect(mergeDismissed(["x"], [])).toEqual(["x"]);
    expect(mergeDismissed([], [])).toEqual([]);
  });

  it("dedupes WITHIN each input too", () => {
    expect(mergeDismissed(["1", "1", "2"], ["2", "2"])).toEqual(["1", "2"]);
  });

  it(`caps the stored list at ${DISMISSED_CAP} ids, dropping the OLDEST`, () => {
    const a = Array.from({ length: DISMISSED_CAP }, (_, i) => `d${i}`);
    const merged = mergeDismissed(a, ["new"]);
    expect(merged).toHaveLength(DISMISSED_CAP);
    expect(merged).not.toContain("d0"); // oldest dropped
    expect(merged[0]).toBe("d1");
    expect(merged[merged.length - 1]).toBe("new");
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

// ── reconcileSlot: MY slot mirrors MY personal templates ─────────────
//
// Types are ALWAYS shared to the account: no Share toggle. An effect
// compares the personal list to my current slot and publishes only when
// they DRIFT — new/changed ids upserted at nextRev, ids no longer in my
// personal list DROPPED (absence, not tombstone). null = no publish.

describe("reconcileSlot (personal-list mirror)", () => {
  const NOW = 7_777;

  function personalTpl(over: Partial<TxnTemplate> & { id: string }): TxnTemplate {
    return {
      name: `Type ${over.id}`,
      direction: "credit",
      txn_type: "iou",
      ...over,
    };
  }

  it("no drift → null (rev/updatedAt bookkeeping ignored in the comparison)", () => {
    const p = personalTpl({ id: "resv", name: "Reservation", fee_percent: 20 });
    const slot = [tpl({ id: "resv", name: "Reservation", fee_percent: 20, rev: 5, updatedAt: 42 })];
    expect(reconcileSlot([p], slot, slot, NOW)).toBeNull();
  });

  it("no drift when a personal field is undefined and absent from the slot envelope (JSON round-trip)", () => {
    const p = personalTpl({ id: "resv", currency: undefined, keywords: undefined });
    const slot = [tpl({ id: "resv", rev: 2, updatedAt: 9 })];
    expect(reconcileSlot([p], slot, slot, NOW)).toBeNull();
  });

  it("new personal type → upserted at rev 1 with updatedAt = now", () => {
    const p = personalTpl({ id: "resv", name: "Reservation" });
    const next = reconcileSlot([p], [], [], NOW);
    expect(next).toEqual([{ ...p, rev: 1, updatedAt: NOW }]);
  });

  it("content edit → republished at the NEXT rev", () => {
    const cur = tpl({ id: "resv", name: "Reservation", rev: 3, updatedAt: 1 });
    const p = personalTpl({ id: "resv", name: "Reservation (20%)" });
    const next = reconcileSlot([p], [cur], [cur], NOW);
    expect(next).toEqual([{ ...p, rev: 4, updatedAt: NOW }]);
  });

  it("keyword-ONLY change counts as drift", () => {
    const cur = tpl({ id: "resv", name: "Reservation", rev: 1, updatedAt: 1 });
    const p = personalTpl({ id: "resv", name: "Reservation", keywords: ["deposit"] });
    const next = reconcileSlot([p], [cur], [cur], NOW);
    expect(next).not.toBeNull();
    expect(next![0].rev).toBe(2);
    expect(next![0].keywords).toEqual(["deposit"]);
  });

  it("type removed from personal → DROPPED from the slot (absence, not a tombstone)", () => {
    const cur = tpl({ id: "resv", rev: 2, updatedAt: 1 });
    const next = reconcileSlot([], [cur], [cur], NOW);
    expect(next).toEqual([]); // publish an EMPTY slot — no deleted:true envelope
  });

  it("my override removed → the partner's original resurfaces via the merge", () => {
    const partnerOriginal = tpl({ id: "resv", name: "Reservation", rev: 1, updatedAt: 1 });
    const myOverride = tpl({ id: "resv", name: "Reservation (25%)", rev: 2, updatedAt: 2 });
    const merged = mergePairTemplates([myOverride], [partnerOriginal]);
    // I deleted my personal copy → my slot drops the id entirely.
    const next = reconcileSlot([], [myOverride], merged, NOW);
    expect(next).toEqual([]);
    // The partner's untouched slot now wins the merge again.
    const after = visibleTemplates(mergePairTemplates(next!, [partnerOriginal]));
    expect(after.map((t) => t.name)).toEqual(["Reservation"]);
  });

  it("a tombstoned id still in my personal list is republished LIVE above the tombstone", () => {
    const tomb = tpl({ id: "resv", rev: 3, updatedAt: 1, deleted: true });
    const p = personalTpl({ id: "resv", name: "Reservation" });
    const next = reconcileSlot([p], [tomb], [tomb], NOW);
    expect(next).toEqual([{ ...p, rev: 4, updatedAt: NOW }]);
    expect(next![0]).not.toHaveProperty("deleted");
  });

  it("a legacy tombstone for an id NOT in my personal list is dropped (one-time cleanup)", () => {
    const tomb = tpl({ id: "old", rev: 2, updatedAt: 1, deleted: true });
    expect(reconcileSlot([], [tomb], [tomb], NOW)).toEqual([]);
  });

  it("unchanged envelopes keep their rev/updatedAt; output follows personal order", () => {
    const curA = tpl({ id: "a", name: "Alpha", rev: 4, updatedAt: 11 });
    const pA = personalTpl({ id: "a", name: "Alpha" });
    const pB = personalTpl({ id: "b", name: "Bravo" });
    const next = reconcileSlot([pA, pB], [curA], [curA], NOW);
    expect(next).toEqual([curA, { ...pB, rev: 1, updatedAt: NOW }]);
  });

  it("partner's higher-rev override does NOT make my identical slot drift (copy-on-write respected)", () => {
    const mine = tpl({ id: "resv", name: "Reservation", rev: 1, updatedAt: 1 });
    const partnerOverride = tpl({ id: "resv", name: "Reservation (25%)", rev: 2, updatedAt: 2 });
    const merged = mergePairTemplates([mine], [partnerOverride]);
    const p = personalTpl({ id: "resv", name: "Reservation" });
    expect(reconcileSlot([p], [mine], merged, NOW)).toBeNull();
  });

  it("republish revs come from the MERGED view, landing ABOVE a partner override", () => {
    const mine = tpl({ id: "resv", name: "Reservation", rev: 1, updatedAt: 1 });
    const partnerOverride = tpl({ id: "resv", name: "Reservation (25%)", rev: 4, updatedAt: 2 });
    const merged = mergePairTemplates([mine], [partnerOverride]);
    const p = personalTpl({ id: "resv", name: "Reservation v3" });
    const next = reconcileSlot([p], [mine], merged, NOW);
    expect(next![0].rev).toBe(5);
  });

  it("is deterministic: identical inputs give deep-equal outputs", () => {
    const cur = tpl({ id: "a", rev: 1, updatedAt: 1 });
    const p = [personalTpl({ id: "a", name: "Renamed" }), personalTpl({ id: "b" })];
    const r1 = reconcileSlot(p, [cur], [cur], NOW);
    const r2 = reconcileSlot(p, [cur], [cur], NOW);
    expect(r1).toEqual(r2);
  });
});
