import { describe, it, expect } from "vitest";
import { resolveChatKey, placeDraftOnSheet } from "./draftVisibility";

// Why this file exists.
//
// A draft confirmed by the CHILD showed up as pending on EVERY one of the father's sheets — House
// included — even though he had linked that chat to the FatherChild sheet. It was never catchable by
// a unit test, because the decision lived inline in a SheetPage render filter
// (`if (!draftBelongsOnSheet(p.context?.chat, chatLinks, sheetId)) return false;`) with no seam.
//
// ROOT CAUSE. A direct-chat key is VIEWER-RELATIVE: each side names the OTHER participant. OpenChat
// builds the deposit in the CONFIRMER's canister (`Chat::Direct(args.user_id)`) and fans the SAME
// context out to everyone, so the father receives `direct:<father>` while his own link is keyed
// `direct:<child>`. The keys can never match, the chat reads as UNPINNED, and unpinned deliberately
// means "show on every sheet".
//
// WHAT THE COPY IS FOR — and why it must not simply be hidden. The fan-out is a claim ticket handed to
// both members, of which exactly one is redeemed: importing writes `import_message_id` into the SHARED
// entry, and `isImportedIntoSheet` then self-cancels the other member's copy. That check is
// sheet-scoped, so a stranded ticket on House can never see the child's import and sits there forever.
// Deleting foreign tickets outright would break three real paths: confirming has no app-key gate (a
// confirmer with no IOU key leaves the partner as the ONLY recipient), deleting an imported entry
// deliberately resurrects the card for whoever did not import it, and a group card's recipient set is
// frozen at propose time so the confirmer may share no sheet at all. Hence: route it correctly, and
// DEMOTE rather than delete.

const FATHER = "father-oc-id";
const CHILD = "child-oc-id";
const MOTHER = "mother-oc-id";

const FC_SHEET = "c819f76d77f260b3"; // FatherChild
const HOUSE_SHEET = "1ac9c9c2d4b54061"; // House

// The father linked HIS view of the chat with the child.
const FATHER_LINKS = { [`direct:${CHILD}`]: FC_SHEET };

describe("resolveChatKey — canonicalize a viewer-relative key, WITHOUT knowing who I am", () => {
  it("rewrites a partner's key to the one this viewer actually linked", () => {
    // The reported bug in one line: the deposit says `direct:<father>`, the father linked
    // `direct:<child>`, and the confirmer's id is the missing half of the translation.
    expect(resolveChatKey(`direct:${FATHER}`, CHILD, FATHER_LINKS)).toBe(`direct:${CHILD}`);
  });

  it("leaves a key the viewer already linked untouched", () => {
    expect(resolveChatKey(`direct:${CHILD}`, FATHER, FATHER_LINKS)).toBe(`direct:${CHILD}`);
  });

  it("never invents a link that does not exist", () => {
    // An unlinked chat must stay unlinked — the translation only ever picks a key the viewer HAS.
    expect(resolveChatKey(`direct:${FATHER}`, "stranger", FATHER_LINKS)).toBe(`direct:${FATHER}`);
  });

  it("leaves group keys alone (they are already viewer-independent)", () => {
    const links = { "group:aaaaa-aa": FC_SHEET };
    expect(resolveChatKey("group:aaaaa-aa", CHILD, links)).toBe("group:aaaaa-aa");
  });

  it("copes with a missing chat or confirmer", () => {
    expect(resolveChatKey(undefined, CHILD, FATHER_LINKS)).toBeUndefined();
    expect(resolveChatKey(`direct:${FATHER}`, undefined, FATHER_LINKS)).toBe(`direct:${FATHER}`);
  });
});

describe("placeDraftOnSheet — the reported bug", () => {
  const childsDraft = { chat: `direct:${FATHER}`, confirmedBy: CHILD };

  it("is HIDDEN on House — it belongs to the linked sheet, not everywhere", () => {
    expect(
      placeDraftOnSheet({ context: childsDraft, chatLinks: FATHER_LINKS, sheetId: HOUSE_SHEET, viewerOcUserId: FATHER }),
    ).toBe("hidden");
  });

  it("is hidden on House even when the viewer's own id is UNKNOWN", () => {
    // The routing layer needs no identity, so the reported symptom is fixed for every user today —
    // including those paired before IOU could learn its own OpenChat id.
    expect(
      placeDraftOnSheet({ context: childsDraft, chatLinks: FATHER_LINKS, sheetId: HOUSE_SHEET }),
    ).toBe("hidden");
  });

  it("is DEMOTED (not deleted) on the sheet it actually belongs to", () => {
    // Someone else confirmed it, so it is not the father's to add — but it stays reachable, because
    // it is the only remaining path to the ledger if the child never imports it.
    expect(
      placeDraftOnSheet({ context: childsDraft, chatLinks: FATHER_LINKS, sheetId: FC_SHEET, viewerOcUserId: FATHER }),
    ).toBe("secondary");
  });

  it("is PRIMARY on that sheet while the viewer's id is unknown (attribution fails open)", () => {
    // A wrong or missing `me` must never empty the pending list; it can only fail to demote.
    expect(
      placeDraftOnSheet({ context: childsDraft, chatLinks: FATHER_LINKS, sheetId: FC_SHEET }),
    ).toBe("primary");
  });
});

describe("placeDraftOnSheet — the viewer's OWN drafts are unaffected", () => {
  const mine = { chat: `direct:${CHILD}`, confirmedBy: FATHER };

  it("is primary on the linked sheet", () => {
    expect(
      placeDraftOnSheet({ context: mine, chatLinks: FATHER_LINKS, sheetId: FC_SHEET, viewerOcUserId: FATHER }),
    ).toBe("primary");
  });

  it("is hidden on a sheet the chat is not linked to", () => {
    expect(
      placeDraftOnSheet({ context: mine, chatLinks: FATHER_LINKS, sheetId: HOUSE_SHEET, viewerOcUserId: FATHER }),
    ).toBe("hidden");
  });

  it("from an UNLINKED chat is primary everywhere, so the user can choose where it lands", () => {
    const unlinked = { chat: "direct:someone-new", confirmedBy: FATHER };
    for (const sheetId of [FC_SHEET, HOUSE_SHEET]) {
      expect(placeDraftOnSheet({ context: unlinked, chatLinks: FATHER_LINKS, sheetId, viewerOcUserId: FATHER })).toBe(
        "primary",
      );
    }
  });

  it("with no context at all is primary everywhere (pre-v2 wrapper-less deposit)", () => {
    expect(placeDraftOnSheet({ chatLinks: FATHER_LINKS, sheetId: HOUSE_SHEET, viewerOcUserId: FATHER })).toBe(
      "primary",
    );
  });
});

describe("placeDraftOnSheet — the hub topology that makes direct-chat keys ambiguous", () => {
  // Everyone chatting with the father keys that chat `direct:<father>`, so routing alone cannot tell
  // the mother's draft from the child's. The confirmer's id is what disambiguates the translation.
  const childLinks = {
    [`direct:${FATHER}`]: FC_SHEET, // the child's link to the father
  };

  it("routes by the CONFIRMER, so a third party's draft cannot land on the child's sheet", () => {
    // The mother confirms in HER chat with the father; her deposit also carries `direct:<father>`,
    // which the child HAS linked. Translation must not fire on a key that is already linked — but
    // attribution still demotes it, because the child did not confirm it.
    expect(
      placeDraftOnSheet({
        context: { chat: `direct:${FATHER}`, confirmedBy: MOTHER },
        chatLinks: childLinks,
        sheetId: FC_SHEET,
        viewerOcUserId: CHILD,
      }),
    ).toBe("secondary");
  });

  it("keeps the child's own draft primary in that same-keyed chat", () => {
    expect(
      placeDraftOnSheet({
        context: { chat: `direct:${FATHER}`, confirmedBy: CHILD },
        chatLinks: childLinks,
        sheetId: FC_SHEET,
        viewerOcUserId: CHILD,
      }),
    ).toBe("primary");
  });
});
