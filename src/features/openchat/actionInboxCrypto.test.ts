import { describe, it, expect } from "vitest";
import {
  decryptInboxEnvelope,
  importEcdhPrivateKeyFromPkcs8Pem,
  keyFingerprint,
  signingPreimageV2,
  verifyOpenChatSignature,
  __testing,
} from "./actionInboxCrypto";

const { b64ToBytes, bytesToB64 } = __testing;

// Cross-language interop vector, produced by the Rust `ecies_payload` library that OpenChat itself uses to
// encrypt confirmed actions into the action_inbox (test `print_interop_vector`, StdRng seed 424242). If this
// passes, the browser decrypts the exact wire format OpenChat produces — the riskiest contract in the cycle.
const VEC = {
  recipient_sk_pem_b64:
    "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUdIQWdFQU1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhCRzB3YXdJQkFRUWdubWp0TktHU2lkRU96ZHhrDQpqRTI4bkh3TFd3QkRZVWxTbDZyYmo1OHIrV3FoUkFOQ0FBUnJESmo1VTJPQkF0bGdyNzJGSmNBSWFNYjVOT1BNDQp3T1FYMDVIMWdzeWthN3Nheitld1JJNWxyRWtudzlTaTBCMGV6OXl0TTlZZGpXZ2NJenR1OGlLSw0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQ0K",
  recipient_pk_pem_b64:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0NCk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRWF3eVkrVk5qZ1FMWllLKzloU1hBQ0dqRytUVGoNCnpNRGtGOU9SOVlMTXBHdTdHcy9uc0VTT1pheEpKOFBVb3RBZEhzL2NyVFBXSFkxb0hDTTdidklpaWc9PQ0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tDQo=",
  ephemeral_public_key_b64: "BM8/i9pzJUADvSgLGzaep8oPGY+6u8tG8rtiHKDWb4wtXzdtTSY/mCyvv25wuRcN6dg+mIKIPQSOlrLoqHsADik=",
  ciphertext_b64:
    "nvDw0tfQh5q51eoPJyWsP164l9n8jo//h6OD0au67ANOEFnEHjgTXLEUFog1IXQRWiX9NcJ7sNufw0iDFE6m2nxeFFi2cPk9t9TE/AKdzlZj",
  expected_plaintext: '{"action_id":"iou.add","rows":[{"label":"Amount","value":"$20"}]}',
  fingerprint_hex: "2d86d5f2f9c5204734f13f2a39f2f724848b775543ab847243c78d91cd126137",
};

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("action_inbox ECIES interop with Rust ecies_payload", () => {
  it("decrypts an envelope produced by the Rust library (HKDF salt + AES-GCM match)", async () => {
    const skPem = new TextDecoder().decode(b64ToBytes(VEC.recipient_sk_pem_b64));
    const priv = await importEcdhPrivateKeyFromPkcs8Pem(skPem);
    const pt = await decryptInboxEnvelope(
      {
        ephemeralPublicKey: b64ToBytes(VEC.ephemeral_public_key_b64),
        ciphertext: b64ToBytes(VEC.ciphertext_b64),
      },
      priv,
    );
    expect(new TextDecoder().decode(pt)).toBe(VEC.expected_plaintext);
  });

  it("computes the same routing fingerprint as Rust (sha256 of SPKI DER)", async () => {
    const pkPem = new TextDecoder().decode(b64ToBytes(VEC.recipient_pk_pem_b64));
    const fp = await keyFingerprint(pkPem);
    expect(bytesToHex(fp)).toBe(VEC.fingerprint_hex);
  });
});

// v2 provenance preimage: eph ‖ ct ‖ created_at (u64 LE, 8 bytes). The Rust signer (ecies_payload
// signing_preimage + local_user_index deposit) changed in lockstep; these tests pin the byte layout and
// prove that created_at is BOUND by the signature (the v1 hole this closes). Signing happens with a
// WebCrypto-generated P-256 key — ECDSA(SHA-256) with a raw 64-byte r‖s, the same shape jwt::sign_bytes
// produces — over the fixed Rust-produced envelope bytes.
describe("action_inbox provenance signature (v2 preimage binds created_at)", () => {
  const env = {
    ephemeralPublicKey: b64ToBytes(VEC.ephemeral_public_key_b64),
    ciphertext: b64ToBytes(VEC.ciphertext_b64),
  };
  const CREATED_AT = 1_750_000_000_123n; // arbitrary epoch ms

  function spkiToPem(der: Uint8Array): string {
    const body = bytesToB64(der).match(/.{1,64}/g)?.join("\n") ?? bytesToB64(der);
    return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
  }

  async function signV2(createdAt: bigint): Promise<{ signature: Uint8Array; pem: string }> {
    const subtle = globalThis.crypto.subtle;
    const kp = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const preimage = signingPreimageV2(env, createdAt);
    const sig = new Uint8Array(
      await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, preimage.slice().buffer as ArrayBuffer),
    );
    const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
    return { signature: sig, pem: spkiToPem(spki) };
  }

  it("lays out the preimage as eph ‖ ct ‖ u64 LE created_at", () => {
    const preimage = signingPreimageV2(env, CREATED_AT);
    expect(preimage.length).toBe(env.ephemeralPublicKey.length + env.ciphertext.length + 8);
    expect(Array.from(preimage.slice(0, env.ephemeralPublicKey.length))).toEqual(
      Array.from(env.ephemeralPublicKey),
    );
    const tail = preimage.slice(preimage.length - 8);
    const le = new DataView(tail.slice().buffer).getBigUint64(0, true);
    expect(le).toBe(CREATED_AT);
  });

  it("verifies a signature over the v2 preimage", async () => {
    const { signature, pem } = await signV2(CREATED_AT);
    await expect(verifyOpenChatSignature(env, CREATED_AT, signature, pem)).resolves.toBe(true);
  });

  it("rejects when created_at is tampered (timestamp is now signed)", async () => {
    const { signature, pem } = await signV2(CREATED_AT);
    await expect(verifyOpenChatSignature(env, CREATED_AT + 1n, signature, pem)).resolves.toBe(false);
  });

  it("rejects a v1 signature (eph ‖ ct only) — old inbox entries are unverifiable by design", async () => {
    const subtle = globalThis.crypto.subtle;
    const kp = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const v1 = new Uint8Array(env.ephemeralPublicKey.length + env.ciphertext.length);
    v1.set(env.ephemeralPublicKey, 0);
    v1.set(env.ciphertext, env.ephemeralPublicKey.length);
    const sig = new Uint8Array(
      await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, v1.slice().buffer as ArrayBuffer),
    );
    const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
    await expect(verifyOpenChatSignature(env, CREATED_AT, sig, spkiToPem(spki))).resolves.toBe(false);
  });
});
