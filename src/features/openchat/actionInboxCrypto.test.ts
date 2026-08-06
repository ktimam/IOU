import { describe, expect, it } from "vitest";
import { Principal } from "@dfinity/principal";
import {
  aiAppCardConfirmPayloadHashV1,
  actionCardContextHashV2,
  actionSigningKeyId,
  decryptInboxEnvelope,
  importEcdhPrivateKeyFromPkcs8Pem,
  keyFingerprint,
  sha256,
  signingPreimageV4,
  verifyOpenChatActionSignature,
  __testing,
} from "./actionInboxCrypto";
import {
  buildStoredAction,
  bytesToHex,
  generateConsumerKeys,
  generateOcSigner,
  TEST_INBOX_CANISTER_ID,
  TEST_USER_INDEX_CANISTER_ID,
  testContext,
} from "./ecTestKit";

const { b64ToBytes } = __testing;
const hexBytes = (hex: string) =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));

// Rust ecies_payload interoperability vector (StdRng seed 424242). The v4 signing contract changed,
// but the recipient encryption wire format remains exactly this OpenChat Rust format.
const RUST_ECIES_VECTOR = {
  recipient_sk_pem_b64:
    "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUdIQWdFQU1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhCRzB3YXdJQkFRUWdubWp0TktHU2lkRU96ZHhrDQpqRTI4bkh3TFd3QkRZVWxTbDZyYmo1OHIrV3FoUkFOQ0FBUnJESmo1VTJPQkF0bGdyNzJGSmNBSWFNYjVOT1BNDQp3T1FYMDVIMWdzeWthN3Nheitld1JJNWxyRWtudzlTaTBCMGV6OXl0TTlZZGpXZ2NJenR1OGlLSw0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQ0K",
  recipient_pk_pem_b64:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0NCk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRWF3eVkrVk5qZ1FMWllLKzloU1hBQ0dqRytUVGoNCnpNRGtGOU9SOVlMTXBHdTdHcy9uc0VTT1pheEpKOFBVb3RBZEhzL2NyVFBXSFkxb0hDTTdidklpaWc9PQ0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tDQo=",
  ephemeral_public_key_b64:
    "BM8/i9pzJUADvSgLGzaep8oPGY+6u8tG8rtiHKDWb4wtXzdtTSY/mCyvv25wuRcN6dg+mIKIPQSOlrLoqHsADik=",
  ciphertext_b64:
    "nvDw0tfQh5q51eoPJyWgKEr7htH9gsK+gaWbzKuslQoDC0uEQQ9KRP80GYIsbToRN2rkIcB699WHlw3dUQn5vSOnjj0qtSgPwg3WvWE+T2dLXsHOQvNLlg==",
  expected_plaintext: '{"action_id":"example.action","rows":[{"label":"Amount","value":"$20"}]}',
  fingerprint_hex: "2d86d5f2f9c5204734f13f2a39f2f724848b775543ab847243c78d91cd126137",
};

describe("action_inbox ECIES interoperability", () => {
  it("decrypts the exact Rust ecies_payload wire format", async () => {
    const privatePem = new TextDecoder().decode(b64ToBytes(RUST_ECIES_VECTOR.recipient_sk_pem_b64));
    const privateKey = await importEcdhPrivateKeyFromPkcs8Pem(privatePem);
    const plaintext = await decryptInboxEnvelope(
      {
        ephemeralPublicKey: b64ToBytes(RUST_ECIES_VECTOR.ephemeral_public_key_b64),
        ciphertext: b64ToBytes(RUST_ECIES_VECTOR.ciphertext_b64),
      },
      privateKey,
    );
    expect(new TextDecoder().decode(plaintext)).toBe(RUST_ECIES_VECTOR.expected_plaintext);
  });

  it("matches Rust's SHA-256 routing fingerprint", async () => {
    const publicPem = new TextDecoder().decode(b64ToBytes(RUST_ECIES_VECTOR.recipient_pk_pem_b64));
    expect(bytesToHex(await keyFingerprint(publicPem))).toBe(RUST_ECIES_VECTOR.fingerprint_hex);
  });
});

describe("action_inbox v4 signing and card commitments", () => {
  it("matches OpenChat's domain-separated v1 confirmation-payload hash", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({
      id: 1n,
      createdAt: 1_800_000_000_000n,
      recipient,
      signer,
      payload: {},
    });
    const payloadBytes = new TextEncoder().encode("{}");
    expect(bytesToHex(Uint8Array.from(action.payload_hash))).toBe(
      "ef927aa531deb350681dc6c32a857619b5ea10bb55f74085fdf379c198d30c28",
    );
    expect(bytesToHex(Uint8Array.from(action.payload_hash))).not.toBe(
      bytesToHex(await sha256(payloadBytes)),
    );

    const empty = await aiAppCardConfirmPayloadHashV1(new Uint8Array());
    const oneZero = await aiAppCardConfirmPayloadHashV1(Uint8Array.of(0));
    const twoZeroes = await aiAppCardConfirmPayloadHashV1(Uint8Array.of(0, 0));
    expect(empty).toHaveLength(32);
    expect(bytesToHex(empty)).not.toBe(bytesToHex(oneZero));
    expect(bytesToHex(oneZero)).not.toBe(bytesToHex(twoZeroes));

    const maxSupported = new Uint8Array(16 * 1024).fill(0xa5);
    const changedByte = maxSupported.slice();
    changedByte[changedByte.length - 1] ^= 1;
    expect(await aiAppCardConfirmPayloadHashV1(maxSupported)).toHaveLength(32);
    expect(bytesToHex(await aiAppCardConfirmPayloadHashV1(maxSupported))).not.toBe(
      bytesToHex(await aiAppCardConfirmPayloadHashV1(changedByte)),
    );
  });

  it("matches OpenChat Rust's independent v4 preimage and private-context golden digests", async () => {
    const preimage = signingPreimageV4({
      keyId: new Uint8Array(32).fill(0x11),
      userIndexCanisterId: Principal.fromUint8Array(Uint8Array.of(1, 2, 3)).toText(),
      inboxCanisterId: Principal.fromUint8Array(Uint8Array.of(4, 5, 6, 7)).toText(),
      appId: 0x0102_0304,
      appRevision: 0x0102_0304_0506_0708n,
      actionId: "expense.import",
      cardContextHash: new Uint8Array(32).fill(0x22),
      consumerKeyFingerprint: new Uint8Array(32).fill(0x33),
      idempotencyKey: new Uint8Array(32).fill(0x44),
      payloadHash: new Uint8Array(32).fill(0x55),
      acknowledgementSecretHash: new Uint8Array(32).fill(0x66),
      envelope: {
        ephemeralPublicKey: Uint8Array.from([0x04, ...new Uint8Array(64).fill(0x77)]),
        ciphertext: Uint8Array.of(0x80, 0x00, 0xff, 0x01),
      },
      createdAt: 0x1112_1314_1516_1718n,
    });
    expect(preimage).toHaveLength(356);
    expect(bytesToHex(await sha256(preimage))).toBe("650b89918e00a625e843f06151fbfdbd2d2af970e74bdc45307f32c471ef3389");

    const contextHash = await actionCardContextHashV2(
      {
        contextVersion: 1,
        appSubject: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
        chatHandle: Buffer.from(new Uint8Array(32).fill(2)).toString("base64url"),
        messageHandle: Buffer.from(new Uint8Array(32).fill(3)).toString("base64url"),
        confirmedAt: 1_720_000_000_000,
        appId: 17,
        appRevision: 23,
        actionId: "expense.import",
        contentHash: "aa".repeat(32),
        confirmationLeaseGeneration: 3,
      },
      new Uint8Array(32).fill(0xbb),
    );
    expect(bytesToHex(contextHash)).toBe("312da5d5ab8e3d67c56b0e90313dac5d680a1a8345d14c39feecd9b054492467");
  });

  it("verifies OpenChat Rust's raw P1363 v4 signature golden vector", async () => {
    const publicKeyPem =
      "-----BEGIN PUBLIC KEY-----\n" +
      "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEb/A7lJJBzh2t1DUZ5pYOCoW0Gmmg\n" +
      "XDKBA6orzhWUyhY8T3U6Vb8B3FP2wLDH7ueLQMb/fSWpbiKCuYnO9xwUSg==\n" +
      "-----END PUBLIC KEY-----\n";
    const keyId = await actionSigningKeyId(publicKeyPem);
    expect(bytesToHex(keyId)).toBe("c4109bdc5946e2419731c8770f4cc0077ef4d7c88abca84e9479d96f3fe498fd");
    const context = {
      keyId,
      userIndexCanisterId: Principal.fromUint8Array(Uint8Array.of(1, 2, 3)).toText(),
      inboxCanisterId: Principal.fromUint8Array(Uint8Array.of(4, 5, 6, 7)).toText(),
      appId: 17,
      appRevision: 23n,
      actionId: "expense.import",
      cardContextHash: hexBytes("312da5d5ab8e3d67c56b0e90313dac5d680a1a8345d14c39feecd9b054492467"),
      consumerKeyFingerprint: new Uint8Array(32).fill(0x33),
      idempotencyKey: new Uint8Array(32).fill(0x44),
      payloadHash: new Uint8Array(32).fill(0xbb),
      acknowledgementSecretHash: new Uint8Array(32).fill(0x66),
      envelope: {
        ephemeralPublicKey: Uint8Array.from([0x04, ...new Uint8Array(64).fill(0x77)]),
        ciphertext: Uint8Array.of(0x80, 0x00, 0xff, 0x01),
      },
      createdAt: 1_720_000_000_000n,
    };
    expect(bytesToHex(await sha256(signingPreimageV4(context)))).toBe(
      "d9cfc26dcc266baf1458ed47de26e5713bf310777ecc37ab2b5845c54b7337d9",
    );
    await expect(
      verifyOpenChatActionSignature(
        context,
        hexBytes(
          "3b04ebad45dad4fb46ad255e5fa7616ad05e3245b916fdfb25c105f1bb97ebe1c" +
            "8f2b866d2e62f1ea814b1fad7433497c248ab7ec13ca19df3cea69e61f683b3",
        ),
        publicKeyPem,
      ),
    ).resolves.toBe(true);
  });

  it("verifies a full v4 deposit signed by the dedicated UserIndex key", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({
      id: 1n,
      createdAt: 1_800_000_000_000n,
      recipient,
      signer,
    });
    const envelope = {
      ephemeralPublicKey: Uint8Array.from(action.ephemeral_public_key),
      ciphertext: Uint8Array.from(action.ciphertext),
    };
    await expect(
      verifyOpenChatActionSignature(
        {
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
          envelope,
          createdAt: action.created_at,
        },
        Uint8Array.from(action.oc_signature),
        signer.publicKeyPem,
      ),
    ).resolves.toBe(true);
  });

  it("uses a purpose-scoped key id distinct from the legacy routing fingerprint", async () => {
    const signer = await generateOcSigner();
    const keyId = await actionSigningKeyId(signer.publicKeyPem);
    const legacyFingerprint = await keyFingerprint(signer.publicKeyPem);
    expect(keyId).toHaveLength(32);
    expect(bytesToHex(keyId)).toBe(bytesToHex(signer.keyId));
    expect(bytesToHex(keyId)).not.toBe(bytesToHex(legacyFingerprint));
  });

  it("pins the v4 domain, little-endian version, purpose, and timestamp layout", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({ id: 1n, createdAt: 1_800_000_000_123n, recipient, signer });
    const preimage = signingPreimageV4({
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
      envelope: {
        ephemeralPublicKey: Uint8Array.from(action.ephemeral_public_key),
        ciphertext: Uint8Array.from(action.ciphertext),
      },
      createdAt: action.created_at,
    });
    const domain = new TextEncoder().encode("openchat/action-inbox/deposit-signature/v4\0");
    expect(Array.from(preimage.slice(0, domain.length))).toEqual(Array.from(domain));
    expect(new DataView(preimage.buffer, preimage.byteOffset + domain.length, 2).getUint16(0, true)).toBe(4);
    expect(preimage[domain.length + 2]).toBe(1);
    expect(new DataView(preimage.buffer, preimage.byteOffset + preimage.length - 8, 8).getBigUint64(0, true)).toBe(
      action.created_at,
    );
  });

  it("changes the context commitment for adjacent app-scoped provenance", async () => {
    const base = testContext();
    const payloadHash = await sha256(new TextEncoder().encode("{}"));
    const contextA = await actionCardContextHashV2(base, payloadHash);
    const contextB = await actionCardContextHashV2(
      { ...base, confirmationLeaseGeneration: 3 },
      payloadHash,
    );
    const contextC = await actionCardContextHashV2(
      {
        ...base,
        messageHandle: Buffer.from(new Uint8Array(32).fill(4)).toString("base64url"),
      },
      payloadHash,
    );
    expect(bytesToHex(contextA)).not.toBe(bytesToHex(contextB));
    expect(bytesToHex(contextA)).not.toBe(bytesToHex(contextC));
  });
});
