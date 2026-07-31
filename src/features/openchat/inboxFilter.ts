// Which pending chat cards belong on THIS sheet?
//
// Extracted from the SheetPage render filter that computed `visibleInbox` inline. Every predicate it
// calls was already unit-tested; the WIRING was not, and the wiring is where the bug actually lived —
// a draft the child confirmed sat pending on the father's House sheet (and on every other sheet)
// because the filter asked `draftBelongsOnSheet(p.context?.chat, …)` directly, with no confirmer.
// Restoring that one argument, or reverting this call to the raw chat-key predicate, reintroduces the
// report with the whole unit suite green. That is what this seam exists to make impossible.
//
// The three questions, in the order they are cheapest to answer:
//   1. ROUTING — placeDraftOnSheet canonicalizes the viewer-relative direct-chat key via the
//      confirmer, so a partner's fanned-out copy lands on the sheet its chat is pinned to instead of
//      reading as "unpinned" (= show everywhere). `viewerOcUserId` is deliberately NOT passed: IOU
//      does not learn its own OpenChat id yet, so attribution stays inert and this can only ever hide
//      a draft that belongs on another sheet — never one of the viewer's own.
//   2. DISMISSED BY ANY MEMBER — the merged pair-slot union. One member's ✕ clears both lists.
//   3. IMPORTED BY ANY MEMBER — matched against the sheet's decrypted entries: import_message_id for
//      mid-bearing cards, the derived content-hash draft_id only for wrapper-less ones.
// Finally a double-confirm race can surface two cards for one messageId; collapse to the first.

import { collapseByMessageId, isImportedIntoSheet } from "./inboxDedupe";
import { placeDraftOnSheet } from "./draftVisibility";
import { parseDraftBatch, type DraftBaseResolver } from "../entries/draft";
import type { ChatSheetLinks } from "./chatSheetLinks";

/** The pending-card shape this filter reads (PendingDraft, narrowed to what it needs). */
export type InboxCard = {
  draft: unknown;
  context?: { chat?: string; messageId?: string; confirmedBy?: string };
};

/** The sheet's decrypted entries, narrowed to the two idempotency keys. */
export type ImportedEntry = {
  deleted: boolean;
  payload: { draft_id?: string; import_message_id?: string };
};

export type VisibleInboxInput<T extends InboxCard> = {
  /** Everything the on-chain inbox poll has produced for this user (all sheets). */
  inboxPending: T[];
  /** chat key -> sheet id, as the viewer pinned them. */
  chatLinks: ChatSheetLinks;
  /** The sheet being rendered. */
  sheetId: string;
  /** This sheet's decrypted entries (the cross-member "already imported" evidence). */
  entries: ImportedEntry[];
  /** messageIds dismissed by ANY member (the merged pair-slot union). */
  dismissed: Set<string>;
  /** Per-card template resolver — only needed to derive a wrapper-less card's draft_id. */
  resolveTemplateBase: DraftBaseResolver;
  /** The user's IOU default currency, so a currency-less draft still parses far enough to hash. */
  defaultCurrency: string;
};

export function visibleInboxFor<T extends InboxCard>({
  inboxPending,
  chatLinks,
  sheetId,
  entries,
  dismissed,
  resolveTemplateBase,
  defaultCurrency,
}: VisibleInboxInput<T>): T[] {
  return collapseByMessageId(
    inboxPending.filter((p) => {
      if (placeDraftOnSheet({ context: p.context, chatLinks, sheetId }) === "hidden") return false;
      const mid = p.context?.messageId;
      if (mid !== undefined && dismissed.has(mid)) return false;
      // Only wrapper-less cards need the parsed draftId (the fallback key); mid-bearing cards match
      // exclusively on import_message_id, so skip the parse for them. A multi-entry wrapper-less card
      // keys off its FIRST entry's draftId.
      let draftId: string | undefined;
      if (mid === undefined) {
        const parsed = parseDraftBatch(p.draft, resolveTemplateBase, defaultCurrency);
        draftId = parsed.drafts[0]?.draftId;
      }
      return !isImportedIntoSheet(entries, mid, draftId);
    }),
  );
}
