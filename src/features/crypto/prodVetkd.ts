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
// vetkeys 0.4.x; use the static `deserialize` factory.
//
// v1.2.2: Use DerivedPublicKey.deserialize directly on the bytes
// returned by the canister's `vetkd_public_key`. The IC management
// canister ALREADY does the two-stage derivation (canister key +
// context subkey) server-side when it returns the public key, so the
// PWA must NOT re-derive. v1.1.5 incorrectly called
// `MasterPublicKey.deserialize(...).deriveCanisterKey(canisterId)`,
// which double-derived the key and caused the BLS pairing check in
// `decryptAndVerify` to reject the IBE ciphertext with "Invalid VetKey".
//
// The v1.1.5 fix was based on a misreading of the @dfinity/vetkeys
// API: the official example in the 0.4.0 README uses
// `DerivedPublicKey.deserialize(dpkBytes)` directly — no further
// derivation. The `canisterId` argument is therefore no longer
// needed (it's still accepted by `unwrapSheetKeyProd` for source
// compatibility, but is unused).
//
// See: @dfinity/vetkeys 0.4.0 dist/types/index.d.ts Usage Example.

import {
  TransportSecretKey,
  DerivedPublicKey,
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
   * The principal bytes of the calling canister. **Unused** as of
   * v1.2.2 — the IC management canister's `vetkd_public_key` already
   * does the two-stage derivation (canister key + context subkey)
   * server-side, so the PWA does not need to re-derive. Accepted
   * for source compatibility with v1.1.5 callers.
   */
  _canisterId: Uint8Array,
): Promise<Uint8Array> {
  const dpk = DerivedPublicKey.deserialize(masterPubKey);
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
 * Unwrap the per-user consumer WRAP key (32 bytes) from the IBE result
 * of `vetkd_wrap_consumer_key`. Mirrors {@link unwrapSheetKeyProd}, but
 * the IBE input is scoped to the caller's principal instead of a sheet
 * id (the canister builds b"iou-consumer:" + caller principal text).
 * The result is the AES wrap key consumerKeypair.ts seals the OpenChat
 * consumer private key under — identical on every device of the same
 * user, which is the whole point.
 */
export async function deriveConsumerWrapKeyProd(
  principalText: string,
  transport: VetkdTransportKey,
  masterPubKey: Uint8Array,
  encVetKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const dpk = DerivedPublicKey.deserialize(masterPubKey);
  const tsk = tskFromBytes(transport.secretKey);
  // Must byte-match the canister's IBE input (vetkd_wrap_consumer_key).
  const input = new TextEncoder().encode("iou-consumer:" + principalText);
  const encKey = EncryptedVetKey.deserialize(encVetKeyBytes);
  const vetKey: VetKey = encKey.decryptAndVerify(tsk, dpk, input);
  const kdf = hkdf(
    sha256,
    vetKey.signatureBytes(),
    undefined,
    "iou-consumer-key-v1:" + principalText,
    32,
  );
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
