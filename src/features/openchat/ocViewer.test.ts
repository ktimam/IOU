import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { rememberOpenChatUserId, readOpenChatUserId, forgetOpenChatUserId } from "./ocViewer";

// The suite runs in plain Node (vitest.config.ts: environment "node"), so stand up the tiny slice of
// localStorage this module touches. Doing it here rather than switching the whole project to jsdom.
const hadStorage = "localStorage" in globalThis;
if (!hadStorage) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}
afterAll(() => {
  if (!hadStorage) Reflect.deleteProperty(globalThis, "localStorage");
});

const A = "iou-principal-a";
const B = "iou-principal-b";

describe("ocViewer — the viewer's OpenChat id, scoped to the IOU account that paired", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips for the account that paired", () => {
    rememberOpenChatUserId(A, "father-oc-id");
    expect(readOpenChatUserId(A)).toBe("father-oc-id");
  });

  it("does NOT leak to another IOU account on the same device", () => {
    // Inheriting a stale id would attribute every draft to the wrong person — worse than having none.
    rememberOpenChatUserId(A, "father-oc-id");
    expect(readOpenChatUserId(B)).toBeUndefined();
  });

  it("is undefined before any claim, so attribution stays unavailable rather than wrong", () => {
    expect(readOpenChatUserId(A)).toBeUndefined();
  });

  it("is cleared on disconnect", () => {
    rememberOpenChatUserId(A, "father-oc-id");
    forgetOpenChatUserId(A);
    expect(readOpenChatUserId(A)).toBeUndefined();
  });

  it("ignores empty inputs rather than storing a blank identity", () => {
    rememberOpenChatUserId(A, "");
    rememberOpenChatUserId("", "x");
    expect(readOpenChatUserId(A)).toBeUndefined();
    expect(readOpenChatUserId("")).toBeUndefined();
  });
});
