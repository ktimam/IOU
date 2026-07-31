// resolveTemplateBase — the ONLY containment between a cross-account type name and this sheet.
//
// THE REPORT. "Reservation template is proposed in the child chat despite that there is no
// Reservation type in the linked account." The mechanism is not a bug in one function: OpenChat holds
// ONE manifest per app+user (no per-chat rule set), and ManifestTypesSync folds
// loadAllSharedTemplates — EVERY account — into that single roster, so House's "Reservation" routes
// in the child chat and arrives here as `raw.template = "Reservation"`.
//
// This file pins what happens next, because that half is the half that decides whether the user is
// harmed. A name this account does not own must seed NOTHING: no 20% fee, no 1000 EGP fixed fee, no
// 50/50 schedule, no currency, no direction. Today the miss is a bare `undefined` that no test can
// observe — which is exactly how a foreign type could start quietly re-shaping entries without a
// single suite going red. The fee/schedule damage is D8's damage arriving through a different door.
//
// NOT A FIX. The roster leak is deliberately left alone here (actionManifest.test.ts pins it as a
// design trade-off). These tests pin the containment, so the day someone adds a chat→account gate,
// the legitimate half below has to keep working.

import { describe, it, expect } from "vitest";
import { resolveTemplateBase } from "./resolveTemplateBase";
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
