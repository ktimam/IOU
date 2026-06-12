// prodVetkd.ts — production vetkd adapter (Option B: uses
// @dfinity/vetkeys, the official dfinity SDK).
//
// v1.1.1 closes the loop: the PWA holds a BLS12-381 G2 transport key
// pair, calls the canister's vetkd_wrap_sheet_key endpoint, and
// decrypts the IBE ciphertext using @dfinity/vetkeys' built-in
// primitives. K_sheet is then HKDF-derived from the IBE result so
// the same derivation works regardless of which transport key the
// PWA is using (any device, just needs II + the IBE private key).
//
// Feature flag: VITE_IOU_PROD_VETKD=1 selects this adapter. When
// unset, the devVetkd.ts adapter (P-256 ECDH + HKDF + AES-GCM with
// localStorage keypair) is used. The dev adapter is the default for
// local development and for users who don't want the prod upgrade
// yet.

import {
  TransportSecretKey,
  MasterPublicKey,
  EncryptedVetKey,
  VetKey,
  deriveSymmetricKey,
} from "@dfinity/vetkeys";
import { Principal } from "@dfinity/principal";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

export function isProdVetkd(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (import.meta as any).env?.VITE_IOU_PROD_VETKD === "1";
}

export interface VetkdTransportKey {
  /** 32-byte scalar, BLS12-381 G2 secret key. */
  secretKey: Uint8Array;
  /** 96-byte compressed G2 public key. */
  publicKey: Uint8Array;
  /** Base64 of the public key (for the canisters's transport_public_key arg). */
  publicKeyB64: string;
}

const STORAGE_KEY = "iou:vetkd:transport:v1";

/** Generate a new transport key pair. */
export function newTransportKey(): VetkdTransportKey {
  const tsk = TransportSecretKey.random();
  return tskToVetkd(tsk);
}

function tskToVetkd(tsk: TransportSecretKey): VetkdTransportKey {
  const sk = tsk.serialize();
  const pk = tsk.publicKeyBytes();
  return {
    secretKey: sk,
    publicKey: pk,
    publicKeyB64: bytesToB64(pk),
  };
}

function bytesToB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tskFromBytes(b: Uint8Array): TransportSecretKey {
  return TransportSecretKey.deserialize(b);
}

/** Load or generate a transport key pair (persisted in IndexedDB). */
export async function loadOrCreateTransportKey(): Promise<VetkdTransportKey> {
  if (typeof indexedDB === "undefined") {
    throw new Error(
      "IndexedDB not available — prod vetkd requires a browser",
    );
  }
  const stored = await idbGet<VetkdTransportKey>(STORAGE_KEY);
  if (stored) return stored;
  const fresh = newTransportKey();
  await idbPut(STORAGE_KEY, fresh);
  return fresh;
}

/**
 * Forget the transport key. The next loadOrCreateTransportKey()
 * will generate a new one. **This will not decrypt any old sheets**
 * — it's a "nuclear" option.
 */
export async function forgetTransportKey(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await idbDel(STORAGE_KEY);
}

/** Unwrap a sheet key using the IC's IBE-decrypted vetKey. */
export async function unwrapSheetKeyProd(
  sheetId: string,
  transport: VetkdTransportKey,
  masterPubKey: Uint8Array,
  encVetKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const dpk = MasterPublicKey.deserialize(masterPubKey);
  const tsk = tskFromBytes(transport.secretKey);
  // The canister's IBE input is b"iou-sheet:" + sheet_id. We need
  // to reconstruct the same input here.
  const input = new TextEncoder().encode("iou-sheet:" + sheetId);
  // EncryptedVetKey.decryptAndVerify returns a VetKey (a 32-byte
  // symmetric key) tied to the input + context.
  const encKey = new EncryptedVetKey(encVetKeyBytes);
  const vetKey: VetKey = encKey.decryptAndVerify(tsk, dpk, input);
  // The VetKey is 32 bytes of symmetric material. KDF it to get
  // our K_sheet (32 bytes), domain-separated by sheet_id.
  const kdf = hkdf(sha256, vetKey.signatureBytes(), undefined, "iou-sheet-key-v1:" + sheetId, 32);
  return new Uint8Array(kdf);
}

/**
 * Derive K_sheet for a given sheet id and transport key, using the
 * canister's master vetkd public key + the IBE-encrypted vetKey
 * (the result of vetkd_wrap_sheet_key).
 */
export async function deriveSheetKey(
  sheetId: string,
  transport: VetkdTransportKey,
  masterPubKey: Uint8Array,
  encVetKey: Uint8Array,
): Promise<Uint8Array> {
  return unwrapSheetKeyProd(sheetId, transport, masterPubKey, encVetKey);
}

// ─── IndexedDB shim (minimal; no external deps) ───

function idbGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("iou-vetkd", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("keys", "readonly");
      const get = tx.objectStore("keys").get(key);
      get.onsuccess = () => resolve((get.result as T) ?? null);
      get.onerror = () => reject(get.error);
    };
  });
}

function idbPut(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("iou-vetkd", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("keys", "readwrite");
      tx.objectStore("keys").put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

function idbDel(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("iou-vetkd", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("keys");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("keys", "readwrite");
      tx.objectStore("keys").delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}
