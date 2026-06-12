// Replace-member Ed25519 round-trip (pure unit test).

import { describe, it, expect } from "vitest";
import {
  canonicalReplaceBytes,
  decodeFromQr,
  encodeForQr,
  signReplaceRequest,
  verifyReplaceRequest,
  type Ed25519Keypair,
} from "./replaceMember";
import { ed25519 } from "@noble/curves/ed25519";

function randomKp(): Ed25519Keypair {
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  return { secretKey: seed, publicKey: ed25519.getPublicKey(seed) };
}

// Two valid II principals (these exist in the wild as documented
// examples; their checksums are real).
const PRINCIPAL_A = "gkcdg-7g62q-dbcrx-2jyzh-wmcof-xupqy-p4zcz-waqau-ujhtg-6er5c-4ae"; // tester
const PRINCIPAL_B = "iltwk-4jith-coefk-rrnjg-uywew-wrafk-umbzf-yxacl-lzafq-azwel-sae"; // partner

describe("replace-member", () => {
  it("canonical bytes are deterministic", () => {
    const req = {
      pair_id: "abc",
      leaving_principal: PRINCIPAL_A,
      new_principal: PRINCIPAL_B,
      ts_ms: BigInt(1234),
      nonce: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
              17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
    };
    const a = canonicalReplaceBytes(req);
    const b = canonicalReplaceBytes(req);
    expect(Buffer.from(a).toString("hex"))
      .toBe(Buffer.from(b).toString("hex"));
  });

  it("sign + verify round-trip", async () => {
    const kp = randomKp();
    const req = {
      pair_id: "abc",
      leaving_principal: PRINCIPAL_A,
      new_principal: PRINCIPAL_B,
      ts_ms: BigInt(Date.now()),
      nonce: Array.from(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signed = await signReplaceRequest(req, kp);
    expect(verifyReplaceRequest(signed)).toBe(true);
  });

  it("verify rejects a tampered signature", async () => {
    const kp = randomKp();
    const req = {
      pair_id: "abc",
      leaving_principal: PRINCIPAL_A,
      new_principal: PRINCIPAL_B,
      ts_ms: BigInt(Date.now()),
      nonce: Array.from(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signed = await signReplaceRequest(req, kp);
    const tampered = {
      ...signed,
      signature: signed.signature.map((b, i) => (i === 0 ? b ^ 0x01 : b)),
    };
    expect(verifyReplaceRequest(tampered)).toBe(false);
  });

  it("QR handoff round-trip preserves all fields", async () => {
    const kp = randomKp();
    const req = {
      pair_id: "abc",
      leaving_principal: PRINCIPAL_A,
      new_principal: PRINCIPAL_B,
      ts_ms: BigInt(Date.now()),
      nonce: Array.from(crypto.getRandomValues(new Uint8Array(32))),
    };
    const signed = await signReplaceRequest(req, kp);
    const blob = encodeForQr(signed);
    const decoded = decodeFromQr(blob);
    expect(decoded.request.pair_id).toBe(req.pair_id);
    expect(decoded.request.leaving_principal).toBe(req.leaving_principal);
    expect(decoded.request.new_principal).toBe(req.new_principal);
    expect(BigInt(decoded.request.ts_ms)).toBe(req.ts_ms);
    expect(decoded.request.nonce).toEqual(req.nonce);
    expect(decoded.signature).toEqual(signed.signature);
    expect(decoded.signer_pubkey).toEqual(signed.signer_pubkey);
  });
});
