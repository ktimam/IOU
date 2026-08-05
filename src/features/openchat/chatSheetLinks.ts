// App-scoped chat-handle → sheet mapping for OpenChat-delivered drafts.
//
// The v4 inbox envelope carries a UserIndex-issued app-scoped chat handle (see
// actionInboxClient's InboxDraftContext). The user can pin "always import this chat's drafts into
// this sheet"; the mapping is CANISTER-BACKED (set_chat_sheet_link /
// remove_chat_sheet_link / chat_sheet_links — caller-keyed, so it follows the
// user across devices) with localStorage as an optimistic cache.
//
// The canister stores sheet_id as a nat64: IOU sheet ids are 16 hex chars
// (8 raw_rand bytes from now_id()), so the string ↔ u64 mapping is loss-free.
// The stable Candid field is still named chat_key for compatibility, but new values are exactly
// 32-byte app-scoped handles encoded as canonical unpadded base64url. Raw OpenChat coordinates are
// never accepted or persisted.

import { scopedStorageKey } from "../storage/scopedStorage";

const LEGACY_LS_KEY = "iou.openchat.chatSheetLinks.v1";
const LS_KEY = "iou.openchat.chatSheetLinks.v2";

export function chatLinksStorageKey(
  principal: string,
  deployment?: string,
): string {
  return scopedStorageKey(LS_KEY, principal, deployment);
}

/** App-scoped chat handle → sheet id (16-hex-char string), both as the app uses them. */
export type ChatSheetLinks = Record<string, string>;

const SHEET_ID_RE = /^[0-9a-f]{16}$/;
const APP_SCOPED_HANDLE_RE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** Exactly 32 bytes encoded as canonical, unpadded base64url. */
export function isCanonicalAppScopedChatHandle(value: unknown): value is string {
  return typeof value === "string" && APP_SCOPED_HANDLE_RE.test(value);
}

function exactChatSheetLinks(value: unknown): ChatSheetLinks {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: ChatSheetLinks = {};
  for (const [handle, sheetId] of Object.entries(value)) {
    if (isCanonicalAppScopedChatHandle(handle) && typeof sheetId === "string" && SHEET_ID_RE.test(sheetId)) {
      out[handle] = sheetId;
    }
  }
  return out;
}

function requireCanonicalAppScopedChatHandle(value: unknown): asserts value is string {
  if (!isCanonicalAppScopedChatHandle(value)) {
    throw new Error("chat handle must be canonical unpadded base64url for exactly 32 bytes");
  }
}

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
  chatHandle: string | null | undefined,
  links: ChatSheetLinks,
  sheetId: string,
): boolean {
  if (!chatHandle) return true;
  if (!isCanonicalAppScopedChatHandle(chatHandle)) return false;
  const mapped = links[chatHandle];
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

/**
 * Which OTHER chats already import into `sheetId`?
 *
 * Nothing stops several chats pointing at one sheet — links are keyed by (caller, chat key) alone, and
 * that is legitimate (you may want two chats feeding one ledger). But the chooser never said so, so a
 * mis-click was invisible: a father ended up with his child's AND his manager's chats both importing
 * into FatherChild, while the House sheet he believed was linked had nothing pointing at it at all.
 * Surfacing the collision is the honest substitute for a check IOU cannot make — a chat key carries no
 * evidence of which account it belongs to, so the app cannot verify you are linking a chat to the sheet
 * you share with that same person.
 */
export function otherChatsLinkedTo(
  sheetId: string,
  links: ChatSheetLinks,
  thisChatKey: string,
): string[] {
  return Object.keys(links).filter((k) => k !== thisChatKey && links[k] === sheetId);
}

export function readCachedLinks(principal: string | null | undefined): ChatSheetLinks {
  if (!principal) return {};
  try {
    globalThis.localStorage?.removeItem(LEGACY_LS_KEY);
    globalThis.localStorage?.removeItem(scopedStorageKey(LEGACY_LS_KEY, principal));
    const raw = globalThis.localStorage?.getItem(chatLinksStorageKey(principal));
    if (!raw) return {};
    return exactChatSheetLinks(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writeCachedLinks(
  principal: string | null | undefined,
  links: ChatSheetLinks,
): void {
  if (!principal) return;
  try {
    globalThis.localStorage?.removeItem(LEGACY_LS_KEY);
    globalThis.localStorage?.removeItem(scopedStorageKey(LEGACY_LS_KEY, principal));
    globalThis.localStorage?.setItem(
      chatLinksStorageKey(principal),
      JSON.stringify(exactChatSheetLinks(links)),
    );
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
export async function fetchChatSheetLinks(
  actor: any,
  principal: string,
): Promise<ChatSheetLinks> {
  const raw = (await actor.chat_sheet_links()) as RawLink[];
  const out: ChatSheetLinks = {};
  for (const l of raw ?? []) {
    try {
      requireCanonicalAppScopedChatHandle(l.chat_key);
      out[l.chat_key] = nat64ToSheetId(BigInt(l.sheet_id));
    } catch {
      /* skip a malformed record rather than break the whole map */
    }
  }
  writeCachedLinks(principal, out);
  return out;
}

/** Upsert a mapping on the canister (the caller updates the cache optimistically). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function storeChatSheetLink(actor: any, chatHandle: string, sheetId: string): Promise<void> {
  requireCanonicalAppScopedChatHandle(chatHandle);
  await actor.set_chat_sheet_link(chatHandle, sheetIdToNat64(sheetId));
}

/** Remove a mapping on the canister. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function removeChatSheetLink(actor: any, chatHandle: string): Promise<void> {
  requireCanonicalAppScopedChatHandle(chatHandle);
  await actor.remove_chat_sheet_link(chatHandle);
}
