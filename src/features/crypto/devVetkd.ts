// Per-sheet key crypto: wrap/unwrap a symmetric AES-256-GCM key
// (`K_sheet`) under an asymmetric key so the canister can store the
// wrapped blob but never the plaintext key.
//
// Dev mode (this file):
//   * Each user has a P-256 keypair persisted in localStorage.
//   * The "wrap" is ECDH(sender_priv, recipient_pub) -> HKDF -> AES-256-GCM.
//   * In v1 dev, the sender is the sheet creator (a member of the
//     sheet). To wrap for the OTHER member, the creator uses the
//     other's public key. To wrap for themselves, the creator uses
//     their own public key (self-ECDH — works because ECDH(priv,
//     pub) of one keypair is the same shared secret on both sides).
//
// Production mode (NOT implemented in v1; see isProdVetkd):
//   * `vetkd_derive_key((caller_principal, "iou-user-key-v1"))` produces
//     a deterministic per-principal public key. The recipient can
//     derive the same public key and use it to unwrap.
//
// Wire format of a wrapped key:
//   bytes 0..12  : IV (12 random bytes)
//   bytes 12..end : AES-GCM ciphertext (pt = K_sheet)

const LS_KEYPAIR_KEY = "iou.dev.userKeypair.v1";
const HKDF_SALT = "iou-wrapping-v1";

/** Public so tests/tooling can reference it. */
export const VETKD_CONTEXT = "iou-per-sheet-key-v1";

// ─────────────── helpers ───────────────

function getSubtle(): SubtleCrypto {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (globalThis as any).crypto;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto.subtle is not available in this environment");
  }
  return c.subtle as SubtleCrypto;
}

function randomBytes(n: number): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (globalThis as any).crypto;
  const out = new Uint8Array(n);
  c.getRandomValues(out);
  return out;
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (globalThis as any).btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bin = (globalThis as any).atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function exportPublicKeyRaw(pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await getSubtle().exportKey("raw", pub));
}

async function importPublicKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
  return getSubtle().importKey(
    "raw",
    raw,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

// TS 5.5 + Node 20: Uint8Array<ArrayBufferLike> is not assignable
// to BufferSource in strict mode. Cast through `as BufferSource`
// (a no-op at runtime) so the call sites compile.
function toBuf(b: Uint8Array): BufferSource {
  return b as unknown as BufferSource;
}

function lsGet(key: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (globalThis as any).localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).localStorage?.setItem(key, value);
  } catch {
    // ignore
  }
}

// ─────────────── keypair management ───────────────

interface StoredKeypair {
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
}

async function generateAndStoreKeypair(principal: string): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
}> {
  const subtle = getSubtle();
  const kp = (await subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  )) as CryptoKeyPair;
  const publicKeyB64 = bytesToB64(await exportPublicKeyRaw(kp.publicKey));
  const privateKeyJwk = await subtle.exportKey("jwk", kp.privateKey);
  const stored: StoredKeypair = { publicKeyB64, privateKeyJwk };
  lsSet(`${LS_KEYPAIR_KEY}.${principal}`, JSON.stringify(stored));
  return { publicKey: kp.publicKey, privateKey: kp.privateKey, publicKeyB64 };
}

async function loadStoredKeypair(principal: string): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
} | null> {
  const raw = lsGet(`${LS_KEYPAIR_KEY}.${principal}`);
  if (!raw) return null;
  const stored = JSON.parse(raw) as StoredKeypair;
  const publicKey = await importPublicKeyRaw(b64ToBytes(stored.publicKeyB64));
  const privateKey = await getSubtle().importKey(
    "jwk",
    stored.privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveKey", "deriveBits"],
  );
  return { publicKey, privateKey, publicKeyB64: stored.publicKeyB64 };
}

export async function deriveUserKeypair(principal: string): Promise<{
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  publicKeyB64: string;
}> {
  const stored = await loadStoredKeypair(principal);
  if (stored) return stored;
  return generateAndStoreKeypair(principal);
}

export async function importPublicKeyB64Wrap(b64: string): Promise<CryptoKey> {
  return importPublicKeyRaw(b64ToBytes(b64));
}

export function newSheetKey(): Uint8Array {
  return randomBytes(32);
}

export function isDevVetkd(): boolean {
  return true;
}

export function isProdVetkd(): boolean {
  return false; // not implemented in v1
}

// ─────────────── wrap / unwrap ───────────────

async function deriveAesKey(
  myPrivateKey: CryptoKey,
  theirPublicKey: CryptoKey,
  info: Uint8Array,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const shared = await subtle.deriveBits(
    { name: "ECDH", public: theirPublicKey },
    myPrivateKey,
    256,
  );
  const hkdfKey = await subtle.importKey("raw", toBuf(shared), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuf(new TextEncoder().encode(HKDF_SALT)),
      info: toBuf(info),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Wrap K_sheet so only the holder of the private key matching
 * `recipientPublicKey` can unwrap. The wrap is ECDH(sender_priv,
 * recipient_pub) -> HKDF -> AES-256-GCM.
 *
 * `senderPrivateKey` is typically the sheet creator's private key
 * (in v1, only members of a sheet can create a sheet, and the
 * creator can wrap for themselves and for the other member).
 */
export async function wrapSheetKey(
  K_sheet: Uint8Array,
  recipientPublicKey: CryptoKey,
  senderPrivateKey: CryptoKey,
  info: Uint8Array = new TextEncoder().encode(VETKD_CONTEXT),
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const aesKey = await deriveAesKey(senderPrivateKey, recipientPublicKey, info);
  const iv = randomBytes(12);
  // TS 5.5: Uint8Array<ArrayBufferLike> is not assignable to BufferSource.
  // Cast through `as BufferSource` to make the call happy.
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
    aesKey,
    toBuf(K_sheet),
  );
  return concatBytes(iv, new Uint8Array(ct));
}

/**
 * Inverse of `wrapSheetKey`. The recipient uses their own private
 * key and the sender's public key. In v1 dev, when sender == recipient
 * (self-wrap), pass the same keypair.
 */
export async function unwrapSheetKey(
  wrapped: Uint8Array,
  recipientPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
  info: Uint8Array = new TextEncoder().encode(VETKD_CONTEXT),
): Promise<Uint8Array> {
  if (wrapped.length < 12 + 16) {
    throw new Error("wrapped blob is too short");
  }
  const iv = wrapped.subarray(0, 12);
  const ct = wrapped.subarray(12);
  const subtle = getSubtle();
  const aesKey = await deriveAesKey(recipientPrivateKey, senderPublicKey, info);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
    aesKey,
    toBuf(ct),
  );
  return new Uint8Array(pt);
}
