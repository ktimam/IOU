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
//   - Transport secret key (ephemeral; session memory only):
//       32-byte scalar (G1). It is never an account-recovery key.
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
import { isMobileNative, secureDel } from "./mobileSecureStorage";

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

/** Material validated before an irreversible sheet mutation. */
export interface ProdSheetKeyContext {
  transport: VetkdTransportKey;
  masterPubKey: Uint8Array;
}

type ProdSheetKeyActor = {
  vetkd_public_key: () => Promise<ArrayLike<number>>;
  vetkd_wrap_sheet_key: (
    sheetId: string,
    transportPublicKey: number[],
  ) => Promise<ArrayLike<number>>;
};

export type ProdSheetKeyRetryOptions = {
  attempts?: number;
  delayMs?: number;
};

const STORAGE_KEY = "iou:vetkd:transport:v1";
const SECURE_STORAGE_KEY = "transport:v1";
let transportKeyLoad: Promise<VetkdTransportKey> | null = null;

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

async function purgePersistedTransportKey(): Promise<void> {
  if (isMobileNative()) {
    // Remove the obsolete durable record created by pre-review builds. Fail
    // closed if the native keystore cannot purge that retired secret.
    await secureDel(SECURE_STORAGE_KEY);
  }
  if (typeof indexedDB !== "undefined") {
    await idbDel(STORAGE_KEY);
  }
}

async function loadOrCreateTransportKeyUncached(): Promise<VetkdTransportKey> {
  // ICP transport keys protect delivery of a deterministic vetKey. They are
  // ephemeral session material, not an account recovery secret. Purge records
  // written by older builds before creating this session's fresh key.
  await purgePersistedTransportKey();
  return newTransportKey();
}

/** Return one ephemeral transport key shared by callers in this JS session. */
export async function loadOrCreateTransportKey(): Promise<VetkdTransportKey> {
  if (!transportKeyLoad) {
    transportKeyLoad = loadOrCreateTransportKeyUncached().catch((error) => {
      transportKeyLoad = null;
      throw error;
    });
  }
  return transportKeyLoad;
}

/**
 * End the current transport-key session. A fresh transport key can still
 * retrieve the same deterministic sheet or consumer vetKey after access
 * control succeeds at the canister.
 */
export async function forgetTransportKey(): Promise<void> {
  const pending = transportKeyLoad;
  transportKeyLoad = null;
  if (pending) {
    const previous = await pending.catch(() => null);
    previous?.secretKey.fill(0);
  }
  await purgePersistedTransportKey();
}

/**
 * Load and validate all device-local and canister-global material needed to
 * derive a production sheet key. Call this before creating or accepting an
 * irreversible resource so corrupt/unavailable key material fails first.
 */
export async function prepareProdSheetKey(
  actor: Pick<ProdSheetKeyActor, "vetkd_public_key">,
): Promise<ProdSheetKeyContext> {
  const transport = await loadOrCreateTransportKey();
  if (transport.secretKey.length !== 32 || transport.publicKey.length !== 48) {
    throw new Error("invalid vetKD transport key");
  }
  // Validate this session's transport secret before create_sheet.
  tskFromBytes(transport.secretKey);

  const masterPubKey = new Uint8Array(await actor.vetkd_public_key());
  if (masterPubKey.length !== 96) {
    throw new Error("invalid vetKD master public key");
  }
  // Validate the management-canister response while the operation is still
  // safe to abort rather than discovering corruption after create_sheet.
  DerivedPublicKey.deserialize(masterPubKey);
  return { transport, masterPubKey };
}

/** Derive the authoritative production K_sheet for an existing sheet. */
export async function deriveProdSheetKey(
  actor: Pick<ProdSheetKeyActor, "vetkd_wrap_sheet_key">,
  sheetId: string,
  prepared: ProdSheetKeyContext,
): Promise<Uint8Array> {
  const encryptedVetKey = new Uint8Array(
    await actor.vetkd_wrap_sheet_key(
      sheetId,
      Array.from(prepared.transport.publicKey),
    ),
  );
  // unwrapSheetKeyProd retains the historical canister-id parameter for
  // source compatibility, but it is intentionally unused as of v1.2.2.
  return unwrapSheetKeyProd(
    sheetId,
    prepared.transport,
    prepared.masterPubKey,
    encryptedVetKey,
    new Uint8Array(),
  );
}

function retryableProdSheetKeyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  // Authorization and validation failures cannot become valid by waiting. In
  // particular, a non-member must not turn one denied key request into a burst.
  return !/not a member|does not have access|not signed in|anonymous|sheet is not active|transport_public_key|invalid vetkey|invalid vetkd/i.test(
    message,
  );
}

/**
 * Retry only the post-create network derivation. create_sheet itself is never
 * retried, so a transient key response cannot create duplicate sheets.
 */
export async function retryProdSheetKeyDerivation(
  derive: () => Promise<Uint8Array>,
  options: ProdSheetKeyRetryOptions = {},
): Promise<Uint8Array> {
  const attempts = Math.max(1, options.attempts ?? 4);
  const delayMs = Math.max(0, options.delayMs ?? 100);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await derive();
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !retryableProdSheetKeyError(error)) throw error;
      if (delayMs > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs * 2 ** attempt);
        });
      }
    }
  }
  throw lastError;
}

/** Shared production read/create/invite derivation path. */
export async function deriveProdSheetKeyWithRetry(
  actor: Pick<ProdSheetKeyActor, "vetkd_wrap_sheet_key">,
  sheetId: string,
  prepared: ProdSheetKeyContext,
  options?: ProdSheetKeyRetryOptions,
): Promise<Uint8Array> {
  return retryProdSheetKeyDerivation(
    () => deriveProdSheetKey(actor, sheetId, prepared),
    options,
  );
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

// IndexedDB is retained only to purge the obsolete persisted transport record.

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
