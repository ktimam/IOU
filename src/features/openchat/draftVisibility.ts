// Route verified ActionInbox drafts by OpenChat's app-scoped chat handle.
//
// The handle is a UserIndex HMAC pseudonym shared by every recipient of the same app/chat
// delivery. Unlike the retired raw direct-chat key it is not viewer-relative and exposes no
// OpenChat principal or chat coordinate, so IOU never needs identity translation or attribution.

import { draftBelongsOnSheet, type ChatSheetLinks } from "./chatSheetLinks";

export type DraftPlacement = "primary" | "hidden";

export type DraftPlacementInput = {
  /** Verified v4 context; absent only for local wrapper-less compatibility fixtures. */
  context?: { chatHandle?: string };
  /** App-scoped chat handle -> sheet id. */
  chatLinks: ChatSheetLinks;
  sheetId: string;
};

export function placeDraftOnSheet({
  context,
  chatLinks,
  sheetId,
}: DraftPlacementInput): DraftPlacement {
  return draftBelongsOnSheet(context?.chatHandle, chatLinks, sheetId)
    ? "primary"
    : "hidden";
}
