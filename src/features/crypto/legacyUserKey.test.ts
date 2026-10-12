import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveUserKey, loadLegacyUserKey } from "./devVetkd";

const records = new Map<string, string>();
const writes = vi.fn((key: string, value: string) => { records.set(key, value); });
beforeEach(() => {
  records.clear(); vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: (key: string) => records.get(key) ?? null, setItem: writes });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("read-only pre-vault personal Types key loading", () => {
  it("reproduces the existing device key without changing persisted material", async () => {
    const expected = await deriveUserKey("alice");
    const original = records.get("iou.dev.userKeypair.v1.alice");
    writes.mockClear();
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    const loaded = await loadLegacyUserKey("alice");
    expect(loaded).toEqual(expected);
    expect(records.get("iou.dev.userKeypair.v1.alice")).toBe(original);
    expect(writes).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
    loaded.fill(0);
    expect(await loadLegacyUserKey("alice")).toEqual(expected);
  });
  it("never invents a replacement key when the old device key is missing", async () => {
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    await expect(loadLegacyUserKey("alice")).rejects.toThrow(/original key.*No replacement key/);
    expect(generate).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });
  it("isolates principal namespaces instead of borrowing another user's device key", async () => {
    await deriveUserKey("alice"); writes.mockClear();
    await expect(loadLegacyUserKey("bob")).rejects.toThrow(/original key/);
    expect(writes).not.toHaveBeenCalled();
    expect(records.has("iou.dev.userKeypair.v1.bob")).toBe(false);
  });
  it("fails closed on malformed stored material without overwriting it", async () => {
    for (const malformed of ["not-json", JSON.stringify({ publicKeyB64: "invalid", privateKeyJwk: {} })]) {
      records.set("iou.dev.userKeypair.v1.alice", malformed);
      await expect(loadLegacyUserKey("alice")).rejects.toThrow();
      expect(records.get("iou.dev.userKeypair.v1.alice")).toBe(malformed);
    }
    expect(writes).not.toHaveBeenCalled();
  });
  it("fails without generating or persisting a key if browser storage is blocked", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: writes });
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    await expect(loadLegacyUserKey("alice")).rejects.toThrow(/original key/);
    expect(generate).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
  });
});
