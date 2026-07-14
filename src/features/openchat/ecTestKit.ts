// Test-only helpers that PRODUCE the exact action-inbox wire format OpenChat's
// Rust `ecies_payload` + local_user_index emit, so specs can build real signed,
// encrypted envelopes (and then tamper with them). NOT a test file itself
// (no `.test.ts` suffix) and never imported by app code — imported only by
// actionInboxCrypto / actionInboxClient specs. Mirrors actionInboxCrypto.ts
// byte-for-byte: ECDH(P-256) → HKDF-SHA256(salt=32 zeros, info="oc-action-inbox-v1")
// → key32‖nonce12 → AES-256-GCM; provenance = ECDSA(SHA-256) over
// eph‖ct‖created_at(u64 LE).

const INFO = "oc-action-inbox-v1";

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto SubtleCrypto is not available");
  return s;
}

function toBuf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

function spkiToPem(der: Uint8Array): string {
  const body = bytesToB64(der).match(/.{1,64}/g)?.join("\n") ?? bytesToB64(der);
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

export type ConsumerKeys = {
  privateKey: CryptoKey; // ECDH deriveBits — the recipient secret
  publicKeyRaw: Uint8Array; // 65-byte SEC1 uncompressed point
  spkiPem: string; // SPKI PEM (what a consumer registers with OpenChat)
  fingerprint: Uint8Array; // sha256(raw point)
};

/** Generate a fresh P-256 ECDH "consumer" keypair (the inbox recipient). */
export async function generateConsumerKeys(): Promise<ConsumerKeys> {
  const s = subtle();
  const kp = (await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await s.exportKey("raw", kp.publicKey));
  const spkiDer = new Uint8Array(await s.exportKey("spki", kp.publicKey));
  const fingerprint = new Uint8Array(await s.digest("SHA-256", toBuf(publicKeyRaw)));
  return { privateKey: kp.privateKey, publicKeyRaw, spkiPem: spkiToPem(spkiDer), fingerprint };
}

export type OcSigner = {
  sign: (preimage: Uint8Array) => Promise<Uint8Array>; // raw 64-byte r‖s
  publicKeyPem: string; // SPKI PEM — the inbox's openchat_public_key
};

/** Generate an ECDSA P-256 "OpenChat platform" signer. */
export async function generateOcSigner(): Promise<OcSigner> {
  const s = subtle();
  const kp = (await s.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spkiDer = new Uint8Array(await s.exportKey("spki", kp.publicKey));
  return {
    sign: async (preimage) =>
      new Uint8Array(await s.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, toBuf(preimage))),
    publicKeyPem: spkiToPem(spkiDer),
  };
}

export type RawEnvelope = { ephemeralPublicKey: Uint8Array; ciphertext: Uint8Array };

/** ECIES-encrypt `plaintext` to a consumer's raw 65-byte public point (inverse of decryptInboxEnvelope). */
export async function eciesEncrypt(recipientPublicKeyRaw: Uint8Array, plaintext: Uint8Array): Promise<RawEnvelope> {
  const s = subtle();
  const recipientPub = await s.importKey("raw", toBuf(recipientPublicKeyRaw), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = (await s.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = await s.deriveBits({ name: "ECDH", public: recipientPub }, eph.privateKey, 256);
  const hkdfKey = await s.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await s.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: toBuf(new Uint8Array(32)), info: toBuf(new TextEncoder().encode(INFO)) },
      hkdfKey,
      44 * 8,
    ),
  );
  const key = okm.slice(0, 32);
  const nonce = okm.slice(32, 44);
  const aesKey = await s.importKey("raw", toBuf(key), { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await s.encrypt({ name: "AES-GCM", iv: toBuf(nonce), tagLength: 128 }, aesKey, toBuf(plaintext)));
  const ephemeralPublicKey = new Uint8Array(await s.exportKey("raw", eph.publicKey));
  return { ephemeralPublicKey, ciphertext: ct };
}

/** A candid-shaped StoredAction as the inbox `actions` query returns. */
export type StoredActionLike = {
  id: bigint;
  ciphertext: number[];
  ephemeral_public_key: number[];
  oc_signature: number[];
  created_at: bigint;
};

/** Build a signed, encrypted StoredAction addressed to `recipient`, signed by `signer`. */
export async function buildStoredAction(opts: {
  id: bigint;
  createdAt: bigint;
  recipient: ConsumerKeys;
  signer: OcSigner;
  plaintext: string;
}): Promise<StoredActionLike> {
  const env = await eciesEncrypt(opts.recipient.publicKeyRaw, new TextEncoder().encode(opts.plaintext));
  const preimage = new Uint8Array(env.ephemeralPublicKey.length + env.ciphertext.length + 8);
  preimage.set(env.ephemeralPublicKey, 0);
  preimage.set(env.ciphertext, env.ephemeralPublicKey.length);
  new DataView(preimage.buffer).setBigUint64(env.ephemeralPublicKey.length + env.ciphertext.length, opts.createdAt, true);
  const sig = await opts.signer.sign(preimage);
  return {
    id: opts.id,
    created_at: opts.createdAt,
    ciphertext: Array.from(env.ciphertext),
    ephemeral_public_key: Array.from(env.ephemeralPublicKey),
    oc_signature: Array.from(sig),
  };
}
