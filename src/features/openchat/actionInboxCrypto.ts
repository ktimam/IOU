// ECIES decrypt + provenance verify for the OpenChat on-chain action_inbox.
//
// This mirrors, byte for byte, the Rust `ecies_payload` library OpenChat uses to encrypt a confirmed action
// into the inbox. The wire format is fixed:
//
//   shared      = ECDH(ephemeral_pk, recipient_sk)             // P-256, 32-byte X coordinate
//   okm(44)     = HKDF-SHA256(ikm = shared, salt = 32 zero bytes, info = "oc-action-inbox-v1")
//   key(32)     = okm[0..32]
//   nonce(12)   = okm[32..44]
//   plaintext   = AES-256-GCM-open(key, nonce, ciphertext)     // ciphertext carries the 16-byte tag appended
//   envelope    = { ephemeral_public_key: 65-byte SEC1 uncompressed, ciphertext }
//
// Provenance (v2 preimage): OpenChat signs (ephemeral_public_key ‖ ciphertext ‖ created_at) with its
// platform P-256 key as ECDSA(SHA-256), where created_at is the deposit's u64 millisecond timestamp encoded
// little-endian in 8 bytes. Binding created_at closes the v1 hole where the timestamp travelled unsigned.
// The signature is a raw 64-byte r‖s. Verify it against the inbox's openchat_public_key.
// NOTE: entries deposited before the v2 change verify against the old (eph ‖ ct) preimage only and are
// dropped by this verifier — acceptable for the local dev environment this ships in.
//
// NOTE on the salt: the Rust side uses `Hkdf::<Sha256>::new(None, ikm)`, where `None` means RFC-5869's
// default salt of HashLen (32) zero bytes. We pass an explicit 32-zero-byte salt to match exactly. (An empty
// salt also works because HMAC zero-pads the key to the block size, but 32 zeros is unambiguous.)

const INFO = "oc-action-inbox-v1";

function getSubtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto SubtleCrypto is not available");
  return s;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

// Strip a PEM envelope and base64-decode the body into DER bytes.
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/[\r\n\s]/g, "");
  return b64ToBytes(body);
}

function toBuf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** Import a P-256 ECDH private key from a PKCS#8 PEM (the consumer's secret key). */
export async function importEcdhPrivateKeyFromPkcs8Pem(pkcs8Pem: string): Promise<CryptoKey> {
  return getSubtle().importKey(
    "pkcs8",
    toBuf(pemToDer(pkcs8Pem)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

/** Import a P-256 ECDH public key from a 65-byte SEC1 uncompressed point. */
async function importEcdhPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey("raw", toBuf(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export type InboxEnvelope = {
  ephemeralPublicKey: Uint8Array; // 65-byte SEC1 uncompressed
  ciphertext: Uint8Array; // AES-GCM output (tag appended)
};

/**
 * Decrypt an inbox envelope addressed to `recipientPrivateKey` (the consumer's P-256 ECDH private key).
 * Returns the opaque plaintext OpenChat deposited (for IOU, the JSON draft bytes).
 */
export async function decryptInboxEnvelope(
  env: InboxEnvelope,
  recipientPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const ephemeral = await importEcdhPublicKeyRaw(env.ephemeralPublicKey);

  // ECDH -> 32-byte shared secret (P-256 X coordinate), matching Rust's `raw_secret_bytes()`.
  const shared = await subtle.deriveBits({ name: "ECDH", public: ephemeral }, recipientPrivateKey, 256);

  // HKDF-SHA256 with an explicit 32-zero-byte salt (== Rust `Hkdf::new(None, ..)`), 44 bytes of OKM.
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const okmBuf = await subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuf(new Uint8Array(32)),
      info: toBuf(new TextEncoder().encode(INFO)),
    },
    hkdfKey,
    44 * 8,
  );
  const okm = new Uint8Array(okmBuf);
  const key = okm.slice(0, 32);
  const nonce = okm.slice(32, 44);

  const aesKey = await subtle.importKey("raw", toBuf(key), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(nonce), tagLength: 128 },
    aesKey,
    toBuf(env.ciphertext),
  );
  return new Uint8Array(plaintext);
}

/**
 * The exact bytes OpenChat signs for provenance (v2):
 * `ephemeral_public_key ‖ ciphertext ‖ created_at` with created_at as a u64 little-endian (8 bytes).
 * Mirrors the Rust `EciesEnvelope::signing_preimage` byte for byte.
 */
export function signingPreimageV2(env: InboxEnvelope, createdAt: bigint): Uint8Array {
  const preimage = new Uint8Array(env.ephemeralPublicKey.length + env.ciphertext.length + 8);
  preimage.set(env.ephemeralPublicKey, 0);
  preimage.set(env.ciphertext, env.ephemeralPublicKey.length);
  new DataView(preimage.buffer).setBigUint64(env.ephemeralPublicKey.length + env.ciphertext.length, createdAt, true);
  return preimage;
}

/**
 * Verify OpenChat's provenance signature over the v2 preimage
 * (ephemeral_public_key ‖ ciphertext ‖ created_at as u64 LE — see signingPreimageV2).
 * `openchatPublicKeyPem` is the inbox's openchat_public_key (P-256 SPKI PEM).
 * `signature` is a raw 64-byte r‖s.
 * Pre-v2 deposits (signed without created_at) fail this check by design — local dev only.
 */
export async function verifyOpenChatSignature(
  env: InboxEnvelope,
  createdAt: bigint,
  signature: Uint8Array,
  openchatPublicKeyPem: string,
): Promise<boolean> {
  const subtle = getSubtle();
  const pub = await subtle.importKey(
    "spki",
    toBuf(pemToDer(openchatPublicKeyPem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const preimage = signingPreimageV2(env, createdAt);
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, toBuf(signature), toBuf(preimage));
}

/**
 * Routing fingerprint shared with the depositor: sha256 of the uncompressed 65-byte SEC1 point. Computed off
 * the raw point (not the SPKI DER) so it is independent of how each stack tags the SPKI algorithm OID.
 */
export async function keyFingerprint(spkiPem: string): Promise<Uint8Array> {
  const subtle = getSubtle();
  const pub = await subtle.importKey("spki", toBuf(pemToDer(spkiPem)), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const raw = new Uint8Array(await subtle.exportKey("raw", pub));
  return new Uint8Array(await subtle.digest("SHA-256", toBuf(raw)));
}

/** Fingerprint a public key already held as a CryptoKey (e.g. the consumer's own key). */
export async function fingerprintPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const subtle = getSubtle();
  const raw = new Uint8Array(await subtle.exportKey("raw", publicKey));
  return new Uint8Array(await subtle.digest("SHA-256", toBuf(raw)));
}

export const __testing = { b64ToBytes, bytesToB64, pemToDer };
