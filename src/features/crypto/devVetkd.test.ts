// Unit tests for the devVetkd adapter.

import { describe, it, expect, beforeEach } from "vitest";
import { webcrypto } from "node:crypto";

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}

const _ls = new Map<string, string>();
beforeEach(() => _ls.clear());
(globalThis as any).localStorage = {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => { _ls.set(k, v); },
  removeItem: (k: string) => { _ls.delete(k); },
};

import {
  deriveUserKeypair,
  newSheetKey,
  unwrapSheetKey,
  wrapSheetKey,
  isDevVetkd,
  isProdVetkd,
  VETKD_CONTEXT,
} from "./devVetkd";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("devVetkd adapter", () => {
  it("round-trips a K_sheet via self-wrap", async () => {
    // In v1 dev, the simplest wrap is "self-wrap": sender = recipient.
    // The producer of the sheet wraps the K_sheet for each member
    // using that member's public key and the producer's own private
    // key.
    const { publicKey: pubA, privateKey: privA } = await deriveUserKeypair("A");
    const { publicKey: pubB, privateKey: privB } = await deriveUserKeypair("B");

    // Producer is A; wrap for A and B.
    const K_sheet = newSheetKey();
    const wrapForA = await wrapSheetKey(K_sheet, pubA, privA);
    const wrapForB = await wrapSheetKey(K_sheet, pubB, privA);

    // Each member unwraps with their own private key and the
    // producer's public key.
    const uA = await unwrapSheetKey(wrapForA, privA, pubA);
    const uB = await unwrapSheetKey(wrapForB, privB, pubA);

    expect(bytesToHex(uA)).toEqual(bytesToHex(K_sheet));
    expect(bytesToHex(uB)).toEqual(bytesToHex(K_sheet));
  });

  it("persists a user's keypair in localStorage", async () => {
    const first = await deriveUserKeypair("persist-test");
    const second = await deriveUserKeypair("persist-test");
    expect(first.publicKeyB64).toEqual(second.publicKeyB64);
  });

  it("different principals get different keypairs", async () => {
    const a = await deriveUserKeypair("X");
    const b = await deriveUserKeypair("Y");
    expect(a.publicKeyB64).not.toEqual(b.publicKeyB64);
  });

  it("wraps produce distinct ciphertexts for distinct targets", async () => {
    const { publicKey: pubA, privateKey: privA } = await deriveUserKeypair("a");
    const { publicKey: pubB, privateKey: privB } = await deriveUserKeypair("b");
    const K_sheet = newSheetKey();
    const wA = await wrapSheetKey(K_sheet, pubA, privA);
    const wB = await wrapSheetKey(K_sheet, pubB, privB);
    expect(bytesToHex(wA)).not.toEqual(bytesToHex(wB));
  });

  it("VETKD_CONTEXT is set", () => {
    expect(VETKD_CONTEXT).toBe("iou-per-sheet-key-v1");
  });

  it("isDevVetkd is true and isProdVetkd is false today", () => {
    expect(isDevVetkd()).toBe(true);
    expect(isProdVetkd()).toBe(false);
  });
});
