// End-to-end SCENARIO tests for the OpenChat → IOU confirmable-action bridge
// (docs/chat-agent.md). Each chat message becomes a CONFIRMED EntryDraft, the
// real parseDraft() normalizes it into a stored EntryPayload (the exact
// EntryForm → add_entry seam), and the real balance functions compute the
// resulting 2-party ledger. No hand-rolled balance math — every number below
// is produced by draft.ts + balance.ts and only ASSERTED here.
//
// Direction is author-relative (types.ts):
//   "credit" = the OTHER member owes the author
//   "debt"   = the author owes the other member
// In a 2-party sheet where both members post, a viewer who did NOT author an
// entry sees the mirror, so we orient every stored payload to a chosen viewer
// with orientPayload(payload, created_by === viewer) before computeBalances —
// the same pattern the repo's balance.orient.test.ts uses.

import { describe, it, expect } from "vitest";
import { parseDraft } from "./draft";
import { computeBalances, orientPayload, formatMinor } from "./balance";
import type { EntryPayload } from "./types";
import { draftBelongsOnSheet, type ChatSheetLinks } from "../openchat/chatSheetLinks";

// Turn a CONFIRMED chat draft into the stored EntryPayload, exactly as the
// EntryForm → add_entry seam does. parseDraft returns `initial`, a
// Partial<EntryPayload> that OMITS the `kind: "expense"|"payment"` field (the
// form supplies it; the balance path never reads it), so we add a dummy kind
// to get a full EntryPayload. Throws loudly if a draft is mis-modeled.
function confirm(draft: unknown): EntryPayload {
  const r = parseDraft(draft);
  if (!r.ok) throw new Error("draft rejected: " + r.errors.join("; "));
  return { ...r.value.initial, kind: "expense" } as EntryPayload;
}

// One message posted into a shared sheet: who authored it + its stored payload.
type SheetMsg = { created_by: string; payload: EntryPayload };

// Balance as seen by `viewer`: orient each stored (author-relative) payload to
// the viewer (flip direction for entries the viewer did NOT author), then net.
function viewAs(msgs: SheetMsg[], viewer: string) {
  return computeBalances(msgs.map((m) => orientPayload(m.payload, m.created_by === viewer)));
}

// ---------------------------------------------------------------------------
// SCENARIO 1 — property owner (member A) + property manager (member B) share
// ONE sheet. The manager messages the owner; everything posts to their sheet.
// Owner is owed: (rent collected) − (out-of-pocket expenses) − (transfers made).
// ---------------------------------------------------------------------------
describe("Scenario 1 — owner + manager share one IOU sheet", () => {
  const OWNER = "owner";
  const MANAGER = "manager";

  // Every message is authored by the MANAGER, in the manager's frame.
  const sheet: SheetMsg[] = [
    // (a) TEXT "Reservation 1-7 Aug 25000 EGP" — rent the manager collected for
    //     the owner. The manager now holds the owner's money → manager owes
    //     owner → debt. Date recovered from the note range "1-7 Aug" → Aug 1.
    {
      created_by: MANAGER,
      payload: confirm({ kind: "iou", direction: "debt", amount: 25000, currency: "EGP", note: "Reservation 1-7 Aug 25000 EGP" }),
    },
    // (a) TEXT "Reservation 12 Aug 18000 EGP" — more collected rent → debt.
    {
      created_by: MANAGER,
      payload: confirm({ kind: "iou", direction: "debt", amount: 18000, currency: "EGP", note: "Reservation 12 Aug 18000 EGP" }),
    },
    // (b) TEXT "Plumbing repair 1500 EGP" — manager paid out of pocket for the
    //     owner's property → owner owes manager → credit → reduces the debt.
    {
      created_by: MANAGER,
      payload: confirm({ kind: "iou", direction: "credit", amount: 1500, currency: "EGP", note: "Plumbing repair 1500 EGP" }),
    },
    // (b) TEXT "Cleaning 800 EGP" — another out-of-pocket expense → credit.
    {
      created_by: MANAGER,
      payload: confirm({ kind: "iou", direction: "credit", amount: 800, currency: "EGP", note: "Cleaning 800 EGP" }),
    },
    // (c) TRANSFER IMAGE → the on-device vision model reads a money-transfer
    //     screenshot into a fixed SETTLEMENT draft (amount + currency only;
    //     the model is NOT unit-runnable, so this object stands in for its
    //     output). The manager transferred 20000 EGP to the owner → money
    //     already moved → settlement; the payer (manager) records it as credit,
    //     offsetting his reservation debt.
    {
      created_by: MANAGER,
      payload: confirm({ kind: "settlement", direction: "credit", amount: 20000, currency: "EGP", date: "2026-08-15", note: "Transfer to owner" }),
    },
  ];

  it("normalizes each manager message into the right entry (minor units, dates, txn_type)", () => {
    // 25000 EGP major → 2500000 minor; range note "1-7 Aug" anchors on Aug 1.
    expect(sheet[0].payload.amount_minor).toBe(2500000);
    expect(sheet[0].payload.currency).toBe("EGP");
    expect(sheet[0].payload.txn_type).toBe("iou");
    expect(new Date(sheet[0].payload.ts).toISOString().slice(0, 10)).toMatch(/-08-01$/);
    // "Reservation 12 Aug" → Aug 12.
    expect(new Date(sheet[1].payload.ts).toISOString().slice(0, 10)).toMatch(/-08-12$/);
    // The transfer image is a settlement (matures instantly).
    expect(sheet[4].payload.txn_type).toBe("settlement");
    expect(sheet[4].payload.amount_minor).toBe(2000000);
  });

  it("owner is owed rent minus expenses minus transfers already made", () => {
    // 43000 rent − 2300 expenses − 20000 transferred = 20700 EGP still owed.
    const ownerView = viewAs(sheet, OWNER);
    expect(ownerView).toEqual([{ currency: "EGP", amount_minor: 2070000 }]);
    expect(formatMinor(ownerView[0].amount_minor, "EGP")).toBe("20700.00 EGP"); // positive = manager owes owner
  });

  it("the manager sees the exact mirror — they still owe the owner 20700 EGP", () => {
    // Two members of a 2-party sheet always net to exact negatives.
    expect(viewAs(sheet, MANAGER)).toEqual([{ currency: "EGP", amount_minor: -2070000 }]);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 2 — a father keeps TWO SEPARATE 2-party sheets: father<->wife and
// father<->child. Each partner's chat feeds ONLY their own sheet; the father
// sends a transfer image to each. The two ledgers are independent and must be
// asserted separately (they share the SAR currency but never net together).
// ---------------------------------------------------------------------------
describe("Scenario 2 — father keeps two independent family sheets", () => {
  const FATHER = "father";
  const WIFE = "wife";
  const CHILD = "child";

  // --- Sheet A: father <-> wife ---
  const wifeSheet: SheetMsg[] = [
    // Wife's chat "Groceries 800 SAR" — an expense she wants covered →
    //   father owes wife → credit (wife's frame).
    { created_by: WIFE, payload: confirm({ kind: "iou", direction: "credit", amount: 800, currency: "SAR", note: "Groceries 800 SAR" }) },
    // Wife's chat "School run 200 SAR" — another shared expense → credit.
    { created_by: WIFE, payload: confirm({ kind: "iou", direction: "credit", amount: 200, currency: "SAR", note: "School run 200 SAR" }) },
    // Father's TRANSFER IMAGE to the wife (vision-extracted settlement, model
    //   not unit-runnable): father moved 1000 SAR to her → settlement; the
    //   payer (father) records credit, reducing what he owes her.
    { created_by: FATHER, payload: confirm({ kind: "settlement", direction: "credit", amount: 1000, currency: "SAR", date: "2026-07-10", note: "Transfer to wife" }) },
  ];

  // --- Sheet B: father <-> child ---
  const childSheet: SheetMsg[] = [
    // Child's chat "Books 300 SAR" — expense → father owes child → credit.
    { created_by: CHILD, payload: confirm({ kind: "iou", direction: "credit", amount: 300, currency: "SAR", note: "Books 300 SAR" }) },
    // Child's chat "Bus card 150 SAR" — expense → credit.
    { created_by: CHILD, payload: confirm({ kind: "iou", direction: "credit", amount: 150, currency: "SAR", note: "Bus card 150 SAR" }) },
    // Father's TRANSFER IMAGE to the child (vision-extracted settlement): 400
    //   SAR → settlement, credit (reduces what he owes the child).
    { created_by: FATHER, payload: confirm({ kind: "settlement", direction: "credit", amount: 400, currency: "SAR", date: "2026-07-10", note: "Transfer to child" }) },
  ];

  it("father<->wife sheet: 1000 in expenses fully covered by a 1000 transfer → settled", () => {
    // 800 + 200 owed by father, then a 1000 transfer → nets to exactly zero,
    // and a currency that nets to zero is DROPPED from the balance array.
    expect(viewAs(wifeSheet, FATHER)).toEqual([]);
  });

  it("father<->child sheet: 450 in expenses minus a 400 transfer → father still owes 50 SAR", () => {
    const childView = viewAs(childSheet, FATHER);
    expect(childView).toEqual([{ currency: "SAR", amount_minor: -5000 }]); // negative = father owes child
    expect(formatMinor(childView[0].amount_minor, "SAR")).toBe("-50.00 SAR");
  });

  it("the two sheets are INDEPENDENT ledgers, computed on separate arrays", () => {
    // Both sheets use SAR, yet they never net against each other: the wife
    // sheet is fully settled while the child sheet still owes 50 SAR. Each is
    // computed from its OWN array — the ledgers are not concatenated.
    expect(viewAs(wifeSheet, FATHER)).toEqual([]);
    expect(viewAs(childSheet, FATHER)).toEqual([{ currency: "SAR", amount_minor: -5000 }]);

    // The child (viewing their own sheet) sees the exact mirror: owed 50 SAR.
    expect(viewAs(childSheet, CHILD)).toEqual([{ currency: "SAR", amount_minor: 5000 }]);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO 3 — the ROUTING guarantee, end to end. Same father with two chats
// and two sheets as Scenario 2, but here every draft arrives in ONE mixed inbox
// tagged with its source chatKey (as the OpenChat action-inbox actually
// delivers them). We route each draft with the REAL predicate SheetPage uses
// (draftBelongsOnSheet), then compute each sheet's balance from ONLY the drafts
// that routed to it. This proves "each message in a different chat heads to the
// correct sheet" — misrouting would corrupt exactly one of the two balances.
// ---------------------------------------------------------------------------
describe("Scenario 3 — one father, two chats, two sheets: drafts route correctly", () => {
  const FATHER = "father";
  const WIFE = "wife";
  const CHILD = "child";

  // The father pinned each chat to its sheet (LinkChatPage → set_chat_sheet_link).
  const SHEET_WIFE = "aaaaaaaaaaaaaaaa";
  const SHEET_CHILD = "bbbbbbbbbbbbbbbb";
  const CHAT_WIFE = "direct:wife-user-id";
  const CHAT_CHILD = "direct:child-user-id";
  const links: ChatSheetLinks = { [CHAT_WIFE]: SHEET_WIFE, [CHAT_CHILD]: SHEET_CHILD };

  // One inbox draft: which chat it came from + who authored it + its payload.
  type InboxDraft = { chat: string; msg: SheetMsg };

  // A single interleaved inbox — wife's and child's messages arrive mixed, as
  // they would in real time. Deliberately shuffled to defeat any ordering luck.
  const inbox: InboxDraft[] = [
    { chat: CHAT_WIFE, msg: { created_by: WIFE, payload: confirm({ kind: "iou", direction: "credit", amount: 800, currency: "SAR", note: "Groceries 800 SAR" }) } },
    { chat: CHAT_CHILD, msg: { created_by: CHILD, payload: confirm({ kind: "iou", direction: "credit", amount: 300, currency: "SAR", note: "Books 300 SAR" }) } },
    { chat: CHAT_WIFE, msg: { created_by: WIFE, payload: confirm({ kind: "iou", direction: "credit", amount: 200, currency: "SAR", note: "School run 200 SAR" }) } },
    { chat: CHAT_CHILD, msg: { created_by: CHILD, payload: confirm({ kind: "iou", direction: "credit", amount: 150, currency: "SAR", note: "Bus card 150 SAR" }) } },
    { chat: CHAT_WIFE, msg: { created_by: FATHER, payload: confirm({ kind: "settlement", direction: "credit", amount: 1000, currency: "SAR", date: "2026-07-10", note: "Transfer to wife" }) } },
    { chat: CHAT_CHILD, msg: { created_by: FATHER, payload: confirm({ kind: "settlement", direction: "credit", amount: 400, currency: "SAR", date: "2026-07-10", note: "Transfer to child" }) } },
  ];

  // Route the mixed inbox onto a sheet using the production predicate.
  const routeTo = (sheetId: string): SheetMsg[] =>
    inbox.filter((d) => draftBelongsOnSheet(d.chat, links, sheetId)).map((d) => d.msg);

  it("each sheet receives ONLY its own chat's drafts (3 each, none crossed)", () => {
    const onWife = routeTo(SHEET_WIFE);
    const onChild = routeTo(SHEET_CHILD);
    expect(onWife).toHaveLength(3);
    expect(onChild).toHaveLength(3);
    // No wife-authored draft leaked onto the child sheet and vice-versa.
    expect(onWife.every((m) => m.created_by !== CHILD)).toBe(true);
    expect(onChild.every((m) => m.created_by !== WIFE)).toBe(true);
    // Every draft was placed exactly once.
    expect(onWife.length + onChild.length).toBe(inbox.length);
  });

  it("routed balances match the hand-partitioned Scenario 2 result", () => {
    // Wife sheet nets to zero (settled); child sheet leaves father owing 50 SAR.
    // If a single draft had been misrouted, one of these would be wrong.
    expect(viewAs(routeTo(SHEET_WIFE), FATHER)).toEqual([]);
    expect(viewAs(routeTo(SHEET_CHILD), FATHER)).toEqual([{ currency: "SAR", amount_minor: -5000 }]);
    expect(formatMinor(viewAs(routeTo(SHEET_CHILD), FATHER)[0].amount_minor, "SAR")).toBe("-50.00 SAR");
  });

  it("re-pinning a chat to the OTHER sheet moves its drafts off the original sheet", () => {
    // Sanity: the routing actually drives placement. If the father wrongly
    // pinned the wife's chat to the child sheet, ALL of the wife's drafts leave
    // her sheet (it goes empty) and pile onto the child sheet.
    const wrong: ChatSheetLinks = { [CHAT_WIFE]: SHEET_CHILD, [CHAT_CHILD]: SHEET_CHILD };
    const onWife = inbox.filter((d) => draftBelongsOnSheet(d.chat, wrong, SHEET_WIFE)).map((d) => d.msg);
    const onChild = inbox.filter((d) => draftBelongsOnSheet(d.chat, wrong, SHEET_CHILD)).map((d) => d.msg);
    expect(onWife).toHaveLength(0); // wife sheet stripped of its drafts
    expect(onChild).toHaveLength(6); // everything piled onto the child sheet
    // The wife sheet's balance is now empty because it has no entries — the
    // -50 the child sheet shows no longer means what it did (it now also hides
    // the wife's fully-settled 0). Misrouting is structurally visible.
    expect(viewAs(onWife, FATHER)).toEqual([]);
  });
});
