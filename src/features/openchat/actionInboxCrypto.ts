// ECIES decryption and v4 action-deposit verification for OpenChat's generic ActionInbox.
//
// Encryption remains ECDH(P-256) -> HKDF-SHA256 -> AES-256-GCM. Provenance is now signed only by
// UserIndex's dedicated action key. The v4 signature binds the authoritative UserIndex/inbox route,
// app/action revision, a private card-context commitment, recipient, replay identity, payload,
// acknowledgement capability, ciphertext, and timestamp. No legacy OpenChat bot/JWT key is trusted.

import { Principal } from "@dfinity/principal";

const INFO = "oc-action-inbox-v1";
const SIGNATURE_DOMAIN_V4 = new TextEncoder().encode("openchat/action-inbox/deposit-signature/v4\0");
const SIGNING_KEY_ID_DOMAIN_V1 = new TextEncoder().encode("openchat/action-inbox/signing-key-id/v1\0");
const CARD_CONTEXT_DOMAIN_V2 = new TextEncoder().encode("openchat/action-inbox/card-context/v2\0");
const CARD_CONFIRM_PAYLOAD_HASH_DOMAIN_V1 = new TextEncoder().encode(
  "openchat.ai-app-card-confirm-payload.v1\0",
);
const ACK_SECRET_DOMAIN_V1 = new TextEncoder().encode("openchat-action-inbox-ack-secret-v1");
const SIGNATURE_VERSION_V4 = 4;
const SIGNATURE_PURPOSE_DEPOSIT = 1;
const HASH_BYTES = 32;

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto SubtleCrypto is not available");
  return subtle;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  return Uint8Array.from(bin, (character) => character.charCodeAt(0));
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/[\r\n\s]/g, "");
  if (body.length === 0) throw new Error("invalid empty PEM");
  return b64ToBytes(body);
}

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function integerBytes(bytes: number, littleEndian: boolean, value: number | bigint): Uint8Array {
  const output = new Uint8Array(bytes);
  const view = new DataView(output.buffer);
  if (bytes === 2) view.setUint16(0, Number(value), littleEndian);
  else if (bytes === 4) view.setUint32(0, Number(value), littleEndian);
  else if (bytes === 8) view.setBigUint64(0, BigInt(value), littleEndian);
  else throw new Error("unsupported integer width");
  return output;
}

function lengthPrefixed(value: Uint8Array, bytes: 1 | 2 | 4, littleEndian: boolean): Uint8Array {
  const limit = bytes === 1 ? 0xff : bytes === 2 ? 0xffff : 0xffff_ffff;
  if (value.length > limit) throw new Error("action-inbox field is too long");
  const prefix = bytes === 1 ? Uint8Array.of(value.length) : integerBytes(bytes, littleEndian, value.length);
  return concatBytes([prefix, value]);
}

function principalFromCanonicalText(text: string, field: string): Principal {
  let principal: Principal;
  try {
    principal = Principal.fromText(text);
  } catch {
    throw new Error(`invalid ${field} principal`);
  }
  if (principal.toText() !== text) throw new Error(`non-canonical ${field} principal`);
  return principal;
}

function principalRaw(principal: Principal): Uint8Array {
  return Uint8Array.from(principal.toUint8Array());
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("hash must be 64 lowercase hexadecimal characters");
  return Uint8Array.from({ length: HASH_BYTES }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

export type InboxEnvelope = {
  ephemeralPublicKey: Uint8Array;
  ciphertext: Uint8Array;
};

export type AppScopedActionCardContextForHash = {
  contextVersion: number;
  appSubject: string;
  chatHandle: string;
  messageHandle: string;
  confirmedAt: number;
  appId: number;
  appRevision: number;
  actionId: string;
  contentHash: string;
  confirmationLeaseGeneration: number;
};

export type ActionSignatureContextV4 = {
  keyId: Uint8Array;
  userIndexCanisterId: string;
  inboxCanisterId: string;
  appId: number;
  appRevision: bigint;
  actionId: string;
  cardContextHash: Uint8Array;
  consumerKeyFingerprint: Uint8Array;
  idempotencyKey: Uint8Array;
  payloadHash: Uint8Array;
  acknowledgementSecretHash: Uint8Array;
  envelope: InboxEnvelope;
  createdAt: bigint;
};

/** Import the consumer's P-256 ECDH private key from PKCS#8 PEM. */
export async function importEcdhPrivateKeyFromPkcs8Pem(pkcs8Pem: string): Promise<CryptoKey> {
  return getSubtle().importKey(
    "pkcs8",
    toBuf(pemToDer(pkcs8Pem)),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

async function importEcdhPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("invalid uncompressed P-256 point");
  return getSubtle().importKey("raw", toBuf(raw), { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export async function decryptInboxEnvelope(
  envelope: InboxEnvelope,
  recipientPrivateKey: CryptoKey,
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const ephemeral = await importEcdhPublicKeyRaw(envelope.ephemeralPublicKey);
  const shared = await subtle.deriveBits({ name: "ECDH", public: ephemeral }, recipientPrivateKey, 256);
  const hkdfKey = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: toBuf(new Uint8Array(32)),
        info: toBuf(new TextEncoder().encode(INFO)),
      },
      hkdfKey,
      44 * 8,
    ),
  );
  const aesKey = await subtle.importKey("raw", toBuf(okm.slice(0, 32)), { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(okm.slice(32, 44)), tagLength: 128 },
    aesKey,
    toBuf(envelope.ciphertext),
  );
  return new Uint8Array(plaintext);
}

/** Purpose-scoped key id: SHA-256(domain || canonical 65-byte uncompressed P-256 point). */
export async function actionSigningKeyId(publicKeyPem: string): Promise<Uint8Array> {
  const subtle = getSubtle();
  const key = await subtle.importKey(
    "spki",
    toBuf(pemToDer(publicKeyPem)),
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["verify"],
  );
  const raw = new Uint8Array(await subtle.exportKey("raw", key));
  return new Uint8Array(await subtle.digest("SHA-256", toBuf(concatBytes([SIGNING_KEY_ID_DOMAIN_V1, raw]))));
}

/** Exact v4 preimage signed by the authoritative UserIndex. */
export function signingPreimageV4(context: ActionSignatureContextV4): Uint8Array {
  const fixed32: Array<[string, Uint8Array]> = [
    ["key id", context.keyId],
    ["card context hash", context.cardContextHash],
    ["consumer fingerprint", context.consumerKeyFingerprint],
    ["idempotency key", context.idempotencyKey],
    ["payload hash", context.payloadHash],
    ["acknowledgement hash", context.acknowledgementSecretHash],
  ];
  for (const [name, value] of fixed32) if (value.length !== HASH_BYTES) throw new Error(`${name} must be 32 bytes`);
  if (context.envelope.ephemeralPublicKey.length !== 65 || context.envelope.ephemeralPublicKey[0] !== 4) {
    throw new Error("ephemeral public key must be a 65-byte uncompressed P-256 point");
  }
  if (context.envelope.ciphertext.length === 0) throw new Error("ciphertext must not be empty");
  const userIndex = principalRaw(principalFromCanonicalText(context.userIndexCanisterId, "UserIndex"));
  const inbox = principalRaw(principalFromCanonicalText(context.inboxCanisterId, "ActionInbox"));
  const action = new TextEncoder().encode(context.actionId);
  return concatBytes([
    SIGNATURE_DOMAIN_V4,
    integerBytes(2, true, SIGNATURE_VERSION_V4),
    Uint8Array.of(SIGNATURE_PURPOSE_DEPOSIT),
    context.keyId,
    lengthPrefixed(userIndex, 1, false),
    lengthPrefixed(inbox, 1, false),
    integerBytes(4, true, context.appId),
    integerBytes(8, true, context.appRevision),
    lengthPrefixed(action, 2, true),
    context.cardContextHash,
    context.consumerKeyFingerprint,
    context.idempotencyKey,
    context.payloadHash,
    context.acknowledgementSecretHash,
    context.envelope.ephemeralPublicKey,
    lengthPrefixed(context.envelope.ciphertext, 4, true),
    integerBytes(8, true, context.createdAt),
  ]);
}

export async function verifyOpenChatActionSignature(
  context: ActionSignatureContextV4,
  signature: Uint8Array,
  actionSigningPublicKeyPem: string,
): Promise<boolean> {
  if (signature.length !== 64) return false;
  const subtle = getSubtle();
  const publicKey = await subtle.importKey(
    "spki",
    toBuf(pemToDer(actionSigningPublicKeyPem)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    toBuf(signature),
    toBuf(signingPreimageV4(context)),
  );
}

function canonicalBase64UrlBytes32(value: string, field: string): Uint8Array {
  if (typeof value !== "string" || value.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`${field} must be canonical unpadded base64url for exactly 32 bytes`);
  }
  let decoded: Uint8Array;
  try {
    decoded = b64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  } catch {
    throw new Error(`${field} must be canonical unpadded base64url for exactly 32 bytes`);
  }
  const canonical = bytesToB64(decoded).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (decoded.length !== HASH_BYTES || canonical !== value) {
    throw new Error(`${field} must be canonical unpadded base64url for exactly 32 bytes`);
  }
  return decoded;
}

/** Commitment recomputed from the app-scoped decrypted v4 context and exact payload bytes. */
export async function actionCardContextHashV2(
  context: AppScopedActionCardContextForHash,
  payloadHash: Uint8Array,
): Promise<Uint8Array> {
  if (payloadHash.length !== HASH_BYTES) throw new Error("payload hash must be 32 bytes");
  if (context.contextVersion !== 1) throw new Error("unsupported app-scoped card context version");
  if (!Number.isSafeInteger(context.appId) || context.appId < 0 || context.appId > 0xffff_ffff) {
    throw new Error("app id must be a u32");
  }
  const appSubject = canonicalBase64UrlBytes32(context.appSubject, "app subject");
  const chatHandle = canonicalBase64UrlBytes32(context.chatHandle, "chat handle");
  const messageHandle = canonicalBase64UrlBytes32(context.messageHandle, "message handle");
  const action = new TextEncoder().encode(context.actionId);
  if (action.length > 0xffff_ffff) throw new Error("action id is too long");
  const canonical = concatBytes([
    CARD_CONTEXT_DOMAIN_V2,
    integerBytes(2, false, context.contextVersion),
    appSubject,
    chatHandle,
    messageHandle,
    integerBytes(4, false, context.appId),
    integerBytes(8, false, BigInt(context.appRevision)),
    integerBytes(4, false, action.length),
    action,
    hexToBytes(context.contentHash),
    integerBytes(8, false, BigInt(context.confirmationLeaseGeneration)),
    integerBytes(8, false, BigInt(context.confirmedAt)),
    payloadHash,
  ]);
  return new Uint8Array(await getSubtle().digest("SHA-256", toBuf(canonical)));
}

/** Exact digest OpenChat binds into confirmation grants and v4 ActionInbox deposits. */
export async function aiAppCardConfirmPayloadHashV1(payload: Uint8Array): Promise<Uint8Array> {
  if (!(payload instanceof Uint8Array)) throw new Error("confirmation payload must be bytes");
  if (payload.length > 0xffff_ffff) throw new Error("AI-app confirmation payload is too large");
  const canonical = concatBytes([
    CARD_CONFIRM_PAYLOAD_HASH_DOMAIN_V1,
    integerBytes(4, false, payload.length),
    payload,
  ]);
  return new Uint8Array(await getSubtle().digest("SHA-256", toBuf(canonical)));
}

export async function acknowledgementSecretHashV1(
  inboxCanisterId: string,
  consumerFingerprint: Uint8Array,
  acknowledgementSecret: Uint8Array,
): Promise<Uint8Array> {
  if (consumerFingerprint.length !== HASH_BYTES || acknowledgementSecret.length !== HASH_BYTES) {
    throw new Error("acknowledgement fingerprint and secret must both be 32 bytes");
  }
  const inbox = principalRaw(principalFromCanonicalText(inboxCanisterId, "ActionInbox"));
  const canonical = concatBytes([
    ACK_SECRET_DOMAIN_V1,
    lengthPrefixed(inbox, 1, false),
    consumerFingerprint,
    acknowledgementSecret,
  ]);
  return new Uint8Array(await getSubtle().digest("SHA-256", toBuf(canonical)));
}

/** Local key identity only. Never send this public-key digest to OpenChat as a queue selector. */
export async function keyFingerprint(spkiPem: string): Promise<Uint8Array> {
  const subtle = getSubtle();
  const publicKey = await subtle.importKey(
    "spki",
    toBuf(pemToDer(spkiPem)),
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
  const raw = new Uint8Array(await subtle.exportKey("raw", publicKey));
  return new Uint8Array(await subtle.digest("SHA-256", toBuf(raw)));
}

export async function fingerprintPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const subtle = getSubtle();
  const raw = new Uint8Array(await subtle.exportKey("raw", publicKey));
  return new Uint8Array(await subtle.digest("SHA-256", toBuf(raw)));
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().digest("SHA-256", toBuf(bytes)));
}

export const __testing = {
  b64ToBytes,
  bytesToB64,
  pemToDer,
  concatBytes,
  integerBytes,
  SIGNATURE_DOMAIN_V4,
  SIGNING_KEY_ID_DOMAIN_V1,
  CARD_CONTEXT_DOMAIN_V2,
  ACK_SECRET_DOMAIN_V1,
  canonicalBase64UrlBytes32,
};
