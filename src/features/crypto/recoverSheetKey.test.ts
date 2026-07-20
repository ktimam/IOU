// P0-3: the sheet-key READ path. recoverSheetKey (extracted from SheetKeyContext.unwrapFor) owns the
// branch logic — self-unwrap-first, tagged cross-wrap fallback, and the empty/undecryptable errors.
// Drives it with the REAL crypto primitives (no actor / no React), which also gives wrapSheetKeyTagged
// + unwrapTaggedSheetKey their first direct round-trip coverage.

import { describe, it, expect } from "vitest";
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
