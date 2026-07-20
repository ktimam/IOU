// Chat → sheet mapping for OpenChat-delivered drafts (delivery provenance).
//
// The v2 inbox envelope carries the source chat key (see actionInboxClient's
// InboxDraftContext). The user can pin "always import this chat's drafts into
// this sheet"; the mapping is CANISTER-BACKED (set_chat_sheet_link /
// remove_chat_sheet_link / chat_sheet_links — caller-keyed, so it follows the
// user across devices) with localStorage as an optimistic cache.
//
// The canister stores sheet_id as a nat64: IOU sheet ids are 16 hex chars
// (8 raw_rand bytes from now_id()), so the string ↔ u64 mapping is loss-free.
// The chat key is opaque text end to end.

const LS_KEY = "iou.openchat.chatSheetLinks.v1";

/** chat key → sheet id (16-hex-char string), both as the app uses them. */
export type ChatSheetLinks = Record<string, string>;

const SHEET_ID_RE = /^[0-9a-f]{16}$/;

/** Encode a 16-hex-char sheet id as the canister's nat64. Throws on other shapes. */
export function sheetIdToNat64(sheetId: string): bigint {
  if (!SHEET_ID_RE.test(sheetId)) {
    throw new Error(`sheet id is not a 16-hex-char string: ${JSON.stringify(sheetId)}`);
  }
  return BigInt("0x" + sheetId);
}

/** Decode the canister's nat64 back into the 16-hex-char sheet id. */
export function nat64ToSheetId(v: bigint): string {
  if (v < 0n || v > 0xffffffffffffffffn) {
    throw new Error(`sheet id nat64 out of range: ${v}`);
  }
  return v.toString(16).padStart(16, "0");
}

/**
 * Routing predicate: should a chat-delivered draft be shown/importable on the
 * sheet with id `sheetId`?  A draft belongs on this sheet iff
 *   - it has no source chat key (wrapper-less deposit — visible everywhere), OR
 *   - its chat isn't pinned to any sheet yet (unmapped — visible everywhere so
 *     the user can pick where it lands), OR
 *   - its chat is pinned to THIS sheet.
 * A draft whose chat is pinned to a DIFFERENT sheet is routed away from here.
 * This is the single source of truth for "each chat's messages head to the
 * correct sheet" — SheetPage's visible-inbox filter calls it.
 */
export function draftBelongsOnSheet(
  chatKey: string | null | undefined,
  links: ChatSheetLinks,
  sheetId: string,
): boolean {
  if (!chatKey) return true;
  const mapped = links[chatKey];
  if (!mapped) return true;
  return mapped === sheetId;
}

/**
 * Re-point every chat mapping that targets `oldSheetId` onto `newSheetId`. Used when a sheet is
 * closed & rotated ("Close & start new") so the next confirmed draft from a pinned chat imports into
 * the fresh (active) sheet instead of the read-only archived one. Returns the updated map plus the
 * chat keys that moved (empty + the SAME map reference when nothing pointed at oldSheetId).
 */
export function repointChatLinks(
  links: ChatSheetLinks,
  oldSheetId: string,
  newSheetId: string,
): { next: ChatSheetLinks; affected: string[] } {
  const affected = Object.keys(links).filter((k) => links[k] === oldSheetId);
  if (affected.length === 0) return { next: links, affected };
  const next = { ...links };
  for (const k of affected) next[k] = newSheetId;
  return { next, affected };
}

export function readCachedLinks(): ChatSheetLinks {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: ChatSheetLinks = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" && SHEET_ID_RE.test(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeCachedLinks(links: ChatSheetLinks): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(links));
  } catch {
    /* non-persistent contexts still work for the session */
  }
}

type RawLink = { chat_key: string; sheet_id: bigint };

/**
 * Fetch the caller's links from the canister and refresh the cache.
 * `actor` is the authenticated backend actor (src/backend/declarations.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchChatSheetLinks(actor: any): Promise<ChatSheetLinks> {
  const raw = (await actor.chat_sheet_links()) as RawLink[];
  const out: ChatSheetLinks = {};
  for (const l of raw ?? []) {
    try {
      out[l.chat_key] = nat64ToSheetId(BigInt(l.sheet_id));
    } catch {
      /* skip a malformed record rather than break the whole map */
    }
  }
  writeCachedLinks(out);
  return out;
}

/** Upsert a mapping on the canister (the caller updates the cache optimistically). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function storeChatSheetLink(actor: any, chatKey: string, sheetId: string): Promise<void> {
  await actor.set_chat_sheet_link(chatKey, sheetIdToNat64(sheetId));
}

/** Remove a mapping on the canister. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function removeChatSheetLink(actor: any, chatKey: string): Promise<void> {
  await actor.remove_chat_sheet_link(chatKey);
}
