import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeClosingBalances,
  encryptClosingBalances,
  decryptClosingBalances,
} from "./closingBalances";

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

describe("encrypted closing balances", () => {
  const key = new Uint8Array(Array.from({ length: 32 }, (_, i) => i + 1));
  const balances = [
    { currency: "USD", amount_minor: 12_345, direction: "credit" as const },
    { currency: "EGP", amount_minor: 6_789, direction: "debt" as const },
  ];

  it("round-trips the snapshot without placing business fields on the wire", async () => {
    const encrypted = await encryptClosingBalances(balances, key);

    expect(encrypted.entry_key).toHaveLength(32);
    expect(encrypted.iv).toHaveLength(12);
    expect(encrypted.ciphertext.length).toBeGreaterThan(16);
    expect(JSON.stringify(encrypted)).not.toContain("USD");
    expect(JSON.stringify(encrypted)).not.toContain("12345");

    await expect(decryptClosingBalances(encrypted, key)).resolves.toEqual(balances);
  });

  it("rejects malformed or unsafe decrypted snapshots", () => {
    expect(() => decodeClosingBalances(new TextEncoder().encode("{}"))).toThrow();
    expect(() =>
      decodeClosingBalances(
        new TextEncoder().encode(
          JSON.stringify([{ currency: "usd", amount_minor: 1, direction: "credit" }]),
        ),
      ),
    ).toThrow();
    expect(() =>
      decodeClosingBalances(
        new TextEncoder().encode(
          JSON.stringify([
            {
              currency: "USD",
              amount_minor: Number.MAX_SAFE_INTEGER + 1,
              direction: "credit",
            },
          ]),
        ),
      ),
    ).toThrow();
  });

  it("rejects a ciphertext encrypted for another sheet key", async () => {
    const encrypted = await encryptClosingBalances(balances, key);
    const otherKey = new Uint8Array(key);
    otherKey[0] ^= 0xff;
    await expect(decryptClosingBalances(encrypted, otherKey)).rejects.toBeTruthy();
  });
});
