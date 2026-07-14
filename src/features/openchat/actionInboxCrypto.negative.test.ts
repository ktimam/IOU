// Adversarial ECIES + provenance coverage: wrong key, flipped ciphertext byte,
// flipped ephemeral point, forged/other-key signature, tampered created_at, and
// fingerprint-definition consistency. Complements actionInboxCrypto.test.ts
// (which pins the Rust interop vector); here we PRODUCE envelopes via ecTestKit
// so we can corrupt each field independently.

import { describe, it, expect } from "vitest";
import {
  decryptInboxEnvelope,
  verifyOpenChatSignature,
  keyFingerprint,
  fingerprintPublicKey,
  signingPreimageV2,
} from "./actionInboxCrypto";
import { generateConsumerKeys, generateOcSigner, eciesEncrypt, buildStoredAction } from "./ecTestKit";

const PLAINTEXT = '{"context":{"chat":"group:aaaaa-aa","messageId":"7"},"payload":{"amount":20}}';
const CREATED_AT = 1_750_000_000_123n;

function envOf(a: { ephemeral_public_key: number[]; ciphertext: number[] }) {
  return {
    ephemeralPublicKey: Uint8Array.from(a.ephemeral_public_key),
    ciphertext: Uint8Array.from(a.ciphertext),
  };
}

describe("ECIES decrypt — happy path and negatives", () => {
  it("round-trips a real signed+encrypted envelope (verify true, decrypt matches)", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });

    const env = envOf(a);
    await expect(
      verifyOpenChatSignature(env, a.created_at, Uint8Array.from(a.oc_signature), signer.publicKeyPem),
    ).resolves.toBe(true);
    const pt = await decryptInboxEnvelope(env, recipient.privateKey);
    expect(new TextDecoder().decode(pt)).toBe(PLAINTEXT);
  });

  it("rejects decryption with the WRONG recipient key (not addressed to us)", async () => {
    const recipient = await generateConsumerKeys();
    const attacker = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });
    // Decrypting someone else's deposit with our key fails (AES-GCM auth) — this is the "addressed-to-us" filter.
    await expect(decryptInboxEnvelope(envOf(a), attacker.privateKey)).rejects.toBeTruthy();
  });

  it("rejects a flipped ciphertext byte (AES-GCM tag fails)", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });
    a.ciphertext[0] ^= 0x01;
    await expect(decryptInboxEnvelope(envOf(a), recipient.privateKey)).rejects.toBeTruthy();
  });

  it("rejects a corrupted ephemeral public point", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });
    // Flip a byte in the middle of the SEC1 point → invalid point (import throws) or wrong shared secret.
    a.ephemeral_public_key[20] ^= 0xff;
    await expect(decryptInboxEnvelope(envOf(a), recipient.privateKey)).rejects.toBeTruthy();
  });
});

describe("provenance signature — negatives", () => {
  it("rejects a flipped signature byte", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });
    const sig = Uint8Array.from(a.oc_signature);
    sig[0] ^= 0x01;
    await expect(verifyOpenChatSignature(envOf(a), a.created_at, sig, signer.publicKeyPem)).resolves.toBe(false);
  });

  it("rejects a signature made by a DIFFERENT platform key", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const impostor = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });
    // Same envelope, verified against the wrong openchat_public_key → false.
    await expect(
      verifyOpenChatSignature(envOf(a), a.created_at, Uint8Array.from(a.oc_signature), impostor.publicKeyPem),
    ).resolves.toBe(false);
  });

  it("rejects a tampered created_at (the timestamp is bound by the v2 signature)", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer, plaintext: PLAINTEXT });
    await expect(
      verifyOpenChatSignature(envOf(a), a.created_at + 1n, Uint8Array.from(a.oc_signature), signer.publicKeyPem),
    ).resolves.toBe(false);
  });
});

describe("routing fingerprint — definition consistency", () => {
  it("keyFingerprint(pem) == fingerprintPublicKey(key) == sha256(raw point), 32 bytes", async () => {
    const recipient = await generateConsumerKeys();
    const fromPem = await keyFingerprint(recipient.spkiPem);
    const pub = await globalThis.crypto.subtle.importKey(
      "raw",
      recipient.publicKeyRaw.buffer.slice(0) as ArrayBuffer,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const fromKey = await fingerprintPublicKey(pub);
    expect(fromPem.length).toBe(32);
    expect(Array.from(fromPem)).toEqual(Array.from(recipient.fingerprint));
    expect(Array.from(fromKey)).toEqual(Array.from(recipient.fingerprint));
  });

  it("distinct keys get distinct fingerprints", async () => {
    const a = await generateConsumerKeys();
    const b = await generateConsumerKeys();
    expect(Array.from(a.fingerprint)).not.toEqual(Array.from(b.fingerprint));
  });
});

describe("signingPreimageV2 — layout on a real envelope", () => {
  it("is eph ‖ ct ‖ u64 LE created_at", async () => {
    const recipient = await generateConsumerKeys();
    const env = await eciesEncrypt(recipient.publicKeyRaw, new TextEncoder().encode("{}"));
    const pre = signingPreimageV2(env, CREATED_AT);
    expect(pre.length).toBe(env.ephemeralPublicKey.length + env.ciphertext.length + 8);
    const tail = pre.slice(pre.length - 8);
    expect(new DataView(tail.slice().buffer).getBigUint64(0, true)).toBe(CREATED_AT);
  });
});
