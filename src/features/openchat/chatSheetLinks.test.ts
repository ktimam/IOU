import { describe, it, expect } from "vitest";
import { sheetIdToNat64, nat64ToSheetId, readCachedLinks, writeCachedLinks } from "./chatSheetLinks";

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
