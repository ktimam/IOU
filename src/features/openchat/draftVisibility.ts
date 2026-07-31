// Where does an inbox draft belong, and whose is it?
//
// Extracted from an inline SheetPage render filter — which is why the bug below was never caught by a
// test: there was no seam to write one against.
//
// THE BUG. A direct-chat key is VIEWER-RELATIVE: each side names the OTHER participant. OpenChat builds
// the deposit in the CONFIRMER's canister (`Chat::Direct(args.user_id)`) and fans the SAME context out
// to every recipient, so a partner's copy carries a key that names ME and matches nothing I linked. It
// then reads as "unpinned", and unpinned deliberately means "show on every sheet" — which is how the
// child's drafts turned up pending on the father's House sheet.
//
// WHAT THAT COPY IS FOR. The fan-out is a claim ticket handed to both members, of which exactly one is
// redeemed: importing writes `import_message_id` into the SHARED entry, and `isImportedIntoSheet` then
// self-cancels the other member's copy. That check is sheet-scoped, so a ticket stranded on the wrong
// sheet can never see the import and sits there for good. Routing it correctly is what lets the
// existing machinery clear it.
//
// TWO LAYERS, deliberately separable:
//
//   Layer 0 — ROUTING (no identity required, so it works for every user today). Canonicalize the key
//     to the one THIS viewer would have linked. The confirmer's id is the missing half: a key I have
//     not linked, from a confirmer whose chat I HAVE linked, is that chat seen from their side.
//
//   Layer 1 — ATTRIBUTION (needs the viewer's own OpenChat id, which IOU does not yet learn). A draft
//     someone else confirmed is not mine to add — the entry lands in the shared sheet either way — so
//     it is DEMOTED, never deleted. Deleting would break three real paths: confirming has no app-key
//     gate (a confirmer with no IOU key leaves the partner as the only recipient), deleting an imported
//     entry deliberately resurrects the card for whoever did not import it, and a group card's
//     recipient set is frozen at propose time so the confirmer may share no sheet at all.
//
// Layer 1 FAILS OPEN. With no viewer id, nothing is demoted. A wrong or missing `me` must never empty
// a pending list — that failure is worse than the bug being fixed.

import { draftBelongsOnSheet, type ChatSheetLinks } from "./chatSheetLinks";

const DIRECT = "direct:";

/**
 * The chat key as THIS viewer would have linked it.
 *
 * Only ever returns a key the viewer actually has, or the original — it never invents a link. Group
 * and channel keys are already viewer-independent, so they pass through untouched.
 */
export function resolveChatKey(
  chat: string | undefined,
  confirmedBy: string | undefined,
  links: ChatSheetLinks,
): string | undefined {
  if (!chat) return chat;
  if (links[chat] !== undefined) return chat; // already mine
  if (!chat.startsWith(DIRECT)) return chat; // group/channel: not viewer-relative
  const author = confirmedBy?.trim();
  if (!author) return chat;
  // Their side of a direct chat names me; my side names them.
  const mine = `${DIRECT}${author}`;
  return links[mine] !== undefined ? mine : chat;
}

/** primary = the user's own pending work · secondary = someone else's, shown but de-emphasised. */
export type DraftPlacement = "primary" | "secondary" | "hidden";

export type DraftPlacementInput = {
  /** The v2 envelope context. Absent for pre-v2 wrapper-less deposits, which carry no provenance. */
  context?: { chat?: string; confirmedBy?: string };
  /** chat key -> sheet id, as the viewer has pinned them. */
  chatLinks: ChatSheetLinks;
  /** The sheet being rendered. */
  sheetId: string;
  /** The viewer's own OpenChat user id, when known. Undefined disables attribution (fails open). */
  viewerOcUserId?: string;
};

export function placeDraftOnSheet({
  context,
  chatLinks,
  sheetId,
  viewerOcUserId,
}: DraftPlacementInput): DraftPlacement {
  const confirmedBy = context?.confirmedBy?.trim() ?? "";
  const chat = resolveChatKey(context?.chat, confirmedBy, chatLinks);

  // Layer 0 first: a draft that belongs to another sheet is not shown here at all, whoever confirmed it.
  if (!draftBelongsOnSheet(chat, chatLinks, sheetId)) return "hidden";

  // Layer 1: both halves must be known before a draft can be called someone else's.
  const me = viewerOcUserId?.trim() ?? "";
  if (confirmedBy !== "" && me !== "" && confirmedBy !== me) return "secondary";
  return "primary";
}
