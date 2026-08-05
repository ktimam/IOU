// Test-only producers for OpenChat's exact v4 ActionInbox wire format. Application code never
// imports this module. Tests use it to create real P-256 ECDSA signatures and ECIES envelopes,
// then mutate individual authenticated fields to prove that the consumer fails closed.

import {
  acknowledgementSecretHashV1,
  actionCardContextHashV2,
  actionSigningKeyId,
  sha256,
  signingPreimageV4,
  type AppScopedActionCardContextForHash,
} from "./actionInboxCrypto";

const INFO = "oc-action-inbox-v1";

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("WebCrypto SubtleCrypto is not available");
  return value;
}

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return typeof btoa === "function" ? btoa(binary) : Buffer.from(binary, "binary").toString("base64");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function spkiToPem(der: Uint8Array): string {
  const base64 = bytesToB64(der);
  const body = base64.match(/.{1,64}/g)?.join("\n") ?? base64;
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

export type ConsumerKeys = {
  privateKey: CryptoKey;
  publicKeyRaw: Uint8Array;
  spkiPem: string;
  fingerprint: Uint8Array;
};

export async function generateConsumerKeys(): Promise<ConsumerKeys> {
  const crypto = subtle();
  const pair = (await crypto.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(await crypto.exportKey("raw", pair.publicKey));
  const spkiDer = new Uint8Array(await crypto.exportKey("spki", pair.publicKey));
  const fingerprint = new Uint8Array(await crypto.digest("SHA-256", toBuf(publicKeyRaw)));
  return { privateKey: pair.privateKey, publicKeyRaw, spkiPem: spkiToPem(spkiDer), fingerprint };
}

export type OcSigner = {
  sign: (preimage: Uint8Array) => Promise<Uint8Array>;
  publicKeyPem: string;
  keyId: Uint8Array;
};

/** Generate a dedicated UserIndex ActionInbox signer (never the legacy bot/JWT key). */
export async function generateOcSigner(): Promise<OcSigner> {
  const crypto = subtle();
  const pair = (await crypto.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicKeyPem = spkiToPem(new Uint8Array(await crypto.exportKey("spki", pair.publicKey)));
  return {
    sign: async (preimage) =>
      new Uint8Array(await crypto.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, toBuf(preimage))),
    publicKeyPem,
    keyId: await actionSigningKeyId(publicKeyPem),
  };
}

export type RawEnvelope = { ephemeralPublicKey: Uint8Array; ciphertext: Uint8Array };

export async function eciesEncrypt(
  recipientPublicKeyRaw: Uint8Array,
  plaintext: Uint8Array,
): Promise<RawEnvelope> {
  const crypto = subtle();
  const recipient = await crypto.importKey(
    "raw",
    toBuf(recipientPublicKeyRaw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = (await crypto.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const shared = await crypto.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, 256);
  const hkdfKey = await crypto.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const material = new Uint8Array(
    await crypto.deriveBits(
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
  const aesKey = await crypto.importKey(
    "raw",
    toBuf(material.slice(0, 32)),
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const ciphertext = new Uint8Array(
    await crypto.encrypt(
      { name: "AES-GCM", iv: toBuf(material.slice(32, 44)), tagLength: 128 },
      aesKey,
      toBuf(plaintext),
    ),
  );
  const ephemeralPublicKey = new Uint8Array(await crypto.exportKey("raw", ephemeral.publicKey));
  return { ephemeralPublicKey, ciphertext };
}

export const TEST_USER_INDEX_CANISTER_ID = "aaaaa-aa";
export const TEST_INBOX_CANISTER_ID = "2vxsx-fae";
export const TEST_CONSUMER_QUEUE_SELECTOR = Uint8Array.from(
  { length: 32 },
  (_, index) => 0x80 + index,
);

export function testContext(createdAt = 1_800_000_000_000): AppScopedActionCardContextForHash {
  return {
    contextVersion: 1,
    appSubject: bytesToBase64Url(new Uint8Array(32).fill(1)),
    chatHandle: bytesToBase64Url(new Uint8Array(32).fill(2)),
    messageHandle: bytesToBase64Url(new Uint8Array(32).fill(3)),
    confirmedAt: createdAt,
    appId: 7,
    appRevision: 3,
    actionId: "iou.create_entry",
    contentHash: "11".repeat(32),
    confirmationLeaseGeneration: 2,
  };
}

export type StoredActionLike = {
  id: bigint;
  app_id: number;
  app_revision: bigint;
  action_id: string;
  consumer_key_fingerprint: number[];
  idempotency_key: number[];
  payload_hash: number[];
  card_context_hash: number[];
  acknowledgement_secret_hash: number[];
  ciphertext: number[];
  ephemeral_public_key: number[];
  signature_version: number;
  signing_key_id: number[];
  oc_signature: number[];
  created_at: bigint;
};

export async function buildStoredAction(opts: {
  id: bigint;
  createdAt: bigint;
  recipient: ConsumerKeys;
  signer: OcSigner;
  payload?: unknown;
  context?: AppScopedActionCardContextForHash;
  consumerKeySelector?: Uint8Array;
  acknowledgementSecret?: Uint8Array;
  userIndexCanisterId?: string;
  inboxCanisterId?: string;
}): Promise<StoredActionLike> {
  const createdAt = Number(opts.createdAt);
  if (!Number.isSafeInteger(createdAt)) throw new Error("test createdAt must fit a JavaScript safe integer");
  const context = opts.context ?? testContext(createdAt);
  const payloadBytes = new TextEncoder().encode(JSON.stringify(opts.payload ?? { amount: "12.50", type: "rent" }));
  const acknowledgementSecret = opts.acknowledgementSecret ?? Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      envelopeVersion: 4,
      payloadEncoding: "base64url",
      payload: bytesToBase64Url(payloadBytes),
      context,
      acknowledgementSecret: bytesToBase64Url(acknowledgementSecret),
    }),
  );
  const envelope = await eciesEncrypt(opts.recipient.publicKeyRaw, plaintext);
  const userIndexCanisterId = opts.userIndexCanisterId ?? TEST_USER_INDEX_CANISTER_ID;
  const inboxCanisterId = opts.inboxCanisterId ?? TEST_INBOX_CANISTER_ID;
  const consumerKeySelector = opts.consumerKeySelector ?? TEST_CONSUMER_QUEUE_SELECTOR;
  if (consumerKeySelector.length !== 32) throw new Error("test selector must be exactly 32 bytes");
  const payloadHash = await sha256(payloadBytes);
  const cardContextHash = await actionCardContextHashV2(context, payloadHash);
  const idempotencyKey = await sha256(
    new TextEncoder().encode(`test-delivery:${opts.id}:${context.messageHandle}`),
  );
  const acknowledgementSecretHash = await acknowledgementSecretHashV1(
    inboxCanisterId,
    consumerKeySelector,
    acknowledgementSecret,
  );
  const signature = await opts.signer.sign(
    signingPreimageV4({
      keyId: opts.signer.keyId,
      userIndexCanisterId,
      inboxCanisterId,
      appId: context.appId,
      appRevision: BigInt(context.appRevision),
      actionId: context.actionId,
      cardContextHash,
      consumerKeyFingerprint: consumerKeySelector,
      idempotencyKey,
      payloadHash,
      acknowledgementSecretHash,
      envelope,
      createdAt: opts.createdAt,
    }),
  );
  return {
    id: opts.id,
    app_id: context.appId,
    app_revision: BigInt(context.appRevision),
    action_id: context.actionId,
    consumer_key_fingerprint: Array.from(consumerKeySelector),
    idempotency_key: Array.from(idempotencyKey),
    payload_hash: Array.from(payloadHash),
    card_context_hash: Array.from(cardContextHash),
    acknowledgement_secret_hash: Array.from(acknowledgementSecretHash),
    ciphertext: Array.from(envelope.ciphertext),
    ephemeral_public_key: Array.from(envelope.ephemeralPublicKey),
    signature_version: 4,
    signing_key_id: Array.from(opts.signer.keyId),
    oc_signature: Array.from(signature),
    created_at: opts.createdAt,
  };
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
