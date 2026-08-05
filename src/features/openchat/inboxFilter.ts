// Which pending chat cards belong on THIS sheet?
//
// Extracted from the SheetPage render filter that computed `visibleInbox` inline. Every predicate it
// calls was already unit-tested; the WIRING was not, and the wiring is where the bug actually lived —
// a draft linked to one app-scoped chat handle must not appear on unrelated sheets.
//
// The three questions, in the order they are cheapest to answer:
//   1. ROUTING — placeDraftOnSheet uses OpenChat's stable app-scoped chat handle.
//   2. DISMISSED BY ANY MEMBER — the merged pair-slot union. One member's ✕ clears both lists.
//   3. IMPORTED BY ANY MEMBER — matched against the sheet's decrypted entries: import_message_id for
//      mid-bearing cards, the derived content-hash draft_id only for wrapper-less ones.
// Finally a double-confirm race can surface two cards for one message handle; collapse to the first.

import { collapseByMessageHandle, isImportedIntoSheet } from "./inboxDedupe";
import { placeDraftOnSheet } from "./draftVisibility";
import { parseDraftBatch, type DraftBaseResolver } from "../entries/draft";
import type { ChatSheetLinks } from "./chatSheetLinks";

/** The pending-card shape this filter reads (PendingDraft, narrowed to what it needs). */
export type InboxCard = {
  draft: unknown;
  context?: { chatHandle?: string; messageHandle?: string };
};

/** The sheet's decrypted entries, narrowed to the two idempotency keys. */
export type ImportedEntry = {
  deleted: boolean;
  payload: { draft_id?: string; import_message_id?: string };
};

export type VisibleInboxInput<T extends InboxCard> = {
  /** Everything the on-chain inbox poll has produced for this user (all sheets). */
  inboxPending: T[];
  /** app-scoped chat handle -> sheet id, as the viewer pinned it. */
  chatLinks: ChatSheetLinks;
  /** The sheet being rendered. */
  sheetId: string;
  /** This sheet's decrypted entries (the cross-member "already imported" evidence). */
  entries: ImportedEntry[];
  /** App-scoped message handles dismissed by ANY member. */
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
  return collapseByMessageHandle(
    inboxPending.filter((p) => {
      if (placeDraftOnSheet({ context: p.context, chatLinks, sheetId }) === "hidden") return false;
      const messageHandle = p.context?.messageHandle;
      if (messageHandle !== undefined && dismissed.has(messageHandle)) return false;
      // Only wrapper-less cards need the parsed draftId (the fallback key); mid-bearing cards match
      // exclusively on import_message_id, so skip the parse for them. A multi-entry wrapper-less card
      // keys off its FIRST entry's draftId.
      let draftId: string | undefined;
      if (messageHandle === undefined) {
        const parsed = parseDraftBatch(p.draft, resolveTemplateBase, defaultCurrency);
        draftId = parsed.drafts[0]?.draftId;
      }
      return !isImportedIntoSheet(entries, messageHandle, draftId);
    }),
  );
}
