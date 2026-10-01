import { beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalDeliveryEncryption, decryptLocalImportEnvelope, encodeIouDeliveryContext,
  localDeliveryAdditionalData, localDeliveryBase64Url, localDeliveryDecode, LOCAL_DELIVERY_DOMAIN, LOCAL_DELIVERY_SCHEME,
  parseLocalDeliveryEncryption, parseLocalEncryptedEnvelope, type LocalDeliveryEncryption, type LocalEncryptedRequest } from "./localImportEncryption";
import { createLocalImportReceiver, decryptPendingLocalImport, type LocalImportEvent } from "./localImportHandoff";

const destination = "https://iou.example/openchat/import";
const context = { principal: "aaaaa-aa", backendHost: "https://icp-api.io", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai",
  pairId: "0123456789abcdef", sheetId: "fedcba9876543210" };
const payload = { entries: [{ amount: 12900, currency: "EGP", kind: "settlement", direction: "credit", date: "2026-08-14", note: "تمت العملية بنجاح" }] };
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
let keys: CryptoKeyPair, recipient: LocalDeliveryEncryption, request: LocalEncryptedRequest;
async function seal(value: unknown = payload): Promise<LocalEncryptedRequest> {
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: keys.publicKey }, ephemeral.privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: new TextEncoder().encode(LOCAL_DELIVERY_DOMAIN) }, hkdf,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const result: LocalEncryptedRequest = { importId: "A".repeat(43), appId: "iou", appRevision: "local-import-v2", actionId: "iou.entry.import", destination,
    envelope: { version: 1, scheme: LOCAL_DELIVERY_SCHEME, keyId: recipient.keyId, recipientContext: recipient.recipientContext,
      ephemeralPublicKey: localDeliveryBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
      salt: localDeliveryBase64Url(salt), iv: localDeliveryBase64Url(iv), ciphertext: "" } };
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: buffer(localDeliveryAdditionalData(result)), tagLength: 128 },
    aes, new TextEncoder().encode(JSON.stringify(value)));
  return { ...result, envelope: { ...result.envelope, ciphertext: localDeliveryBase64Url(new Uint8Array(ciphertext)) } };
}
beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  recipient = await createLocalDeliveryEncryption(keys.publicKey, context);
  request = await seal();
});

describe("versioned sender-encrypted IOU delivery", () => {
  it("decrypts only after exact recipient/context checks, without exposing fields in the wire", async () => {
    const assertCurrent = vi.fn();
    expect(await decryptLocalImportEnvelope(request, keys.privateKey, recipient, destination, assertCurrent)).toEqual(payload);
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(request)).not.toMatch(/12900|EGP|2026-08-14|تمت|entries|note/);
    expect(localDeliveryDecode(recipient.publicKeySpki, 91)).toHaveLength(91);
  });
  it("pins exact AAD order, stable request ID and domain separation", () => {
    expect(new TextDecoder().decode(localDeliveryAdditionalData(request))).toBe(JSON.stringify([
      "openchat/private-app/handoff/v1", "iou", "local-import-v2", "iou.entry.import", destination, "A".repeat(43), recipient.keyId, recipient.recipientContext,
    ]));
    expect(new TextDecoder().decode(localDeliveryDecode(recipient.recipientContext, 1, 1536))).toBe(JSON.stringify([
      1, context.principal, context.backendHost, context.backendCanisterId, context.pairId, context.sheetId,
    ]));
  });
  it.each(["appId", "appRevision", "actionId", "destination", "importId"] as const)("rejects changed authenticated header %s", async key => {
    await expect(decryptLocalImportEnvelope({ ...request, [key]: key === "importId" ? "B".repeat(42) + "A" : "changed" }, keys.privateKey, recipient, destination, () => {})).rejects.toThrow();
  });
  it.each(["ephemeralPublicKey", "salt", "iv", "ciphertext"] as const)("rejects altered envelope %s", async key => {
    const changed = localDeliveryDecode(request.envelope[key], 1, 65552); changed[changed.length - 1] ^= 1;
    await expect(decryptLocalImportEnvelope({ ...request, envelope: { ...request.envelope, [key]: localDeliveryBase64Url(changed) } }, keys.privateKey, recipient, destination, () => {})).rejects.toThrow();
  });
  it.each(["principal", "backendHost", "backendCanisterId", "pairId", "sheetId"] as const)("rejects another recipient %s", async key => {
    const changed = { ...context, [key]: key.endsWith("Id") && key !== "backendCanisterId" ? "1111111111111111" : key === "backendHost" ? "https://elsewhere.example" : "2ibo7-dia" };
    await expect(decryptLocalImportEnvelope(request, keys.privateKey, { ...recipient, recipientContext: encodeIouDeliveryContext(changed) }, destination, () => {})).rejects.toThrow();
  });
  it("rejects wrong/rotated keys and auth changes while decrypting", async () => {
    const other = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    await expect(decryptLocalImportEnvelope(request, other.privateKey, recipient, destination, () => {})).rejects.toThrow();
    await expect(decryptLocalImportEnvelope(request, keys.privateKey, { ...recipient, keyId: "0".repeat(64) }, destination, () => {})).rejects.toThrow();
    let checks = 0;
    await expect(decryptLocalImportEnvelope(request, keys.privateKey, recipient, destination, () => { if (++checks === 2) throw new Error("signed out"); })).rejects.toThrow("signed out");
  });
  it("rejects extra fields, unknown schemes, bad encodings, lengths and accessors", () => {
    for (const altered of [null, { ...request.envelope, payload }, { ...request.envelope, version: 2 }, { ...request.envelope, scheme: "none" },
      { ...request.envelope, salt: request.envelope.salt + "=" }, { ...request.envelope, iv: "AA" }, { ...request.envelope, ciphertext: "A".repeat(100000) },
      { ...request.envelope, recipientContext: "A".repeat(2049) }, { ...request.envelope, ephemeralPublicKey: localDeliveryBase64Url(new Uint8Array(65)) }]) {
      expect(parseLocalEncryptedEnvelope(altered)).toBeUndefined();
    }
    const read = vi.fn();
    expect(parseLocalEncryptedEnvelope(Object.defineProperty({ ...request.envelope }, "ciphertext", { enumerable: true, get: read }))).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(parseLocalDeliveryEncryption({ ...recipient, secret: "not permitted" })).toBeUndefined();
    expect(parseLocalDeliveryEncryption({ ...recipient, publicKeySpki: "AA" })).toBeUndefined();
  });
  it("refuses anonymous, malformed backend and cross-sheet setup contexts", () => {
    for (const patch of [{ principal: "2vxsx-fae" }, { pairId: "wrong" }, { sheetId: "wrong" }, { backendHost: "http://remote.example" },
      { backendHost: "https://icp-api.io/path" }, { backendCanisterId: "" }]) expect(() => encodeIouDeliveryContext({ ...context, ...patch })).toThrow();
  });
});

describe("encrypted retry and second-review boundary", () => {
  const origin = "https://client.example", source = {} as Window, nonce = "C".repeat(42) + "A";
  const event = (data: unknown): LocalImportEvent => ({ origin, source, data });
  const offer = (data: LocalEncryptedRequest) => ({ type: "oc:app-import:offer", version: 2, sessionNonce: nonce, ...data });
  function receiver() {
    const result = createLocalImportReceiver({ senderOrigin: origin, senderWindow: source, sessionNonce: nonce, destination });
    result.receive(event({ type: "oc:app-import:hello", version: 2, sessionNonce: nonce })); return result;
  }
  it("queues ciphertext only and deduplicates same reviewed content sealed with fresh randomness", async () => {
    const r = receiver(), retry = await seal();
    expect(request.envelope.ciphertext).not.toBe(retry.envelope.ciphertext);
    expect(r.receive(event(offer(request))).kind).toBe("queued");
    expect(r.receive(event(offer(retry))).kind).toBe("queued");
    expect(r.pending()).toHaveLength(1); expect(r.pending()[0]).not.toHaveProperty("payload");
    expect(await decryptPendingLocalImport(r.pending()[0], keys.privateKey, recipient, destination, () => {})).toEqual(payload);
  });
  it("rejects changed same-ID plaintext only after authenticated decrypt, rather than replacing a review", async () => {
    const r = receiver(); r.receive(event(offer(request)));
    r.receive(event(offer(await seal({ entries: [{ ...payload.entries[0], amount: 1500 }] }))));
    await expect(decryptPendingLocalImport(r.pending()[0], keys.privateKey, recipient, destination, () => {})).rejects.toThrow("Conflicting");
  });
  it("rejects malformed decrypted DTOs and bounded retry floods", async () => {
    const r = receiver();
    r.receive(event(offer(await seal({ entries: [{ ...payload.entries[0], message: "hidden source" }] }))));
    await expect(decryptPendingLocalImport(r.pending()[0], keys.privateKey, recipient, destination, () => {})).rejects.toThrow("supported IOU entry");
    for (let i = 0; i < 3; i++) expect(r.receive(event(offer(await seal()))).kind).toBe("queued");
    expect(r.receive(event(offer(await seal())))).toMatchObject({ kind: "rejected", reply: { reason: "queue-full" } });
  });
});
