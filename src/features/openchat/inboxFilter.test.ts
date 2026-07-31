// visibleInboxFor — the SheetPage wiring that decides which chat cards a sheet shows.
//
// WHY A SECOND FILE when placeDraftOnSheet is already covered. The reported bug ("the child's drafts
// are pending on the father's House sheet, and on House etc") was never a bug INSIDE a predicate: the
// predicates were right, the call site asked the wrong question. It passed the raw chat key with no
// confirmer, so a partner's fanned-out copy — keyed from THEIR side, naming the father — matched
// nothing the father had linked, read as "unpinned", and unpinned means "show on every sheet".
//
// That call site is the only caller of placeDraftOnSheet. Dropping `confirmedBy` from the argument,
// or reverting to the old chat-only predicate, restores the bug with every other unit test still
// green — draftVisibility.test.ts keeps passing, because the function it tests is untouched. So this
// file tests the WIRING: the same real card, asked about three different sheets.

import { describe, it, expect } from "vitest";
import { visibleInboxFor, type InboxCard, type ImportedEntry } from "./inboxFilter";
import { parseDraftBatch } from "../entries/draft";

const FATHER = "father-oc-id";
const CHILD = "child-oc-id";

const FC_SHEET = "c819f76d77f260b3"; // the father↔child sheet, the one HE linked that chat to
const HOUSE_SHEET = "1ac9c9c2d4b54061"; // House — where the drafts wrongly appeared
const OTHER_SHEET = "0000000000000000"; // "…etc": any other sheet the father owns

// The father's view: he linked his side of the chat with the child.
const FATHER_LINKS = { [`direct:${CHILD}`]: FC_SHEET };

// The card as it reaches the FATHER: OpenChat built it in the child's canister, so the chat key names
// the father and the confirmer is the child.
const CHILDS_CARD: InboxCard & { id: string } = {
  id: "1",
  context: { chat: `direct:${FATHER}`, confirmedBy: CHILD, messageId: "m1" },
  draft: { amount: 10, currency: "USD" },
};

function visible<T extends InboxCard>(
  sheetId: string,
  over: Partial<Parameters<typeof visibleInboxFor<T>>[0]> = {},
) {
  return visibleInboxFor({
    inboxPending: [CHILDS_CARD] as unknown as T[],
    chatLinks: FATHER_LINKS,
    sheetId,
    entries: [] as ImportedEntry[],
    dismissed: new Set<string>(),
    resolveTemplateBase: () => undefined,
    defaultCurrency: "USD",
    ...over,
  });
}

describe("visibleInboxFor — the reported bug, at the call site that caused it", () => {
  it("does not show the child's card on House", () => {
    expect(visible(HOUSE_SHEET)).toHaveLength(0);
  });

  it("does not show it on any OTHER sheet either ('House etc')", () => {
    // The symptom was never one sheet: an unpinned card shows on all of them.
    expect(visible(OTHER_SHEET)).toHaveLength(0);
  });

  it("DOES show it on the sheet that chat is linked to", () => {
    // The other half of the fix, and the one a blunt "hide foreign cards" would break: the fan-out
    // copy is a claim ticket, and the ticket has to be redeemable somewhere.
    expect(visible(FC_SHEET)).toHaveLength(1);
  });

  it("keeps an UNLINKED chat's card visible everywhere, so the user can choose where it lands", () => {
    const stranger = { ...CHILDS_CARD, context: { chat: "direct:stranger", confirmedBy: "stranger", messageId: "m9" } };
    for (const sheetId of [FC_SHEET, HOUSE_SHEET, OTHER_SHEET]) {
      expect(visible(sheetId, { inboxPending: [stranger] })).toHaveLength(1);
    }
  });

  it("keeps a wrapper-less (pre-v2) card visible — it carries no provenance to route by", () => {
    const noContext = { id: "2", draft: { amount: 10, currency: "USD" } };
    expect(visible(HOUSE_SHEET, { inboxPending: [noContext] })).toHaveLength(1);
  });
});

describe("visibleInboxFor — the cross-member layers stay wired", () => {
  it("hides a card ANY member dismissed", () => {
    expect(visible(FC_SHEET, { dismissed: new Set(["m1"]) })).toHaveLength(0);
  });

  it("hides a card ANY member already imported (matched on import_message_id)", () => {
    const entries: ImportedEntry[] = [{ deleted: false, payload: { import_message_id: "m1" } }];
    expect(visible(FC_SHEET, { entries })).toHaveLength(0);
    // Deleting that entry deliberately resurrects the card for whoever did not import it.
    expect(visible(FC_SHEET, { entries: [{ deleted: true, payload: { import_message_id: "m1" } }] })).toHaveLength(1);
  });

  it("collapses a double-confirm race to one card per messageId", () => {
    const twin = { ...CHILDS_CARD, id: "2", context: { ...CHILDS_CARD.context!, confirmedBy: FATHER } };
    expect(visible(FC_SHEET, { inboxPending: [CHILDS_CARD, twin] })).toHaveLength(1);
  });
});

describe("visibleInboxFor — the wrapper-less draft_id fallback needs BOTH parse inputs", () => {
  // A pre-v2 card has no messageId, so "already imported" falls back to the content-hash draft_id —
  // which only exists if the draft parses. Both the template resolver and the default currency feed
  // that parse, and dropping either silently turns the fallback off: the card would reappear after a
  // successful import, with nothing failing.
  const CARD = { id: "3", draft: { amount: 10, template: "Reservation" } }; // no currency, no messageId
  const resolveTemplateBase = (raw: unknown) =>
    (raw as { template?: string })?.template === "Reservation"
      ? { currency: "EGP" as const, direction: "credit" as const }
      : undefined;

  function importedEntryFor(defaultCurrency: string, resolver: typeof resolveTemplateBase | (() => undefined)) {
    const id = parseDraftBatch(CARD.draft, resolver, defaultCurrency).drafts[0]?.draftId;
    expect(id, "the fixture itself must parse, or this test proves nothing").toBeDefined();
    return [{ deleted: false, payload: { draft_id: id } }] as ImportedEntry[];
  }

  it("hides the card once its derived draft_id is on the sheet", () => {
    const entries = importedEntryFor("USD", resolveTemplateBase);
    expect(
      visible(HOUSE_SHEET, { inboxPending: [CARD], entries, resolveTemplateBase }),
    ).toHaveLength(0);
  });

  it("derives a DIFFERENT id without the template resolver (so the resolver must be passed through)", () => {
    // The template supplies the currency here, so a dropped resolver changes the hash — the imported
    // entry stops matching and the card comes back.
    const withTemplate = importedEntryFor("USD", resolveTemplateBase);
    expect(
      visible(HOUSE_SHEET, { inboxPending: [CARD], entries: withTemplate, resolveTemplateBase: () => undefined }),
    ).toHaveLength(1);
  });

  it("derives no id at all without the default currency (so it must be passed through)", () => {
    // No currency on the draft, none from a template, none defaulted ⇒ the draft does not parse,
    // there is no draft_id to match, and the card can never self-cancel.
    const entries = importedEntryFor("USD", resolveTemplateBase);
    expect(
      visible(HOUSE_SHEET, {
        inboxPending: [CARD],
        entries,
        resolveTemplateBase: () => undefined,
        defaultCurrency: "",
      }),
    ).toHaveLength(1);
  });
});
