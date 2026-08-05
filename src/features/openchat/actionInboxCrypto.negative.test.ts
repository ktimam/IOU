import { describe, expect, it } from "vitest";
import {
  decryptInboxEnvelope,
  fingerprintPublicKey,
  keyFingerprint,
  verifyOpenChatActionSignature,
  type ActionSignatureContextV4,
} from "./actionInboxCrypto";
import {
  buildStoredAction,
  generateConsumerKeys,
  generateOcSigner,
  TEST_INBOX_CANISTER_ID,
  TEST_USER_INDEX_CANISTER_ID,
  type StoredActionLike,
} from "./ecTestKit";

const CREATED_AT = 1_800_000_000_123n;

function envOf(action: StoredActionLike) {
  return {
    ephemeralPublicKey: Uint8Array.from(action.ephemeral_public_key),
    ciphertext: Uint8Array.from(action.ciphertext),
  };
}

function signatureContext(action: StoredActionLike): ActionSignatureContextV4 {
  return {
    keyId: Uint8Array.from(action.signing_key_id),
    userIndexCanisterId: TEST_USER_INDEX_CANISTER_ID,
    inboxCanisterId: TEST_INBOX_CANISTER_ID,
    appId: action.app_id,
    appRevision: action.app_revision,
    actionId: action.action_id,
    cardContextHash: Uint8Array.from(action.card_context_hash),
    consumerKeyFingerprint: Uint8Array.from(action.consumer_key_fingerprint),
    idempotencyKey: Uint8Array.from(action.idempotency_key),
    payloadHash: Uint8Array.from(action.payload_hash),
    acknowledgementSecretHash: Uint8Array.from(action.acknowledgement_secret_hash),
    envelope: envOf(action),
    createdAt: action.created_at,
  };
}

function flipped(bytes: Uint8Array, index = 0): Uint8Array {
  const copy = Uint8Array.from(bytes);
  copy[index] ^= 1;
  return copy;
}

describe("ECIES authenticated decryption negatives", () => {
  it("rejects the wrong recipient, changed ciphertext, and changed ephemeral point", async () => {
    const recipient = await generateConsumerKeys();
    const other = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer });
    await expect(decryptInboxEnvelope(envOf(action), other.privateKey)).rejects.toBeTruthy();

    const changedCiphertext = envOf(action);
    await expect(
      decryptInboxEnvelope(
        { ...changedCiphertext, ciphertext: flipped(changedCiphertext.ciphertext) },
        recipient.privateKey,
      ),
    ).rejects.toBeTruthy();

    const changedPoint = envOf(action);
    await expect(
      decryptInboxEnvelope(
        { ...changedPoint, ephemeralPublicKey: flipped(changedPoint.ephemeralPublicKey, 20) },
        recipient.privateKey,
      ),
    ).rejects.toBeTruthy();
  });
});

describe("v4 provenance signature negatives", () => {
  it("rejects every independently tampered authenticated deposit field", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer });
    const base = signatureContext(action);
    const cases: Array<[string, ActionSignatureContextV4]> = [
      ["key id", { ...base, keyId: flipped(base.keyId) }],
      ["UserIndex route", { ...base, userIndexCanisterId: TEST_INBOX_CANISTER_ID }],
      ["inbox route", { ...base, inboxCanisterId: TEST_USER_INDEX_CANISTER_ID }],
      ["app id", { ...base, appId: base.appId + 1 }],
      ["app revision", { ...base, appRevision: base.appRevision + 1n }],
      ["action id", { ...base, actionId: `${base.actionId}.changed` }],
      ["private card context", { ...base, cardContextHash: flipped(base.cardContextHash) }],
      ["recipient", { ...base, consumerKeyFingerprint: flipped(base.consumerKeyFingerprint) }],
      ["replay identity", { ...base, idempotencyKey: flipped(base.idempotencyKey) }],
      ["payload", { ...base, payloadHash: flipped(base.payloadHash) }],
      ["acknowledgement", { ...base, acknowledgementSecretHash: flipped(base.acknowledgementSecretHash) }],
      [
        "ephemeral point",
        { ...base, envelope: { ...base.envelope, ephemeralPublicKey: flipped(base.envelope.ephemeralPublicKey, 20) } },
      ],
      ["ciphertext", { ...base, envelope: { ...base.envelope, ciphertext: flipped(base.envelope.ciphertext) } }],
      ["created_at", { ...base, createdAt: base.createdAt + 1n }],
    ];
    for (const [name, changed] of cases) {
      await expect(
        verifyOpenChatActionSignature(changed, Uint8Array.from(action.oc_signature), signer.publicKeyPem),
        name,
      ).resolves.toBe(false);
    }
  });

  it("rejects a changed signature, wrong platform key, and non-64-byte signature", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const impostor = await generateOcSigner();
    const action = await buildStoredAction({ id: 1n, createdAt: CREATED_AT, recipient, signer });
    const context = signatureContext(action);
    await expect(
      verifyOpenChatActionSignature(context, flipped(Uint8Array.from(action.oc_signature)), signer.publicKeyPem),
    ).resolves.toBe(false);
    await expect(
      verifyOpenChatActionSignature(context, Uint8Array.from(action.oc_signature), impostor.publicKeyPem),
    ).resolves.toBe(false);
    await expect(verifyOpenChatActionSignature(context, new Uint8Array(63), signer.publicKeyPem)).resolves.toBe(false);
  });
});

describe("recipient routing fingerprint", () => {
  it("matches PEM, CryptoKey, and raw point representations", async () => {
    const recipient = await generateConsumerKeys();
    const fromPem = await keyFingerprint(recipient.spkiPem);
    const publicKey = await globalThis.crypto.subtle.importKey(
      "raw",
      recipient.publicKeyRaw.slice().buffer as ArrayBuffer,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      [],
    );
    const fromKey = await fingerprintPublicKey(publicKey);
    expect(Array.from(fromPem)).toEqual(Array.from(recipient.fingerprint));
    expect(Array.from(fromKey)).toEqual(Array.from(recipient.fingerprint));
    expect(Array.from((await generateConsumerKeys()).fingerprint)).not.toEqual(Array.from(recipient.fingerprint));
  });
});
