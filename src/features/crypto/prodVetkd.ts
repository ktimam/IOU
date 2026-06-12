// prodVetkd.ts — the production vetkd adapter.
//
// Status: v1.1 scaffolding. The actual IBE decryption (decrypt the
// IBE ciphertext returned by the canister's vetkd_derive_key) is
// v1.1.1 — it needs a BLS12-381 G2 IBE implementation in the browser
// (e.g. @noble/curves with a custom hash-to-G1 or the IC SDK's
// @icp-sdk/vetkeys client). The shape is in place; the call sites
// are stable.
//
// Feature flag: VITE_IOU_PROD_VETKD=1 selects this adapter. When
// unset, the devVetkd.ts adapter (P-256 ECDH + HKDF + AES-GCM with
// localStorage keypair) is used. The dev adapter is the default for
// local development because the local replica (dfx 0.24.3) doesn't
// export the cost_call system API that ic-cdk 0.20 requires.
//
// When the prod path is live, the PWA:
//   1. Generates a BLS12-381 G2 transport key pair (one per user,
//      kept in IndexedDB or in the platform secure element).
//   2. Persists the secret in IndexedDB.
//   3. To wrap K_sheet for sheet_id: calls
//      canister.vetkd_wrap_sheet_key(sheet_id, transport_pub) which
//      returns an IBE ciphertext bound to (this_canister, sheet_id).
//   4. To unwrap: decrypts the IBE ciphertext with the transport
//      secret, then HKDFs the resulting symmetric key to get K_sheet.

import { importPublicKeyB64Wrap } from "./devVetkd";

export function isProdVetkd(): boolean {
  return import.meta.env.VITE_IOU_PROD_VETKD === "1";
}

export interface VetkdTransportKey {
  publicKey: Uint8Array; // 96 bytes BLS12-381 G2
  publicKeyB64: string;
  secretKey: Uint8Array; // 32 bytes scalar in Fr
}

const STORAGE_KEY = "iou:vetkd:transport:v1";

/** Load or generate a BLS12-381 G2 transport key pair. */
export async function loadOrCreateTransportKey(): Promise<VetkdTransportKey> {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB not available — prod vetkd requires a browser");
  }
  // The actual IBE primitives are v1.1.1. For now, this throws a
  // clear error if the user enables VITE_IOU_PROD_VETKD without the
  // underlying primitives being available.
  const stored = await idbGet<VetkdTransportKey>(STORAGE_KEY);
  if (stored) return stored;
  throw new Error(
    "VITE_IOU_PROD_VETKD=1 requires a BLS12-381 G2 IBE library; " +
      "this is a v1.1.1 deliverable. See docs/07-v1.1-plan.md.",
  );
}

/**
 * Wrap K_sheet for the current user using prod vetkd. The canister
 * returns the IBE encrypted_key; the PWA stores it (it's already
 * bound to (this_canister, sheet_id) via the IBE input + context).
 */
export async function wrapSheetKeyProd(
  K_sheet: Uint8Array,
  transport: VetkdTransportKey,
  sheetId: string,
  callCanister: (sheetId: string, transportPub: number[]) => Promise<number[]>,
): Promise<Uint8Array> {
  const encKey = await callCanister(sheetId, Array.from(transport.publicKey));
  // The canister returns the IBE ciphertext; we don't need to do
  // anything else on the wrap side. The PWA stores encKey in the
  // sheet record. (Vetkd can re-derive the same ciphertext on demand
  // because the IBE is deterministic given (input, context, key,
  // transport).)
  return new Uint8Array(encKey);
}

/**
 * Unwrap K_sheet for the current user using prod vetkd. The PWA
 * fetches the IBE ciphertext from the canister (it's the same
 * wrap result, since the IBE is deterministic) and decrypts it
 * client-side using the transport secret. The IBE result is then
 * HKDFed to get K_sheet.
 */
export async function unwrapSheetKeyProd(
  sheetId: string,
  transport: VetkdTransportKey,
  fetchEncKey: (sheetId: string) => Promise<number[]>,
): Promise<Uint8Array> {
  const encKey = new Uint8Array(await fetchEncKey(sheetId));
  // IBE decrypt + HKDF are v1.1.1 deliverables. For now, throw
  // a clear error.
  throw new Error(
    "prod vetkd unwrap is a v1.1.1 deliverable; see docs/07-v1.1-plan.md",
  );
}

// ─── IndexedDB shim (minimal; no external deps) ───

function idbGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("iou-vetkd", 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore("keys");
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("keys", "readonly");
      const get = tx.objectStore("keys").get(key);
      get.onsuccess = () => resolve((get.result as T) ?? null);
      get.onerror = () => reject(get.error);
    };
  });
}

// Re-export for the consumer's convenience (it can also import from
// devVetkd directly, but the prod path also needs the b64 import).
export { importPublicKeyB64Wrap };
