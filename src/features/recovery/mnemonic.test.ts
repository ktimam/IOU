// Recovery key unit tests. Pure functions only — IndexedDB is
// skipped in the Node test environment.

import { describe, it, expect } from "vitest";
import {
  isValidMnemonic,
  newRecoveryMnemonic,
  seedFromMnemonic,
} from "./mnemonic";

describe("recovery mnemonic", () => {
  it("generates a valid 24-word mnemonic", () => {
    const m = newRecoveryMnemonic();
    expect(m.split(" ")).toHaveLength(24);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidMnemonic("not a real mnemonic at all")).toBe(false);
    expect(isValidMnemonic("")).toBe(false);
  });

  it("derives a deterministic 32-byte seed from the mnemonic", () => {
    const m = newRecoveryMnemonic();
    const a = seedFromMnemonic(m);
    const b = seedFromMnemonic(m);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(Buffer.from(a).toString("hex"))
      .toBe(Buffer.from(b).toString("hex"));
  });

  it("different mnemonics yield different seeds", () => {
    const a = seedFromMnemonic(newRecoveryMnemonic());
    const b = seedFromMnemonic(newRecoveryMnemonic());
    expect(Buffer.from(a).toString("hex"))
      .not.toBe(Buffer.from(b).toString("hex"));
  });

  it("rejects invalid mnemonic on seed derivation", () => {
    expect(() => seedFromMnemonic("not valid")).toThrow();
  });
});
