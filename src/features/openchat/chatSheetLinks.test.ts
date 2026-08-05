import { describe, it, expect, vi } from "vitest";
import {
  sheetIdToNat64,
  nat64ToSheetId,
  readCachedLinks,
  writeCachedLinks,
  draftBelongsOnSheet,
  repointChatLinks,
  type ChatSheetLinks,
  otherChatsLinkedTo,
  chatLinksStorageKey,
  fetchChatSheetLinks,
  isCanonicalAppScopedChatHandle,
  removeChatSheetLink,
  storeChatSheetLink,
} from "./chatSheetLinks";

const CHAT_A = "A".repeat(43);
const CHAT_B = "B".repeat(42) + "E";
const CHAT_C = "C".repeat(42) + "I";

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
  it("isolates cached chat metadata by principal and deployment", () => {
    expect(chatLinksStorageKey("principal-a", "deployment-a")).not.toBe(
      chatLinksStorageKey("principal-b", "deployment-a"),
    );
    expect(chatLinksStorageKey("principal-a", "deployment-a")).not.toBe(
      chatLinksStorageKey("principal-a", "deployment-b"),
    );
  });

  it("round-trips through localStorage when available, and never throws without it", () => {
    const links = { [CHAT_A]: "1234567890abcdef" };
    writeCachedLinks("principal-a", links);
    const back = readCachedLinks("principal-a");
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
      chatLinksStorageKey("principal-a"),
      JSON.stringify({ [CHAT_A]: "1234567890abcdef", "group:raw-id": "1234567890abcdef", [CHAT_B]: 42 }),
    );
    expect(readCachedLinks("principal-a")).toEqual({ [CHAT_A]: "1234567890abcdef" });
  });
});

describe("chatSheetLinks app-scoped handle boundary", () => {
  it("accepts only canonical unpadded base64url encodings of exactly 32 bytes", () => {
    expect(isCanonicalAppScopedChatHandle(CHAT_A)).toBe(true);
    expect(isCanonicalAppScopedChatHandle(CHAT_B)).toBe(true);
    for (const malformed of [
      "",
      "group:raw-openchat-id",
      "A".repeat(42),
      "A".repeat(44),
      "A".repeat(43) + "=",
      "A".repeat(42) + "B", // non-zero base64 pad bits: no canonical 32-byte preimage
      42,
      null,
    ]) {
      expect(isCanonicalAppScopedChatHandle(malformed)).toBe(false);
    }
  });

  it("rejects malformed set/remove handles before calling the actor", async () => {
    const actor = {
      set_chat_sheet_link: vi.fn(),
      remove_chat_sheet_link: vi.fn(),
    };
    await expect(storeChatSheetLink(actor, "direct:raw-user-id", "1234567890abcdef")).rejects.toThrow(
      /chat handle/,
    );
    await expect(removeChatSheetLink(actor, "direct:raw-user-id")).rejects.toThrow(/chat handle/);
    expect(actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(actor.remove_chat_sheet_link).not.toHaveBeenCalled();
  });

  it("passes canonical handles and filters malformed canister rows", async () => {
    const actor = {
      chat_sheet_links: vi.fn(async () => [
        { chat_key: CHAT_A, sheet_id: 1n },
        { chat_key: "channel:raw-id:7", sheet_id: 2n },
        { chat_key: CHAT_B, sheet_id: -1n },
      ]),
      set_chat_sheet_link: vi.fn(async () => undefined),
      remove_chat_sheet_link: vi.fn(async () => undefined),
    };
    await expect(fetchChatSheetLinks(actor, "principal-a")).resolves.toEqual({
      [CHAT_A]: "0000000000000001",
    });
    await storeChatSheetLink(actor, CHAT_A, "1234567890abcdef");
    await removeChatSheetLink(actor, CHAT_A);
    expect(actor.set_chat_sheet_link).toHaveBeenCalledWith(CHAT_A, 0x1234567890abcdefn);
    expect(actor.remove_chat_sheet_link).toHaveBeenCalledWith(CHAT_A);
  });
});

// The routing guarantee the user asked to pin: ONE user with MULTIPLE sheets and
// MULTIPLE chats — each chat's drafts must land on (only) its own mapped sheet.
// draftBelongsOnSheet is the exact predicate SheetPage's visible-inbox uses.
describe("chatSheetLinks routing — each chat → its own sheet", () => {
  const SHEET_WIFE = "aaaaaaaaaaaaaaaa";
  const SHEET_CHILD = "bbbbbbbbbbbbbbbb";
  const CHAT_WIFE = CHAT_A;
  const CHAT_CHILD = CHAT_B;
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
    const unmapped = CHAT_C;
    expect(draftBelongsOnSheet(unmapped, links, SHEET_WIFE)).toBe(true);
    expect(draftBelongsOnSheet(unmapped, links, SHEET_CHILD)).toBe(true);
  });

  it("a wrapper-less draft (no chat key) is visible everywhere", () => {
    for (const key of [null, undefined, ""]) {
      expect(draftBelongsOnSheet(key, links, SHEET_WIFE)).toBe(true);
      expect(draftBelongsOnSheet(key, links, SHEET_CHILD)).toBe(true);
    }
  });

  it("fails closed for a non-empty raw or malformed chat coordinate", () => {
    expect(draftBelongsOnSheet("direct:raw-user-id", links, SHEET_WIFE)).toBe(false);
  });
});

// P0-7: "Close & start new" archives sheet S1 and rotates to S2, but the chat→sheet link still
// pinned to S1 would route the next confirmed draft onto the read-only archived sheet. repointChatLinks
// moves those pins onto the new active sheet.
describe("chatSheetLinks repoint on close-and-rotate (P0-7)", () => {
  const S1 = "aaaaaaaaaaaaaaaa"; // closed/archived
  const S2 = "cccccccccccccccc"; // new active
  const OTHER = "bbbbbbbbbbbbbbbb";

  it("moves a chat pinned to the closed sheet onto the new sheet", () => {
    const { next, affected } = repointChatLinks({ [CHAT_A]: S1 }, S1, S2);
    expect(affected).toEqual([CHAT_A]);
    expect(next[CHAT_A]).toBe(S2);
  });

  it("leaves chats pinned to OTHER sheets untouched", () => {
    const { next, affected } = repointChatLinks({ [CHAT_A]: S1, [CHAT_B]: OTHER }, S1, S2);
    expect(affected).toEqual([CHAT_A]);
    expect(next[CHAT_A]).toBe(S2);
    expect(next[CHAT_B]).toBe(OTHER);
  });

  it("re-points MULTIPLE chats that shared the closed sheet in one call", () => {
    const { next, affected } = repointChatLinks({ [CHAT_A]: S1, [CHAT_B]: S1, [CHAT_C]: OTHER }, S1, S2);
    expect(affected.sort()).toEqual([CHAT_A, CHAT_B].sort());
    expect(next[CHAT_A]).toBe(S2);
    expect(next[CHAT_B]).toBe(S2);
    expect(next[CHAT_C]).toBe(OTHER);
  });

  it("is a no-op (same reference, empty affected) when nothing targets the closed sheet", () => {
    const links = { [CHAT_A]: OTHER };
    const { next, affected } = repointChatLinks(links, S1, S2);
    expect(affected).toEqual([]);
    expect(next).toBe(links); // untouched reference — callers skip the canister write
  });

  it("after repoint, the next draft routes to the NEW sheet, not the archived one", () => {
    const { next } = repointChatLinks({ [CHAT_A]: S1 }, S1, S2);
    expect(draftBelongsOnSheet(CHAT_A, next, S2)).toBe(true); // now lands on active S2
    expect(draftBelongsOnSheet(CHAT_A, next, S1)).toBe(false); // no longer on archived S1
  });
});


// A father had his child's AND his manager's chats both importing into FatherChild, while the House
// sheet he believed was linked had nothing pointing at it. Nothing was wrong with the data model —
// links are keyed by (caller, chat key), so many-to-one is legal — but the chooser never showed the
// collision, so the mis-click was invisible until drafts landed in the wrong ledger.
describe("otherChatsLinkedTo — surface a sheet another chat already claims", () => {
  const FC = "c819f76d77f260b3";
  const HOUSE = "0a73358c07734ae8";
  const links = { [CHAT_A]: FC, [CHAT_B]: FC, [CHAT_C]: "e7e5df7a5d551d34" };

  it("names the other chats importing into the same sheet", () => {
    expect(otherChatsLinkedTo(FC, links, CHAT_A)).toEqual([CHAT_B]);
    expect(otherChatsLinkedTo(FC, links, CHAT_B)).toEqual([CHAT_A]);
  });

  it("never counts the chat being edited as a collision with itself", () => {
    expect(otherChatsLinkedTo("e7e5df7a5d551d34", links, CHAT_C)).toEqual([]);
  });

  it("is empty for a sheet nothing points at — the House case", () => {
    expect(otherChatsLinkedTo(HOUSE, links, CHAT_B)).toEqual([]);
  });

  it("is empty when there are no links at all", () => {
    expect(otherChatsLinkedTo(FC, {}, CHAT_A)).toEqual([]);
  });
});
