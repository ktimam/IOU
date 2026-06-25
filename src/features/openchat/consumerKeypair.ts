// Persistent P-256 consumer keypair for the OpenChat on-chain action_inbox.
//
// The PUBLIC key (exported as a SPKI PEM) is what the user registers with OpenChat as the recipient OpenChat
// encrypts confirmed actions to. The PRIVATE key (ECDH) decrypts inbox envelopes locally. The routing
// fingerprint (sha256 of the raw 65-byte point) is what the inbox `actions` query is keyed by.
//
// Stored in localStorage as { privateKeyJwk, publicKeySpkiB64 } — same durability model the app already uses
// for its dev sheet keypair (see crypto/devVetkd deriveUserKeypair).

import { fingerprintPublicKey } from "./actionInboxCrypto";

const LS_KEY = "iou.openchat.consumerKeypair.v1";

function getSubtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto SubtleCrypto is not available");
  return s;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBuf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function spkiDerToPem(der: Uint8Array): string {
  const body = bytesToB64(der).match(/.{1,64}/g)?.join("\n") ?? bytesToB64(der);
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

type Stored = { privateKeyJwk: JsonWebKey; publicKeySpkiB64: string };

function load(): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

async function generate(): Promise<Stored> {
  const subtle = getSubtle();
  const kp = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const privateKeyJwk = await subtle.exportKey("jwk", kp.privateKey);
  const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  const stored: Stored = { privateKeyJwk, publicKeySpkiB64: bytesToB64(spki) };
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(stored));
  } catch {
    /* non-persistent contexts (e.g. tests) still work for the lifetime of the process */
  }
  return stored;
}

export type ConsumerKeypair = {
  privateKey: CryptoKey; // ECDH, deriveBits — decrypts inbox envelopes
  publicKey: CryptoKey; // ECDH public
  publicKeySpkiPem: string; // register this with OpenChat as recipient_public_key
  fingerprint: Uint8Array; // sha256(raw point) — the inbox routing key
};

/** Load the persisted consumer keypair, generating + storing one on first use. */
export async function loadOrCreateConsumerKeypair(): Promise<ConsumerKeypair> {
  const subtle = getSubtle();
  const stored = load() ?? (await generate());

  const privateKey = await subtle.importKey(
    "jwk",
    stored.privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const spkiDer = b64ToBytes(stored.publicKeySpkiB64);
  const publicKey = await subtle.importKey("spki", toBuf(spkiDer), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const fingerprint = await fingerprintPublicKey(publicKey);

  return { privateKey, publicKey, publicKeySpkiPem: spkiDerToPem(spkiDer), fingerprint };
}

/** Convenience: the SPKI PEM to register with OpenChat. */
export async function consumerPublicKeyPem(): Promise<string> {
  return (await loadOrCreateConsumerKeypair()).publicKeySpkiPem;
}
