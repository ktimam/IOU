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

import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const STORAGE_KEY = "iou:recovery:v1";

/** Generate a fresh 24-word BIP-39 mnemonic. */
export function newRecoveryMnemonic(): string {
  return generateMnemonic(wordlist, 256); // 24 words
}

/** True iff the mnemonic is a valid BIP-39 phrase in the English wordlist. */
export function isValidMnemonic(m: string): boolean {
  return validateMnemonic(m, wordlist);
}

/** Persist the mnemonic in IndexedDB. v1.1.x will encrypt it. */
export async function saveRecoveryMnemonic(m: string): Promise<void> {
  if (!isValidMnemonic(m)) {
    throw new Error("not a valid BIP-39 mnemonic");
  }
  if (typeof indexedDB === "undefined") {
    // Node / non-browser — no-op (the smoke test will exercise the
    // pure functions directly).
    return;
  }
  await idbPut(STORAGE_KEY, m);
}

/** Load a previously saved mnemonic, or null. */
export async function loadRecoveryMnemonic(): Promise<string | null> {
  if (typeof indexedDB === "undefined") return null;
  return (await idbGet<string>(STORAGE_KEY)) ?? null;
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

// ─── IndexedDB shim ───

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("iou-recovery", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

function idbPut(key: string, value: unknown): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}

function idbGet<T>(key: string): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("keys", "readonly");
        const get = tx.objectStore("keys").get(key);
        get.onsuccess = () => resolve((get.result as T) ?? null);
        get.onerror = () => reject(get.error);
      }),
  );
}

function idbDel(key: string): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction("keys", "readwrite");
        tx.objectStore("keys").delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      }),
  );
}
