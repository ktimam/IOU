import { describe, it, expect } from "vitest";
import {
  sheetIdToNat64,
  nat64ToSheetId,
  readCachedLinks,
  writeCachedLinks,
  draftBelongsOnSheet,
  type ChatSheetLinks,
} from "./chatSheetLinks";

// IOU sheet ids are 16 hex chars (8 raw_rand bytes from now_id()), so the
// canister can store them as a nat64. These tests pin the loss-free mapping.
describe("chatSheetLinks sheet id ↔ nat64", () => {
  it("round-trips 16-hex-char sheet ids", () => {
    for (const id of ["0000000000000000", "00000000000000ff", "1234567890abcdef", "ffffffffffffffff"]) {
      expect(nat64ToSheetId(sheetIdToNat64(id))).toBe(id);
    }
  });

  it("pads small values back to 16 chars", () => {
    expect(nat64ToSheetId(255n)).toBe("00000000000000ff");
  });

  it("rejects ids that are not 16 lowercase hex chars", () => {
    for (const bad of ["", "1234", "1234567890ABCDEF", "1234567890abcdef0", "not-a-sheet-id!!"]) {
      expect(() => sheetIdToNat64(bad)).toThrow();
    }
  });

  it("rejects out-of-range nat64 values", () => {
    expect(() => nat64ToSheetId(-1n)).toThrow();
    expect(() => nat64ToSheetId(0x10000000000000000n)).toThrow();
  });
});

describe("chatSheetLinks local cache", () => {
  it("round-trips through localStorage when available, and never throws without it", () => {
    const links = { "group:abc": "1234567890abcdef" };
    writeCachedLinks(links);
    const back = readCachedLinks();
    // In environments without localStorage (plain Node), the cache is empty
    // but the calls are safe; with localStorage it round-trips.
    if (globalThis.localStorage) {
      expect(back).toEqual(links);
    } else {
      expect(back).toEqual({});
    }
  });

  it("filters malformed cached values instead of propagating them", () => {
    if (!globalThis.localStorage) return;
    globalThis.localStorage.setItem(
      "iou.openchat.chatSheetLinks.v1",
      JSON.stringify({ good: "1234567890abcdef", bad: 42, worse: "nope" }),
    );
    expect(readCachedLinks()).toEqual({ good: "1234567890abcdef" });
  });
});

// The routing guarantee the user asked to pin: ONE user with MULTIPLE sheets and
// MULTIPLE chats — each chat's drafts must land on (only) its own mapped sheet.
// draftBelongsOnSheet is the exact predicate SheetPage's visible-inbox uses.
describe("chatSheetLinks routing — each chat → its own sheet", () => {
  const SHEET_WIFE = "aaaaaaaaaaaaaaaa";
  const SHEET_CHILD = "bbbbbbbbbbbbbbbb";
  const CHAT_WIFE = "direct:wife-user-id";
  const CHAT_CHILD = "direct:child-user-id";
  // father pinned wife's chat → wife sheet, child's chat → child sheet.
  const links: ChatSheetLinks = { [CHAT_WIFE]: SHEET_WIFE, [CHAT_CHILD]: SHEET_CHILD };

  it("a chat's draft shows ONLY on its mapped sheet, not the other", () => {
    // wife's message is visible on the wife sheet…
    expect(draftBelongsOnSheet(CHAT_WIFE, links, SHEET_WIFE)).toBe(true);
    // …and hidden on the child sheet.
    expect(draftBelongsOnSheet(CHAT_WIFE, links, SHEET_CHILD)).toBe(false);
    // child's message: mirror image.
    expect(draftBelongsOnSheet(CHAT_CHILD, links, SHEET_CHILD)).toBe(true);
    expect(draftBelongsOnSheet(CHAT_CHILD, links, SHEET_WIFE)).toBe(false);
  });

  it("partitions a mixed inbox so no draft crosses sheets", () => {
    const inbox = [
      { chat: CHAT_WIFE, amount: 50 },
      { chat: CHAT_CHILD, amount: 30 },
      { chat: CHAT_WIFE, amount: 20 },
    ];
    const onWife = inbox.filter((d) => draftBelongsOnSheet(d.chat, links, SHEET_WIFE));
    const onChild = inbox.filter((d) => draftBelongsOnSheet(d.chat, links, SHEET_CHILD));
    expect(onWife.map((d) => d.amount)).toEqual([50, 20]);
    expect(onChild.map((d) => d.amount)).toEqual([30]);
    // Every draft lands on exactly one sheet — none dropped, none duplicated.
    expect(onWife.length + onChild.length).toBe(inbox.length);
  });

  it("an UNMAPPED chat's draft is visible on every sheet (so the user can pick)", () => {
    const unmapped = "direct:someone-new";
    expect(draftBelongsOnSheet(unmapped, links, SHEET_WIFE)).toBe(true);
    expect(draftBelongsOnSheet(unmapped, links, SHEET_CHILD)).toBe(true);
  });

  it("a wrapper-less draft (no chat key) is visible everywhere", () => {
    for (const key of [null, undefined, ""]) {
      expect(draftBelongsOnSheet(key, links, SHEET_WIFE)).toBe(true);
      expect(draftBelongsOnSheet(key, links, SHEET_CHILD)).toBe(true);
    }
  });
});
