// Account-local template resolution after the public roster was removed.
//
// This file pins what happens next, because that half is the half that decides whether the user is
// harmed. A name this account does not own must seed NOTHING: no 20% fee, no 1000 EGP fixed fee, no
// 50/50 schedule, no currency, no direction. Today the miss is a bare `undefined` that no test can
// observe — which is exactly how a foreign type could start quietly re-shaping entries without a
// single suite going red. The fee/schedule damage is D8's damage arriving through a different door.
//
// These tests also pin legacy explicit-template containment while new drafts
// are matched locally from message evidence.

import { describe, it, expect } from "vitest";
import {
  matchTemplateForDraft,
  resolveTemplateBase,
  templateEvidenceForImport,
} from "./resolveTemplateBase";
import { templateToInitial } from "../templates/templateBase";
import { extractTs } from "./draft";
import type { TxnTemplate } from "../templates/TemplatesContext";

// The House account's Reservation: 20% + a 1000 EGP fixed fee, paid 50/50 (the real one from the
// live drive). The child account below has never heard of it.
const HOUSE_RESERVATION: TxnTemplate = {
  id: "t2",
  name: "Reservation",
  direction: "credit",
  txn_type: "iou",
  currency: "EGP",
  fee_percent: 20,
  fee_fixed_minor: 100000,
  schedule: [
    { offset_days: 0, percent: 50 },
    { offset_days: 30, percent: 50 },
  ],
  keywords: ["reservation", "booking"],
};

// The child account's only type.
const CHILD_ALLOWANCE: TxnTemplate = {
  id: "t1",
  name: "Allowance",
  direction: "debt",
  txn_type: "iou",
  currency: "USD",
  fee_percent: 0,
  schedule: [{ offset_days: 0, percent: 100 }],
};

describe("resolveTemplateBase — a type this account does not own seeds NOTHING", () => {
  it("returns no base for a name that only exists on another account", () => {
    // The reported case: the child sheet, a draft routed by House's "Reservation" keywords.
    const r = resolveTemplateBase([CHILD_ALLOWANCE], { amount: 1000, template: "Reservation" });
    expect(r.base).toBeUndefined();
    // No fee %, no fixed fee, no schedule, no currency, no direction can reach the entry — the
    // draft is imported with exactly what the message itself said.
    expect(r.base?.fee).toBeUndefined();
    expect(r.base?.schedule).toBeUndefined();
  });

  it("names the miss so the import can say so out loud", () => {
    // Without this the miss is indistinguishable from "no template was asked for", and the user is
    // left to notice on their own that the defaults they expected never appeared.
    const r = resolveTemplateBase([CHILD_ALLOWANCE], { amount: 1000, template: "Reservation" });
    expect(r.unknownTemplate).toBe("Reservation");
  });

  it("does not crash or half-match on a foreign name that merely looks similar", () => {
    // Substring matching here would be the same class of bug as OpenChat's substring keywords.
    expect(resolveTemplateBase([CHILD_ALLOWANCE], { amount: 1, template: "Allowances" }).base).toBeUndefined();
    expect(resolveTemplateBase([CHILD_ALLOWANCE], { amount: 1, template: "Allow" }).base).toBeUndefined();
  });
});

describe("resolveTemplateBase — a type this account DOES own still applies", () => {
  it("matches by name case-insensitively and seeds the type's own defaults", () => {
    // The fix must not degenerate into "match nothing": a template on THIS account is the whole
    // reason the routing exists (20% + 1000 EGP + 50/50 is what the user set up).
    const raw = { amount: 1000, template: "reservation", note: "Reservation 3 July" };
    const r = resolveTemplateBase([CHILD_ALLOWANCE, HOUSE_RESERVATION], raw);
    expect(r.base).toEqual(templateToInitial(HOUSE_RESERVATION, extractTs(raw)));
    expect(r.unknownTemplate).toBeUndefined();
    // Spelled out, so a regression in templateToInitial's wiring shows here too.
    expect(r.base?.fee).toEqual({ percent: 20, fixed_minor: 100000, gross_amount_minor: 0 });
    expect(r.base?.currency).toBe("EGP");
  });

  it("anchors the due schedule at the DRAFT's date, not today", () => {
    // A portion "due in 0 days" belongs on the reservation date; anchoring at today is how a
    // just-imported booking shows up already overdue (or due a month late).
    const raw = { amount: 1000, template: "Reservation", date: "2026-08-01" };
    const aug1 = Date.UTC(2026, 7, 1);
    expect(resolveTemplateBase([HOUSE_RESERVATION], raw).base?.schedule).toEqual([
      { due_ts: aug1, percent: 50 },
      { due_ts: aug1 + 30 * 86_400_000, percent: 50 },
    ]);
  });

  it("still honours an id reference from an older id-based manifest", () => {
    const r = resolveTemplateBase([HOUSE_RESERVATION], { amount: 1000, template: "t2" });
    expect(r.base?.currency).toBe("EGP");
    expect(r.unknownTemplate).toBeUndefined();
  });

  it("fails closed when an explicit encrypted id is another saved type's display name", () => {
    const idOwner = { ...HOUSE_RESERVATION, id: "collision", name: "Reservation" };
    const nameOwner = { ...CHILD_ALLOWANCE, id: "other", name: "collision" };
    const result = resolveTemplateBase([nameOwner, idOwner], {
      amount: 1000,
      template: "collision",
    });
    expect(result.base).toBeUndefined();
    expect(result.unknownTemplate).toBe("collision");
  });

  it("fails closed when two account-local types have the same display name", () => {
    const first = { ...HOUSE_RESERVATION, id: "first", name: "Rent" };
    const second = { ...CHILD_ALLOWANCE, id: "second", name: " rent " };
    const result = resolveTemplateBase([first, second], { amount: 1000, template: "RENT" });
    expect(result).toEqual({ unknownTemplate: "RENT" });
  });
});

describe("resolveTemplateBase — no template asked for", () => {
  it("treats a blank/absent/non-object reference as 'nothing asked for', not as a miss", () => {
    // A blank name must NOT surface as an unknown type — that would put a warning on every plain
    // message the model didn't classify.
    for (const raw of [{ amount: 1000, template: "   " }, { amount: 1000 }, null, "nope", 7]) {
      const r = resolveTemplateBase([HOUSE_RESERVATION], raw);
      expect(r.base).toBeUndefined();
      expect(r.unknownTemplate).toBeUndefined();
    }
  });
});

describe("resolveTemplateBase — the same-name collision the shared roster makes reachable", () => {
  // Both accounts have a "Rent", with DIFFERENT money. The user's House chat message routes on
  // House's keywords, but the card is imported on the child sheet, whose account has its own Rent.
  const HOUSE_RENT: TxnTemplate = {
    id: "h-rent",
    name: "Rent",
    direction: "credit",
    txn_type: "iou",
    currency: "EGP",
    fee_percent: 20,
    schedule: [
      { offset_days: 0, percent: 50 },
      { offset_days: 30, percent: 50 },
    ],
    keywords: ["rent"],
  };
  const CHILD_RENT: TxnTemplate = {
    id: "c-rent",
    name: "Rent",
    direction: "debt",
    txn_type: "iou",
    currency: "USD",
    fee_percent: 0,
    schedule: [{ offset_days: 7, percent: 100 }],
    keywords: ["rent"],
  };

  it("applies THIS account's Rent, never the routing account's", () => {
    // The name matched, so nothing warns — and the entry silently takes the child account's 0% /
    // single-portion terms instead of House's 20% / 50-50. Name equality is all the wire carries:
    // the manifest routes on a NAME, so which account's "Rent" the user meant is unrecoverable here.
    // This is the price of the per-user roster, and it is pinned so it cannot change by accident.
    const r = resolveTemplateBase([CHILD_RENT], { amount: 5000, template: "Rent", date: "2026-08-01" });
    expect(r.base?.currency).toBe("USD");
    expect(r.base?.direction).toBe("debt");
    expect(r.base?.fee).toBeUndefined(); // 0% + no fixed fee ⇒ no fee at all
    expect(r.base?.schedule).toHaveLength(1);
    expect(r.unknownTemplate).toBeUndefined(); // nothing to warn about — the name IS in this account
    // The same draft on the House account resolves to House's terms; only the account differs.
    const house = resolveTemplateBase([HOUSE_RENT], { amount: 5000, template: "Rent", date: "2026-08-01" });
    expect(house.base?.currency).toBe("EGP");
    expect(house.base?.fee?.percent).toBe(20);
    expect(house.base?.schedule).toHaveLength(2);
  });
});

describe("resolveTemplateBase private local keyword matching", () => {
  it("uses row-local evidence for every OpenChat import, including one surviving row", () => {
    expect(templateEvidenceForImport("openchat", false)).toBe("row-local");
    expect(templateEvidenceForImport("openchat", true)).toBe("row-local");
    expect(templateEvidenceForImport("connector", true)).toBe("row-local");
    expect(templateEvidenceForImport("connector", false)).toBe("full");
    expect(templateEvidenceForImport(undefined, false)).toBe("full");
  });

  it("matches message evidence against this account without a manifest template field", () => {
    const raw = { amount: 1000, message: "Booked a reservation for 3 July" };
    expect(resolveTemplateBase([HOUSE_RESERVATION], raw).base).toEqual(
      templateToInitial(HOUSE_RESERVATION, extractTs(raw)),
    );
  });

  it("uses an exact whole-word saved Type name as a private implicit trigger", () => {
    const reservation = { ...HOUSE_RESERVATION, keywords: [] };

    expect(
      matchTemplateForDraft([reservation], {
        note: "Reservation 1-20 August 700 USD",
      })?.id,
    ).toBe(reservation.id);
    expect(
      matchTemplateForDraft([reservation], {
        note: "PreReservation 1-20 August 700 USD",
      }),
    ).toBeUndefined();
  });

  it("fails saved Type-name matching closed when another Type also matches", () => {
    const reservation = { ...HOUSE_RESERVATION, id: "reservation", keywords: [] };
    const booking = {
      ...HOUSE_RESERVATION,
      id: "booking",
      name: "Booking",
      keywords: ["reservation"],
    };

    expect(
      matchTemplateForDraft([reservation, booking], {
        note: "Reservation 1-20 August 700 USD",
      }),
    ).toBeUndefined();
  });

  it("cannot match a private type belonging only to another account", () => {
    const raw = { amount: 1000, message: "Booked a reservation for 3 July" };
    expect(resolveTemplateBase([CHILD_ALLOWANCE], raw)).toEqual({});
  });

  it("matches complete words rather than substrings", () => {
    const rent = { ...HOUSE_RESERVATION, id: "rent", name: "Rent", keywords: ["rent"] };
    expect(resolveTemplateBase([rent], { message: "parent paid" })).toEqual({});
    expect(resolveTemplateBase([rent], { message: "rent paid" }).base).toBeDefined();
  });

  it("fails closed when two templates share a matching keyword", () => {
    const a = { ...HOUSE_RESERVATION, id: "a", name: "A", keywords: ["booking"] };
    const b = { ...HOUSE_RESERVATION, id: "b", name: "B", keywords: ["booking"] };
    expect(resolveTemplateBase([a, b], { message: "booking paid" })).toEqual({});
  });

  it("exposes the same unique matcher to the private in-chat card", () => {
    expect(
      matchTemplateForDraft([CHILD_ALLOWANCE, HOUSE_RESERVATION], {
        message: "Booked a reservation for 3 July",
      })?.id,
    ).toBe(HOUSE_RESERVATION.id);
    expect(matchTemplateForDraft([CHILD_ALLOWANCE], { message: "reservation" })).toBeUndefined();
  });

  it("the shared matcher is word-boundary and ambiguity safe", () => {
    const rent = { ...HOUSE_RESERVATION, id: "rent", name: "Rent", keywords: ["rent"] };
    expect(matchTemplateForDraft([rent], { message: "parent paid" })).toBeUndefined();
    expect(matchTemplateForDraft([rent], { message: "rent paid" })?.id).toBe("rent");
    expect(
      matchTemplateForDraft(
        [rent, { ...rent, id: "rent-2", name: "Other rent" }],
        { message: "rent paid" },
      ),
    ).toBeUndefined();
  });

  it("uses row-local note evidence for multi-entry import fallback", () => {
    const rent = { ...HOUSE_RESERVATION, id: "rent", name: "Rent", keywords: ["rent"] };
    const allowance = {
      ...HOUSE_RESERVATION,
      id: "allowance",
      name: "Allowance",
      keywords: ["allowance"],
    };
    const resolveRow = resolveTemplateBase as unknown as (
      templates: TxnTemplate[],
      raw: unknown,
      options: { evidence: "row-local" },
    ) => ReturnType<typeof resolveTemplateBase>;
    const sharedMessage = "rent 100 and allowance 50";

    expect(
      resolveRow(
        [rent, allowance],
        { message: sharedMessage, note: "rent" },
        { evidence: "row-local" },
      ).base?.currency,
    ).toBe(rent.currency);
    expect(
      resolveRow(
        [rent, allowance],
        { message: sharedMessage, note: "groceries" },
        { evidence: "row-local" },
      ),
    ).toEqual({});
    expect(
      resolveRow(
        [rent, allowance],
        { message: sharedMessage, note: "allowance" },
        { evidence: "row-local" },
      ).base?.currency,
    ).toBe(allowance.currency);
  });

  it("fails closed only for the multi row whose local evidence collides", () => {
    const bookingA = { ...HOUSE_RESERVATION, id: "a", name: "A", keywords: ["booking"] };
    const bookingB = { ...HOUSE_RESERVATION, id: "b", name: "B", keywords: ["booking"] };
    const allowance = {
      ...HOUSE_RESERVATION,
      id: "allowance",
      name: "Allowance",
      keywords: ["allowance"],
    };
    const resolveRow = resolveTemplateBase as unknown as (
      templates: TxnTemplate[],
      raw: unknown,
      options: { evidence: "row-local" },
    ) => ReturnType<typeof resolveTemplateBase>;
    const templates = [bookingA, bookingB, allowance];
    const sharedMessage = "booking deposit and allowance";

    expect(
      resolveRow(
        templates,
        { message: sharedMessage, note: "booking deposit" },
        { evidence: "row-local" },
      ),
    ).toEqual({});
    expect(
      resolveRow(
        templates,
        { message: sharedMessage, note: "allowance" },
        { evidence: "row-local" },
      ).base,
    ).toBeDefined();
  });
});
