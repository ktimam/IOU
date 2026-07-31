// The viewer's own OpenChat user id — the one thing a fanned-out deposit does NOT carry.
//
// A confirmed action is delivered to every member of the chat, each envelope carrying
// `context.confirmedBy`. That answers "who confirmed this", but nothing in the envelope answers "which
// of those is me": IOU authenticates with its OWN principal, and Internet Identity issues a different
// principal per origin, so IOU's principal is never the user's OpenChat principal. The only moment the
// two identities are proven to belong to the same person is the 6-digit claim, where the user holds
// both sides — so that is where this is learned (claim_ai_app_link_code now returns the claiming id).
//
// Scoped to the IOU principal that paired: a different IOU account on the same device must not inherit
// it, or every draft would be attributed to the wrong person. Cleared on disconnect, because the id is
// only meaningful for the delivery key OpenChat currently holds.
//
// NOT used for routing — that works without any identity (see draftVisibility.resolveChatKey). This
// exists so an attribution check can be added later with no further OpenChat change.

const KEY_PREFIX = "iou.openchat.viewerUserId.v1";

function key(iouPrincipal: string): string {
  return `${KEY_PREFIX}.${iouPrincipal}`;
}

export function rememberOpenChatUserId(iouPrincipal: string, openChatUserId: string): void {
  if (!iouPrincipal || !openChatUserId) return;
  try {
    globalThis.localStorage?.setItem(key(iouPrincipal), openChatUserId);
  } catch {
    /* quota / disabled — non-fatal, attribution simply stays unavailable */
  }
}

/** The viewer's OpenChat user id, or undefined when this account has never completed a claim. */
export function readOpenChatUserId(iouPrincipal: string): string | undefined {
  if (!iouPrincipal) return undefined;
  try {
    return globalThis.localStorage?.getItem(key(iouPrincipal)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function forgetOpenChatUserId(iouPrincipal: string): void {
  try {
    globalThis.localStorage?.removeItem(key(iouPrincipal));
  } catch {
    /* non-fatal */
  }
}
