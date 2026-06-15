// prodVetkd.ts — production vetkd adapter (Option B: uses
// @dfinity/vetkeys, the official dfinity SDK).
//
// v1.1.1 closes the loop: the PWA holds a BLS12-381 G1 transport key
// pair (NOT G2 — see "key sizes" below), calls the canister's
// vetkd_wrap_sheet_key endpoint, and decrypts the IBE ciphertext
// using @dfinity/vetkeys' built-in primitives. K_sheet is then
// HKDF-derived from the IBE result so the same derivation works
// regardless of which transport key the PWA is using (any device,
// just needs II + the IBE private key).
//
// Feature flag: VITE_IOU_PROD_VETKD=1 selects this adapter. When
// unset, the devVetkd.ts adapter (P-256 ECDH + HKDF + AES-GCM with
// localStorage keypair) is used. The dev adapter is the default for
// local development and for users who don't want the prod upgrade
// yet.
//
// Key sizes (BLS12-381):
//   - Transport public key (sent to the canister as transport_public_key):
//       G1 compressed, 48 bytes.
//   - Master public key (returned by vetkd_public_key()):
//       G2, 96 bytes.
//   - Transport secret key (stored in IndexedDB):
//       32-byte scalar (G1).
//
// These were verified empirically: `TransportSecretKey.random()
// .publicKeyBytes().length === 48` for the transport pubkey, and the
// master pubkey as returned by the canister is 96 bytes G2.
//
// v1.1.5: EncryptedVetKey's constructor is private in @dfinity/
// vetkeys 0.4.x; use the static `deserialize` factory. decryptAndVerify
// also requires a `DerivedPublicKey` (canister-specific), not the
// master key. The PWA must pass the canister id (bytes) so we can do
// the deriveCanisterKey() step here.

import {
  TransportSecretKey,
  MasterPublicKey,
  EncryptedVetKey,
  VetKey,
} from "@dfinity/vetkeys";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

export function isProdVetkd(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (import.meta as any).env?.VITE_IOU_PROD_VETKD === "1";
}

export interface VetkdTransportKey {
  /** 32-byte scalar, BLS12-381 G1 secret key. */
  secretKey: Uint8Array;
  /** 48-byte compressed G1 public key. */
  publicKey: Uint8Array;
  /** Base64 of the public key (for the canister's transport_public_key arg). */
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
  /**
   * The 32-byte principal bytes of the calling canister. Required:
   * `decryptAndVerify` expects a `DerivedPublicKey` (bound to a
   * specific canister), not the raw master key. If you call with the
   * master key directly, the IBE verification will reject the
   * derived key with a generic "verification failed" error.
   */
  canisterId: Uint8Array,
): Promise<Uint8Array> {
  const mpk = MasterPublicKey.deserialize(masterPubKey);
  // Canister-specific derived key. Required for `decryptAndVerify`:
  // the IBE ciphertext is bound to (this_canister, input, context),
  // and the verification checks the derived key matches.
  const dpk = mpk.deriveCanisterKey(canisterId);
  const tsk = tskFromBytes(transport.secretKey);
  // The canister's IBE input is b"iou-sheet:" + sheet_id. We need
  // to reconstruct the same input here.
  const input = new TextEncoder().encode("iou-sheet:" + sheetId);
  // EncryptedVetKey's constructor is private in @dfinity/vetkeys
  // 0.4.x; use the static `deserialize` factory.
  const encKey = EncryptedVetKey.deserialize(encVetKeyBytes);
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
 *
 * `canisterId` is the canister's principal bytes (NOT a string;
 * convert via `Principal.fromText(id).toUint8Array()`).
 */
export async function deriveSheetKey(
  sheetId: string,
  transport: VetkdTransportKey,
  masterPubKey: Uint8Array,
  encVetKey: Uint8Array,
  canisterId: Uint8Array,
): Promise<Uint8Array> {
  return unwrapSheetKeyProd(sheetId, transport, masterPubKey, encVetKey, canisterId);
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
