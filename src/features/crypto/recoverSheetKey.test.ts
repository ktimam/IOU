// P0-3: the sheet-key READ path. recoverSheetKey (extracted from SheetKeyContext.unwrapFor) owns the
// branch logic — self-unwrap-first, tagged cross-wrap fallback, and the empty/undecryptable errors.
// Drives it with the REAL crypto primitives (no actor / no React), which also gives wrapSheetKeyTagged
// + unwrapTaggedSheetKey their first direct round-trip coverage.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}
// deriveUserKeypair caches the (random) keypair per principal in localStorage — shim it so the same
// principal yields the SAME keypair across calls within a test.
const _ls = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => { _ls.set(k, v); },
  removeItem: (k: string) => { _ls.delete(k); },
};

import {
  deriveUserKeypair,
  newSheetKey,
  wrapSheetKey,
  wrapSheetKeyTagged,
  recoverSheetKey,
  loadExistingLegacySheetKey,
} from "./devVetkd";

const ME = "aaaaa-aa";
const OTHER = "bbbbb-bb";
const THIRD = "ccccc-cc";
const bytes = (u: Uint8Array) => Array.from(u);

describe("recoverSheetKey — sheet-key read path", () => {
  it("throws a friendly error for an empty blob (no wrapped key)", async () => {
    const me = await deriveUserKeypair(ME);
    await expect(recoverSheetKey(new Uint8Array(0), me)).rejects.toThrow("no wrapped key for this sheet");
  });

  it("recovers a PLAIN self-wrapped slot via the self-unwrap-first path", async () => {
    const me = await deriveUserKeypair(ME);
    const K = newSheetKey();
    const blob = await wrapSheetKey(K, me.publicKey, me.privateKey); // I sealed my own slot
    expect(bytes(await recoverSheetKey(blob, me))).toEqual(bytes(K));
  });

  it("recovers a TAGGED cross-wrap addressed to me via the tagged fallback", async () => {
    const me = await deriveUserKeypair(ME);
    const other = await deriveUserKeypair(OTHER);
    const K = newSheetKey();
    // The other member created a post-join sheet and cross-wrapped its key FOR me.
    const blob = await wrapSheetKeyTagged(K, me.publicKey, other.privateKey, other.publicKeyB64);
    // self-unwrap fails (not my seal) → tagged fallback reads the pinned sender pubkey → K.
    expect(bytes(await recoverSheetKey(blob, me))).toEqual(bytes(K));
  });

  it("rejects a non-tagged foreign/garbage blob with 'cannot unwrap sheet key'", async () => {
    const me = await deriveUserKeypair(ME);
    const garbage = new Uint8Array(28);
    crypto.getRandomValues(garbage);
    garbage[0] = 0x02; // not the tagged magic (0x01)
    await expect(recoverSheetKey(garbage, me)).rejects.toThrow("cannot unwrap sheet key");
  });

  it("rejects a tagged blob addressed to a DIFFERENT recipient (I'm not the recipient)", async () => {
    const me = await deriveUserKeypair(ME);
    const other = await deriveUserKeypair(OTHER);
    const third = await deriveUserKeypair(THIRD);
    const K = newSheetKey();
    // other sealed this FOR third, tagged with other's pubkey. I try to read it.
    const blob = await wrapSheetKeyTagged(K, third.publicKey, other.privateKey, other.publicKeyB64);
    // tagged path reaches unwrapSheetKey(body, me.priv, other.pub) → wrong shared secret → GCM fail.
    await expect(recoverSheetKey(blob, me)).rejects.toThrow("cannot unwrap sheet key");
  });

  it("rejects a truncated/corrupt blob", async () => {
    const me = await deriveUserKeypair(ME);
    await expect(recoverSheetKey(new Uint8Array([1, 2, 3, 4, 5]), me)).rejects.toThrow(
      "cannot unwrap sheet key",
    );
  });

  it("round-trips a random 32-byte sheet key byte-for-byte through both seal shapes", async () => {
    const me = await deriveUserKeypair(ME);
    const other = await deriveUserKeypair(OTHER);
    for (let i = 0; i < 3; i++) {
      const K = newSheetKey();
      const self = await wrapSheetKey(K, me.publicKey, me.privateKey);
      const tagged = await wrapSheetKeyTagged(K, me.publicKey, other.privateKey, other.publicKeyB64);
      expect(bytes(await recoverSheetKey(self, me))).toEqual(bytes(K));
      expect(bytes(await recoverSheetKey(tagged, me))).toEqual(bytes(K));
    }
  });
});

describe("loadExistingLegacySheetKey — read-only free migration", () => {
  const principal = "legacy-reader";
  const storageKey = `iou.dev.userKeypair.v1.${principal}`;
  let stored: Map<string, string>;
  const getItem = vi.fn();
  const setItem = vi.fn();
  const removeItem = vi.fn();
  const fetch = vi.fn();
  beforeEach(() => {
    stored = new Map();
    getItem.mockReset().mockImplementation((key: string) => stored.get(key) ?? null);
    setItem.mockReset().mockImplementation((key: string, value: string) => { stored.set(key, value); });
    removeItem.mockReset().mockImplementation((key: string) => { stored.delete(key); });
    fetch.mockReset();
    vi.stubGlobal("localStorage", { getItem, setItem, removeItem });
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  function observeReadOnly() {
    getItem.mockClear(); setItem.mockClear(); removeItem.mockClear();
    const generate = vi.spyOn(crypto.subtle, "generateKey");
    return () => {
      expect(generate).not.toHaveBeenCalled();
      expect(setItem).not.toHaveBeenCalled(); expect(removeItem).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    };
  }
  it("returns null without generating or storing a key when the original device key is absent", async () => {
    const assertReadOnly = observeReadOnly();
    expect(await loadExistingLegacySheetKey(principal, new Uint8Array(60))).toBeNull();
    expect(getItem).toHaveBeenCalledExactlyOnceWith(storageKey);
    expect(stored.size).toBe(0); assertReadOnly();
  });
  it("recovers the real original self-wrapped key without storage writes or network calls", async () => {
    const pair = await deriveUserKeypair(principal);
    const key = newSheetKey();
    const wrapped = await wrapSheetKey(key, pair.publicKey, pair.privateKey);
    const originalRecord = stored.get(storageKey);
    const originalWrapped = wrapped.slice();
    const assertReadOnly = observeReadOnly();
    const restored = await loadExistingLegacySheetKey(principal, wrapped);
    expect(restored).toEqual(key);
    expect(restored).not.toBe(key);
    expect(wrapped).toEqual(originalWrapped);
    expect(stored.get(storageKey)).toBe(originalRecord);
    expect(getItem).toHaveBeenCalledExactlyOnceWith(storageKey);
    restored!.fill(0);
    expect(key.some(value => value !== 0)).toBe(true);
    assertReadOnly();
  });
  it("recovers a real tagged cross-wrap using only the recipient's existing key", async () => {
    const recipient = await deriveUserKeypair(principal);
    const sender = await deriveUserKeypair("legacy-sender");
    const key = newSheetKey();
    const wrapped = await wrapSheetKeyTagged(key, recipient.publicKey, sender.privateKey, sender.publicKeyB64);
    stored.delete("iou.dev.userKeypair.v1.legacy-sender");
    const assertReadOnly = observeReadOnly();
    expect(await loadExistingLegacySheetKey(principal, wrapped)).toEqual(key);
    expect(getItem).toHaveBeenCalledExactlyOnceWith(storageKey);
    assertReadOnly();
  });
  it("does not use another principal's stored key", async () => {
    const pair = await deriveUserKeypair("different-reader");
    const wrapped = await wrapSheetKey(newSheetKey(), pair.publicKey, pair.privateKey);
    const assertReadOnly = observeReadOnly();
    expect(await loadExistingLegacySheetKey(principal, wrapped)).toBeNull();
    expect(getItem).toHaveBeenCalledExactlyOnceWith(storageKey);
    assertReadOnly();
  });
  it.each([new Uint8Array(0), new Uint8Array([1, 2, 3]), new Uint8Array(192).fill(2)])("returns null for an empty, damaged or nonlocal ciphertext without deriving another key", async (wrapped) => {
    await deriveUserKeypair(principal);
    const assertReadOnly = observeReadOnly();
    expect(await loadExistingLegacySheetKey(principal, wrapped)).toBeNull();
    assertReadOnly();
  });
  it("returns null for a valid cross-wrap addressed to somebody else", async () => {
    await deriveUserKeypair(principal);
    const other = await deriveUserKeypair("other-reader");
    const sender = await deriveUserKeypair("legacy-sender");
    const wrapped = await wrapSheetKeyTagged(newSheetKey(), other.publicKey, sender.privateKey, sender.publicKeyB64);
    const assertReadOnly = observeReadOnly();
    expect(await loadExistingLegacySheetKey(principal, wrapped)).toBeNull();
    assertReadOnly();
  });
  it.each(["{PRIVATE-KEY-MATERIAL", JSON.stringify({ publicKeyB64: "not a valid key", privateKeyJwk: { d: "PRIVATE-KEY-MATERIAL" } })])("rejects a corrupt durable key record without replacing or disclosing it", async (corrupt) => {
    stored.set(storageKey, corrupt);
    const assertReadOnly = observeReadOnly();
    let error: unknown;
    try { await loadExistingLegacySheetKey(principal, new Uint8Array(60)); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("The existing local sheet-key material could not be read. No replacement key was created.");
    expect((error as Error).message).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(stored.get(storageKey)).toBe(corrupt);
    assertReadOnly();
  });
  it.each([31, 33])("rejects an authenticated %i-byte plaintext instead of treating it as a sheet key", async (length) => {
    const pair = await deriveUserKeypair(principal);
    const wrapped = await wrapSheetKey(new Uint8Array(length).fill(42), pair.publicKey, pair.privateKey);
    const assertReadOnly = observeReadOnly();
    await expect(loadExistingLegacySheetKey(principal, wrapped)).rejects.toThrow("invalid length");
    assertReadOnly();
  });
  it("does not create a replacement when local key storage cannot be accessed", async () => {
    getItem.mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    const assertReadOnly = observeReadOnly();
    expect(await loadExistingLegacySheetKey(principal, new Uint8Array(60))).toBeNull();
    assertReadOnly();
  });
});
