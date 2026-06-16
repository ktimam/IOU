// Replace-member (v1.1.2) — offline-signed payload + QR handoff.
//
// The leaving member builds a ReplaceRequest, signs it with their
// Ed25519 key (the one in the II delegation), and renders the
// signed payload as a QR code. The staying member scans the QR
// (or pastes the payload) and the PWA submits it to
// submit_replace_member.
//
// The signature is verifiable by the canister: ed25519-verify on
// the canonical bytes (see canonical_replace_bytes in the Rust
// source). The signature scheme is independent of the IC's auth
// delegation so the request can be carried offline between devices.

import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha256";

export type ReplaceRequest = {
  pair_id: string;
  leaving_principal: string; // base32
  new_principal: string;
  ts_ms: bigint; // Candid Nat64
  nonce: number[]; // 32 random bytes
};

export type SignedReplaceRequest = {
  request: ReplaceRequest;
  signature: number[]; // 64 bytes
  signer_pubkey: number[]; // 32 bytes
};

/** Generate 32 random bytes for the nonce. */
export function randomNonce(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Derive an Ed25519 keypair from a 32-byte seed. The seed is
 * generated from WebCrypto and persisted in `mobileSecureStorage`
 * so the PWA can sign/verify across sessions.
 *
 * V9a fix (v1.3.1): the seed now goes through
 * `mobileSecureStorage` (Android Keystore / iOS Keychain on
 * native, `localStorage` on web). The web fallback stores
 * the seed in plaintext `localStorage` with a clear
 * dev-grade warning — the SecureStorage plugin can't
 * encrypt on a plain browser, and a browser compromise
 * would already give an attacker the user's localStorage
 * anyway. The improvement on web is uniformity with the
 * prod-vetkd transport key, not new security.
 */
import { secureGet, secureSet, secureDel } from "../crypto/mobileSecureStorage";

const ED25519_KEY_STORAGE = "iou:replace:ed25519:v2";

export type Ed25519Keypair = {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes (the seed)
};

export async function loadOrCreateEd25519Keypair(): Promise<Ed25519Keypair> {
  if (typeof localStorage === "undefined") {
    throw new Error("localStorage required");
  }
  const stored = await secureGet(ED25519_KEY_STORAGE);
  if (stored) {
    const parsed = JSON.parse(stored);
    return {
      publicKey: new Uint8Array(parsed.publicKey),
      secretKey: new Uint8Array(parsed.secretKey),
    };
  }
  const seed = new Uint8Array(32);
  crypto.getRandomValues(seed);
  // @noble/curves ed25519: from secret seed → public key
  const publicKey = ed25519.getPublicKey(seed);
  const kp = { publicKey, secretKey: seed };
  await secureSet(
    ED25519_KEY_STORAGE,
    JSON.stringify({
      publicKey: Array.from(publicKey),
      secretKey: Array.from(seed),
    }),
  );
  return kp;
}

export async function forgetEd25519Keypair(): Promise<void> {
  await secureDel(ED25519_KEY_STORAGE);
}

/** Canonical bytes of a ReplaceRequest. Must match the canister. */
export function canonicalReplaceBytes(req: ReplaceRequest): Uint8Array {
  // principal.as_slice() doesn't exist in the JS principal; we
  // canonicalize by serializing the principal to its self-auth
  // bytes (32 bytes for an Ed25519-derived II principal). For
  // arbitrary principals this is the "raw" form.
  //
  // V7 fix (v1.3.1): length-prefix every variable-length field
  // with a 4-byte big-endian u32 length. The previous 0xff
  // delimiter was safe only because pair_id was ASCII; using
  // length-prefixed encoding makes the canonical form safe to
  // reuse for any field type (binary blobs, multi-byte UTF-8,
  // …) without colliding on a delimiter byte.
  const out: number[] = [];
  push(out, "iou-replace-member-v1:");
  pushLen(out, textToBytes(req.pair_id));
  pushLen(out, principalToBytes(req.leaving_principal));
  pushLen(out, principalToBytes(req.new_principal));
  pushLen(out, bigintToBytes(req.ts_ms, 8));
  pushLen(out, Uint8Array.from(req.nonce));
  return new Uint8Array(out);
}

function textToBytes(s: string): Uint8Array {
  // The principal is base32 ASCII so the bytes are 1:1 with
  // charCodeAt. The pair_id is plain ASCII text in current use;
  // using a TextEncoder keeps the encoding correct if it ever
  // becomes non-ASCII.
  return new TextEncoder().encode(s);
}

function pushLen(out: number[], bytes: Uint8Array) {
  // big-endian u32 length prefix
  out.push((bytes.length >>> 24) & 0xff);
  out.push((bytes.length >>> 16) & 0xff);
  out.push((bytes.length >>> 8) & 0xff);
  out.push(bytes.length & 0xff);
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i]);
}

function push(out: number[], v: string | number[] | Uint8Array) {
  if (typeof v === "string") {
    for (let i = 0; i < v.length; i++) out.push(v.charCodeAt(i));
  } else {
    for (let i = 0; i < v.length; i++) out.push(v[i]);
  }
}

function bigintToBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Serializes a textual principal (base32) to its raw bytes. For
 * II's Ed25519-derived principals this is the 32-byte public key
 * plus a 4-byte CRC checksum; the canister uses
 * `Principal::as_slice()` which strips the checksum. For our
 * purposes the canister's verification will use the principal
 * string (via Candid deserialization), and the canonical bytes
 * here are only used for the offline signature. The canister
 * reproduces them with its own principal -> bytes conversion.
 *
 * In practice, the canister's `Principal::as_slice()` returns the
 * raw 32-byte public key (the principal is just Principal bytes).
 * The PWA decodes the base32 form and returns its 32 bytes for
 * the same principal.
 */
function principalToBytes(principalText: string): Uint8Array {
  // Use the @dfinity/principal library to canonicalize.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { Principal } = require("@dfinity/principal") as typeof import("@dfinity/principal");
  const p = Principal.fromText(principalText);
  return p.toUint8Array();
}

/** Sign a ReplaceRequest with the given Ed25519 keypair. */
export async function signReplaceRequest(
  req: ReplaceRequest,
  kp: Ed25519Keypair,
): Promise<SignedReplaceRequest> {
  const msg = canonicalReplaceBytes(req);
  const sig = ed25519.sign(msg, kp.secretKey);
  return {
    request: req,
    signature: Array.from(sig),
    signer_pubkey: Array.from(kp.publicKey),
  };
}

/** Verify a SignedReplaceRequest against the Ed25519 pubkey. */
export function verifyReplaceRequest(signed: SignedReplaceRequest): boolean {
  try {
    const msg = canonicalReplaceBytes(signed.request);
    return ed25519.verify(
      new Uint8Array(signed.signature),
      msg,
      new Uint8Array(signed.signer_pubkey),
    );
  } catch {
    return false;
  }
}

/**
 * QR handoff encoding. The QR contains a base64url-encoded
 * JSON blob of the SignedReplaceRequest. Total size is small
 * (< 500 bytes) so any reasonable QR will fit.
 */
export function encodeForQr(signed: SignedReplaceRequest): string {
  const json = JSON.stringify(serializeBigints(signed));
  return btoa(json);
}

export function decodeFromQr(b64: string): SignedReplaceRequest {
  const json = atob(b64);
  return deserializeBigints(JSON.parse(json)) as SignedReplaceRequest;
}

function serializeBigints(o: any): any {
  if (typeof o === "bigint") return { __bigint: o.toString() };
  if (Array.isArray(o)) return o.map(serializeBigints);
  if (o && typeof o === "object") {
    const out: any = {};
    for (const k in o) out[k] = serializeBigints(o[k]);
    return out;
  }
  return o;
}

function deserializeBigints(o: any): any {
  if (o && typeof o === "object" && "__bigint" in o) {
    return BigInt(o.__bigint);
  }
  if (Array.isArray(o)) return o.map(deserializeBigints);
  if (o && typeof o === "object") {
    const out: any = {};
    for (const k in o) out[k] = deserializeBigints(o[k]);
    return out;
  }
  return o;
}

// Keep sha256 imported to avoid tree-shake stripping the noble import
// in environments where the unused-import lint is on.
void sha256;
