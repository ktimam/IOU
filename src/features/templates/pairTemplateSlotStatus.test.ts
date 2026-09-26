import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptSlot, decryptSlotWithStatus } from "./pairTemplatesActor";
import { encodePairSlot } from "./pairTemplates";

const crypto = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock("../crypto/devVetkd", () => ({ decryptWithSheetKey: crypto.decrypt, encryptWithSheetKey: vi.fn() }));
const key = new Uint8Array(32).fill(7);
const ciphertext = [[1, 2, 3]];
const iv = [Array(12).fill(0)];
const empty = { templates: [], dismissed: [] };
beforeEach(() => vi.resetAllMocks());

describe("private Type slot readability", () => {
  it("accepts two genuinely absent fields without invoking decryption", async () => {
    expect(await decryptSlotWithStatus(key, [], [])).toEqual({ readable: true, payload: empty });
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });
  it.each([[ciphertext, []], [[], iv]])("rejects incomplete encrypted slot fields", async (enc, nonce) => {
    expect(await decryptSlotWithStatus(key, enc, nonce)).toEqual({ readable: false, payload: empty });
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });
  it("reports cryptographic failure without changing legacy empty-slot fallback", async () => {
    crypto.decrypt.mockRejectedValue(new Error("Invalid authentication tag"));
    expect(await decryptSlotWithStatus(key, ciphertext, iv)).toEqual({ readable: false, payload: empty });
    expect(await decryptSlot(key, ciphertext, iv)).toEqual(empty);
  });
  it.each([
    "not valid JSON",
    JSON.stringify({ v: 3, templates: [], dismissed: [] }),
    JSON.stringify({ v: 2, templates: [{ id: "broken" }], dismissed: [] }),
    JSON.stringify({ v: 2, templates: [], dismissed: [], futureField: true }),
  ])("rejects invalid decrypted slot data: %s", async (data) => {
    crypto.decrypt.mockResolvedValue(new TextEncoder().encode(data));
    expect(await decryptSlotWithStatus(key, ciphertext, iv)).toEqual({ readable: false, payload: empty });
  });
  it("accepts a valid decrypted empty slot", async () => {
    crypto.decrypt.mockResolvedValue(encodePairSlot([], []));
    expect(await decryptSlotWithStatus(key, ciphertext, iv)).toEqual({ readable: true, payload: empty });
  });
  it("preserves legacy partial decoding while a complete private export fails closed", async () => {
    const valid = { id: "valid", name: "Valid", direction: "credit", txn_type: "iou", rev: 1, updatedAt: 1 };
    crypto.decrypt.mockResolvedValue(new TextEncoder().encode(JSON.stringify({ v: 2, templates: [valid, { id: "broken" }], dismissed: [] })));
    expect(await decryptSlot(key, ciphertext, iv)).toEqual({ templates: [valid], dismissed: [] });
    expect(await decryptSlotWithStatus(key, ciphertext, iv)).toEqual({ readable: false, payload: empty });
  });
});
