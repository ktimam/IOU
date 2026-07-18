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
const ENTRY_SALT = "iou-entry-aes-v1";
const ENTRY_CONTEXT = "iou-per-entry-key-v1";

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
    raw as BufferSource,
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

/**
 * A stable per-user symmetric key (32 bytes) derived by self-ECDH over the
 * user's own keypair. Reproducible on any device holding the same keypair;
 * used to encrypt user-level data (e.g. transaction templates) so it can be
 * stored on-chain yet only the user can read it.
 */
export async function deriveUserKey(principal: string): Promise<Uint8Array> {
  const { publicKey, privateKey } = await deriveUserKeypair(principal);
  const bits = await getSubtle().deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256,
  );
  return new Uint8Array(bits);
}

export function newSheetKey(): Uint8Array {
  return randomBytes(32);
}

export function isDevVetkd(): boolean {
  return !isProdVetkd();
}

export function isProdVetkd(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (import.meta as any).env?.VITE_IOU_PROD_VETKD === "1";
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
  const hkdfKey = await subtle.importKey("raw", toBuf(new Uint8Array(shared)), "HKDF", false, ["deriveKey"]);
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

// ─────────────── tagged cross-wrap (self-describing sender) ───────────────
//
// A plain wrap ([IV|ct], wrapSheetKey) can only be unwrapped by a reader who already
// knows the SENDER's public key. For a self-wrap that's fine (reader == sender). But
// a CROSS-wrap — the creator sealing a sheet slot for the OTHER member — is read by
// someone who must resolve who the sender was, and that breaks once the sender leaves
// the pair and their member slot is anonymized (or rotates their key). A TAGGED wrap
// embeds the sender's raw public key in the blob: [MAGIC|pubLen|senderPubRaw|IV|ct].
// The reader can then always cross-unwrap it without any external lookup — it survives
// the sender leaving and pins the exact key used at seal time. Self-wraps stay plain,
// so the read path tries self-unwrap first and only parses the tag on failure.

const CROSS_WRAP_MAGIC = 0x01;

/** Cross-wrap K_sheet for `recipientPublicKey`, embedding the sender's raw public key
 *  (`senderPublicKeyB64`, as returned by deriveUserKeypair) so the recipient can unwrap
 *  it without knowing who the sender was. We take the b64 (not the CryptoKey) because a
 *  keypair loaded from storage imports its public key as non-extractable. */
export async function wrapSheetKeyTagged(
  K_sheet: Uint8Array,
  recipientPublicKey: CryptoKey,
  senderPrivateKey: CryptoKey,
  senderPublicKeyB64: string,
  info: Uint8Array = new TextEncoder().encode(VETKD_CONTEXT),
): Promise<Uint8Array> {
  const body = await wrapSheetKey(K_sheet, recipientPublicKey, senderPrivateKey, info);
  const senderRaw = b64ToBytes(senderPublicKeyB64);
  if (senderRaw.length === 0 || senderRaw.length > 255) {
    throw new Error("sender pubkey length out of range to tag");
  }
  return concatBytes(
    new Uint8Array([CROSS_WRAP_MAGIC, senderRaw.length]),
    senderRaw,
    body,
  );
}

/** If `blob` is a tagged cross-wrap, unwrap it with the recipient's private key + the
 *  EMBEDDED sender pubkey. Returns null if `blob` is not a tagged cross-wrap (the
 *  caller should fall back to / have already tried self-unwrap). */
export async function unwrapTaggedSheetKey(
  blob: Uint8Array,
  recipientPrivateKey: CryptoKey,
  info: Uint8Array = new TextEncoder().encode(VETKD_CONTEXT),
): Promise<Uint8Array | null> {
  if (blob.length < 2 || blob[0] !== CROSS_WRAP_MAGIC) return null;
  const len = blob[1];
  if (blob.length < 2 + len + 12 + 16) return null;
  const senderRaw = blob.subarray(2, 2 + len);
  const body = blob.subarray(2 + len);
  let senderPublicKey: CryptoKey;
  try {
    senderPublicKey = await importPublicKeyRaw(senderRaw);
  } catch {
    return null;
  }
  return unwrapSheetKey(body, recipientPrivateKey, senderPublicKey, info);
}

// ─────────────── entry-level encryption ───────────────
//
// Each entry is encrypted with a per-entry AES key, derived as
// HKDF(K_sheet, salt=ENTRY_SALT, info=ENTRY_CONTEXT + entry_key).
// The (entry_key, ciphertext, iv) triple is what we ship to the
// canister; K_sheet never leaves the device.

async function deriveEntryAesKey(
  K_sheet: Uint8Array,
  entryKey: Uint8Array,
): Promise<CryptoKey> {
  const subtle = getSubtle();
  const baseKey = await subtle.importKey("raw", toBuf(K_sheet), "HKDF", false, ["deriveKey"]);
  // Concat ENTRY_CONTEXT || entry_key as the info.
  const info = concatBytes(
    new TextEncoder().encode(ENTRY_CONTEXT),
    entryKey,
  );
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuf(new TextEncoder().encode(ENTRY_SALT)),
      info: toBuf(info),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt an entry payload with K_sheet + a per-entry random key.
 * Returns the (entry_key, iv, ciphertext) triple ready to be stored.
 */
export async function encryptEntryPayload(
  plaintext: Uint8Array,
  K_sheet: Uint8Array,
): Promise<{ entryKey: Uint8Array; iv: Uint8Array; ciphertext: Uint8Array }> {
  const subtle = getSubtle();
  const entryKey = randomBytes(32);
  const aesKey = await deriveEntryAesKey(K_sheet, entryKey);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
    aesKey,
    toBuf(plaintext),
  );
  return { entryKey, iv, ciphertext: new Uint8Array(ct) };
}

/**
 * Decrypt an entry payload using K_sheet + the entry_key.
 */
export async function decryptEntryPayload(
  entryKey: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  K_sheet: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const aesKey = await deriveEntryAesKey(K_sheet, entryKey);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
    aesKey,
    toBuf(ciphertext),
  );
  return new Uint8Array(pt);
}

// ─────────────── name encryption (Account / Sheet / member names) ───────────────
//
// Account names, sheet names, and per-member display names are encrypted
// E2E with the shared K_sheet so both members can read them. The AES key
// is derived from K_sheet with a name-scoped salt/info (distinct from the
// entry-key derivation above) and there is no per-name salt — names are
// short and re-encrypted wholesale on every change, with a fresh random IV.

const NAME_SALT = "iou-name-aes-v1";
const NAME_CONTEXT = "iou-name-key-v1";

async function deriveNameAesKey(K_sheet: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();
  const baseKey = await subtle.importKey("raw", toBuf(K_sheet), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuf(new TextEncoder().encode(NAME_SALT)),
      info: toBuf(new TextEncoder().encode(NAME_CONTEXT)),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt an arbitrary blob with a key derived from K_sheet. */
export async function encryptWithSheetKey(
  K_sheet: Uint8Array,
  plaintext: Uint8Array,
): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const subtle = getSubtle();
  const aesKey = await deriveNameAesKey(K_sheet);
  const iv = randomBytes(12);
  const ct = await subtle.encrypt(
    { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
    aesKey,
    toBuf(plaintext),
  );
  return { iv, ciphertext: new Uint8Array(ct) };
}

/** Decrypt a blob encrypted with {@link encryptWithSheetKey}. */
export async function decryptWithSheetKey(
  K_sheet: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const subtle = getSubtle();
  const aesKey = await deriveNameAesKey(K_sheet);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
    aesKey,
    toBuf(ciphertext),
  );
  return new Uint8Array(pt);
}

/** Encrypt a UTF-8 name with K_sheet. Returns arrays ready for Candid. */
export async function encryptName(
  K_sheet: Uint8Array,
  name: string,
): Promise<{ enc: number[]; iv: number[] }> {
  const { iv, ciphertext } = await encryptWithSheetKey(
    K_sheet,
    new TextEncoder().encode(name),
  );
  return { enc: Array.from(ciphertext), iv: Array.from(iv) };
}

/** Decrypt a UTF-8 name with K_sheet; returns "" on any failure. */
export async function decryptName(
  K_sheet: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
): Promise<string> {
  try {
    return new TextDecoder().decode(await decryptWithSheetKey(K_sheet, iv, ciphertext));
  } catch {
    return "";
  }
}
