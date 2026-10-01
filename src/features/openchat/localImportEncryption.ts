/** Versioned, sender-sealed private-app delivery. No account, storage or network effects. */
export const LOCAL_DELIVERY_SCHEME = "p256-hkdf-sha256-aes-256-gcm-v1" as const;
export const LOCAL_DELIVERY_DOMAIN = "openchat/private-app/handoff/v1";
export const LOCAL_DELIVERY_MAX_PLAINTEXT = 65536;
export const IOU_LOCAL_APP_REVISION = "local-import-v2";

export type LocalDeliveryEncryption = Readonly<{
  version: 1;
  scheme: typeof LOCAL_DELIVERY_SCHEME;
  keyId: string;
  publicKeySpki: string;
  recipientContext: string;
}>;
export type LocalEncryptedEnvelope = Readonly<{
  version: 1;
  scheme: typeof LOCAL_DELIVERY_SCHEME;
  keyId: string;
  recipientContext: string;
  ephemeralPublicKey: string;
  salt: string;
  iv: string;
  ciphertext: string;
}>;
export type LocalEncryptedRequest = Readonly<{
  importId: string;
  appId: string;
  appRevision: string;
  actionId: string;
  destination: string;
  envelope: LocalEncryptedEnvelope;
}>;
export type IouDeliveryContext = Readonly<{
  principal: string;
  backendHost: string;
  backendCanisterId: string;
  pairId: string;
  sheetId: string;
}>;

const utf8 = new TextEncoder();
const toBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const hex = (bytes: Uint8Array): string => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");

export function localDeliveryBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function localDeliveryDecode(value: unknown, minBytes: number, maxBytes = minBytes): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3) ||
    !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1) throw new Error("Invalid encrypted delivery encoding");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytes.length < minBytes || bytes.length > maxBytes || localDeliveryBase64Url(bytes) !== value) {
    throw new Error("Invalid encrypted delivery length");
  }
  return bytes;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return undefined;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return undefined;
    copy[key] = descriptor.value;
  }
  return copy;
}

function commonValid(value: Record<string, unknown>): boolean {
  if (value.version !== 1 || value.scheme !== LOCAL_DELIVERY_SCHEME || typeof value.keyId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.keyId) || typeof value.recipientContext !== "string" ||
    value.recipientContext.length > 2048) return false;
  localDeliveryDecode(value.recipientContext, 1, 1536);
  return true;
}

export function parseLocalDeliveryEncryption(value: unknown): LocalDeliveryEncryption | undefined {
  try {
    const row = record(value, ["version", "scheme", "keyId", "publicKeySpki", "recipientContext"]);
    if (!row || !commonValid(row)) return undefined;
    localDeliveryDecode(row.publicKeySpki, 91);
    return Object.freeze({ ...row }) as LocalDeliveryEncryption;
  } catch { return undefined; }
}

export function parseLocalEncryptedEnvelope(value: unknown): LocalEncryptedEnvelope | undefined {
  try {
    const row = record(value, ["version", "scheme", "keyId", "recipientContext", "ephemeralPublicKey", "salt", "iv", "ciphertext"]);
    if (!row || !commonValid(row) || localDeliveryDecode(row.ephemeralPublicKey, 65)[0] !== 4) return undefined;
    localDeliveryDecode(row.salt, 32);
    localDeliveryDecode(row.iv, 12);
    localDeliveryDecode(row.ciphertext, 17, LOCAL_DELIVERY_MAX_PLAINTEXT + 16);
    return Object.freeze({ ...row }) as LocalEncryptedEnvelope;
  } catch { return undefined; }
}

/** Opaque to the host, but base64 is NOT encryption: this is visible routing metadata. */
export function encodeIouDeliveryContext(context: IouDeliveryContext): string {
  const { principal, backendHost, backendCanisterId, pairId, sheetId } = context;
  const host = new URL(backendHost);
  if (!/^[a-z0-9-]{5,100}$/u.test(principal) || principal === "2vxsx-fae" ||
    !/^[a-z0-9-]{5,100}$/u.test(backendCanisterId) ||
    !/^[a-f0-9]{16}$/u.test(pairId) || !/^[a-f0-9]{16}$/u.test(sheetId) ||
    host.origin !== backendHost || host.username || host.password ||
    (host.protocol !== "https:" && !(host.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)))) {
    throw new Error("Invalid IOU encrypted delivery context");
  }
  return localDeliveryBase64Url(utf8.encode(JSON.stringify([1, principal, backendHost, backendCanisterId, pairId, sheetId])));
}

export async function createLocalDeliveryEncryption(publicKey: CryptoKey, context: IouDeliveryContext): Promise<LocalDeliveryEncryption> {
  if (publicKey.type !== "public" || publicKey.algorithm.name !== "ECDH" ||
    (publicKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256") throw new Error("Invalid IOU delivery public key");
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey));
  if (spki.length !== 91) throw new Error("Invalid IOU delivery public key encoding");
  return Object.freeze({ version: 1, scheme: LOCAL_DELIVERY_SCHEME,
    keyId: hex(new Uint8Array(await crypto.subtle.digest("SHA-256", toBuffer(spki)))),
    publicKeySpki: localDeliveryBase64Url(spki), recipientContext: encodeIouDeliveryContext(context) });
}

export function localDeliveryAdditionalData(request: LocalEncryptedRequest): Uint8Array {
  return utf8.encode(JSON.stringify([LOCAL_DELIVERY_DOMAIN, request.appId, request.appRevision, request.actionId,
    request.destination, request.importId, request.envelope.keyId, request.envelope.recipientContext]));
}

/** Only invoked after authenticated recipient and active sheet selection; never decrypt in receive(). */
export async function decryptLocalImportEnvelope(
  request: LocalEncryptedRequest,
  privateKey: CryptoKey,
  recipient: LocalDeliveryEncryption,
  expectedDestination: string,
  assertCurrent: () => void,
): Promise<unknown> {
  assertCurrent();
  const envelope = parseLocalEncryptedEnvelope(request.envelope);
  if (!envelope || !parseLocalDeliveryEncryption(recipient) || request.appId !== "iou" ||
    request.appRevision !== IOU_LOCAL_APP_REVISION || request.actionId !== "iou.entry.import" ||
    !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(request.importId) || request.destination !== expectedDestination ||
    envelope.keyId !== recipient.keyId || envelope.recipientContext !== recipient.recipientContext ||
    privateKey.type !== "private" || privateKey.algorithm.name !== "ECDH" ||
    (privateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256") throw new Error("Encrypted draft is not addressed to this IOU account and sheet");
  const ephemeral = await crypto.subtle.importKey("raw", toBuffer(localDeliveryDecode(envelope.ephemeralPublicKey, 65)),
    { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256);
  const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
  new Uint8Array(secret).fill(0);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: toBuffer(localDeliveryDecode(envelope.salt, 32)),
    info: toBuffer(utf8.encode(LOCAL_DELIVERY_DOMAIN)) }, base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: toBuffer(localDeliveryDecode(envelope.iv, 12)),
    additionalData: toBuffer(localDeliveryAdditionalData({ ...request, envelope })), tagLength: 128 }, aes,
  toBuffer(localDeliveryDecode(envelope.ciphertext, 17, LOCAL_DELIVERY_MAX_PLAINTEXT + 16))));
  try {
    assertCurrent();
    if (plaintext.byteLength > LOCAL_DELIVERY_MAX_PLAINTEXT) throw new Error("Decrypted draft exceeds the limit");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  } finally { plaintext.fill(0); }
}
