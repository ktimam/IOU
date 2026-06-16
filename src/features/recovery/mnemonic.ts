// Recovery key.
//
// A 24-word BIP-39 mnemonic (256 bits of entropy) that the user
// saves once at first sign-in. If they lose access to their II
// (browser profile, device, etc.), the mnemonic recovers the user's
// PWA state — specifically, the deterministic seed for the
// transport key (prod vetkd) and the localStorage keypair (dev
// vetkd) is derived from the mnemonic.
//
// v1.1.0: the recovery-key module is the production scaffolding.
// The PWA wires the "Save your recovery key" prompt at first
// sign-in. In dev, the mnemonic is derived from random WebCrypto
// entropy. In prod, the mnemonic will additionally be the seed for
// the BLS12-381 G2 transport key (so the user can recover their
// transport key from the mnemonic without II).
//
// V9b fix (v1.3.1): the mnemonic is now encrypted at rest with
// AES-256-GCM under a wrapping key derived from a user-supplied
// passphrase via PBKDF2-SHA-256 (310k iterations, 16-byte random
// salt). The IndexedDB entry stores `salt || iv || ciphertext`.
// This means a browser-level compromise of IndexedDB no longer
// leaks the recovery phrase in cleartext — the attacker also
// needs the user's passphrase. The PWA UI asks for the
// passphrase at save time and again at unlock.

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { idbGet, idbPut, idbDel } from "./idb";

const STORAGE_KEY = "iou:recovery:v2";
// Magic prefix so the loader can tell an encrypted blob from a
// legacy plaintext mnemonic (v1 stored the bare string). Loading
// a v1 entry returns null — the user has to re-save.
const MAGIC = new Uint8Array([0xa7, 0xc1, 0x4e, 0xd2]);
const PBKDF2_ITERATIONS = 310_000;  // OWASP 2023 recommendation
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN_BITS = 256;

const subtle = (): SubtleCrypto => {
  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  // Node 18+: webcrypto.subtle is available; older Node
  // doesn't have it at all (the smoke would fail anyway).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = (globalThis as any).crypto;
  if (!c?.subtle) throw new Error("crypto.subtle is required");
  return c.subtle;
};

function toBuf(b: Uint8Array): ArrayBuffer {
  // SubtleCrypto needs an ArrayBuffer (not SharedArrayBuffer),
  // so copy into a fresh buffer.
  const out = new ArrayBuffer(b.byteLength);
  new Uint8Array(out).set(b);
  return out;
}

async function deriveWrappingKey(passphrase: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const baseKey = await subtle().importKey(
    "raw",
    toBuf(enc.encode(passphrase)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  const bits = await subtle().deriveBits(
    { name: "PBKDF2", salt: toBuf(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    KEY_LEN_BITS,
  );
  return new Uint8Array(bits);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", toBuf(raw), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c: any = (globalThis as any).crypto;
  if (!c?.getRandomValues) throw new Error("crypto.getRandomValues is required");
  c.getRandomValues(out);
  return out;
}

/** Generate a fresh 24-word BIP-39 mnemonic. */
export function newRecoveryMnemonic(): string {
  return generateMnemonic(wordlist, 256); // 24 words
}

/** True iff the mnemonic is a valid BIP-39 phrase in the English wordlist. */
export function isValidMnemonic(m: string): boolean {
  return validateMnemonic(m, wordlist);
}

/**
 * Persist the mnemonic in IndexedDB, encrypted under a key
 * derived from `passphrase`. The passphrase is never stored;
 * the user has to re-enter it to unlock.
 *
 * V9b fix (v1.3.1): the IndexedDB entry is now
 * `magic || salt(16) || iv(12) || aes-gcm-ciphertext`. The
 * magic prefix lets the loader distinguish an encrypted blob
 * from a legacy plaintext entry.
 */
export async function saveRecoveryMnemonic(
  m: string,
  passphrase: string,
): Promise<void> {
  if (!isValidMnemonic(m)) {
    throw new Error("not a valid BIP-39 mnemonic");
  }
  if (!passphrase || passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }
  if (typeof indexedDB === "undefined") {
    // Node / non-browser — no-op (smoke tests exercise the
    // pure functions directly).
    return;
  }
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = await deriveWrappingKey(passphrase, salt);
  const aesKey = await importAesKey(key);
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
      aesKey,
      toBuf(new TextEncoder().encode(m)),
    ),
  );
  const blob = new Uint8Array(MAGIC.length + salt.length + iv.length + ct.length);
  blob.set(MAGIC, 0);
  blob.set(salt, MAGIC.length);
  blob.set(iv, MAGIC.length + salt.length);
  blob.set(ct, MAGIC.length + salt.length + iv.length);
  await idbPut(STORAGE_KEY, blob);
}

/**
 * Load a previously saved mnemonic and decrypt with
 * `passphrase`. Returns null on a missing entry, a legacy
 * v1 plaintext entry (forces the user to re-save), or any
 * other read error. Throws on a wrong passphrase.
 */
export async function loadRecoveryMnemonic(
  passphrase: string,
): Promise<string | null> {
  if (typeof indexedDB === "undefined") return null;
  const raw = await idbGet<unknown>(STORAGE_KEY);
  if (!raw) return null;
  // Legacy v1 entries were bare strings — never readable in v2.
  if (typeof raw === "string") {
    return null;
  }
  if (!(raw instanceof Uint8Array) || raw.length < MAGIC.length) {
    return null;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (raw[i] !== MAGIC[i]) return null;
  }
  const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
  const iv = raw.subarray(MAGIC.length + SALT_LEN, MAGIC.length + SALT_LEN + IV_LEN);
  const ct = raw.subarray(MAGIC.length + SALT_LEN + IV_LEN);
  const key = await deriveWrappingKey(passphrase, salt);
  const aesKey = await importAesKey(key);
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: toBuf(iv), tagLength: 128 },
      aesKey,
      toBuf(ct),
    );
    return new TextDecoder().decode(pt);
  } catch {
    // Most likely a wrong passphrase; surface as a specific
    // error so the UI can show "wrong passphrase" instead of
    // a generic crypto error.
    throw new Error("wrong passphrase");
  }
}

/** Forget the mnemonic. (User wiped their recovery key on purpose.) */
export async function forgetRecoveryMnemonic(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await idbDel(STORAGE_KEY);
}

/** Derive a 32-byte seed from the mnemonic (PBKDF2 with the BIP-39 passphrase ""). */
export function seedFromMnemonic(m: string): Uint8Array {
  if (!isValidMnemonic(m)) {
    throw new Error("not a valid BIP-39 mnemonic");
  }
  // mnemonicToSeedSync returns 64 bytes; we take the first 32.
  const seed64 = mnemonicToSeedSync(m, "");
  return seed64.subarray(0, 32);
}
