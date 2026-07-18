// Sheet-key session cache.
//
// Two paths:
//
// 1. Dev path (VITE_IOU_PROD_VETKD=0, the default):
//    K_sheet is unwrapped once via get_sheet_wrapped_key + devVetkd's
//    P-256 ECDH, then held in memory. Requires the partner's
//    P-256 public key to be registered first (Pair page).
//
// 2. Prod path (VITE_IOU_PROD_VETKD=1):
//    K_sheet is derived on demand via the IC's vetkd IBE. The PWA
//    holds a BLS12-381 G2 transport key pair (in IndexedDB). To
//    unwrap, it calls vetkd_wrap_sheet_key (which returns the IBE
//    ciphertext) and decrypts via @dfinity/vetkeys. No partner
//    public key needed; the IC vets the unwrap.
//
// Either way, K_sheet is held in memory only — never on disk.

import { createContext, useContext, useState, useCallback } from "react";
import { Principal } from "@dfinity/principal";
import { createActor } from "../../backend/declarations";
import {
  unwrapSheetKey,
  unwrapTaggedSheetKey,
  deriveUserKeypair,
} from "../crypto/devVetkd";
import {
  isProdVetkd,
  loadOrCreateTransportKey,
  deriveSheetKey as deriveSheetKeyProd,
} from "../crypto/prodVetkd";
import { useAuth, buildAgent } from "../auth/AuthProvider";
import { canisterId as canisterIdString } from "../auth/config";
import { unwrap } from "./useActor";

type SheetKeyMap = Record<string, Uint8Array>;
type PartnerKeyMap = Record<string, string>; // sheetId -> wrap-sender's public key (b64)

interface SheetKeyContextValue {
  keys: SheetKeyMap;
  registerPartnerKey: (sheetId: string, publicKeyB64: string) => void;
  unwrapFor: (sheetId: string) => Promise<Uint8Array>;
  get: (sheetId: string) => Uint8Array | undefined;
  /**
   * Seed K_sheet directly into the in-memory cache. Used right after
   * create_sheet — the creator already holds K_sheet, so caching it
   * lets the sheet page render immediately without re-deriving (which
   * would otherwise require the partner's pubkey from the pair page).
   */
  cache: (sheetId: string, key: Uint8Array) => void;
  forget: (sheetId: string) => void;
}

const SheetKeyContext = createContext<SheetKeyContextValue | null>(null);

export function SheetKeyProvider({ children }: { children: React.ReactNode }) {
  const [keys, setKeys] = useState<SheetKeyMap>({});
  // v1.10.0: with self-wrapped keys, no partner-pubkey exchange is needed. The
  // registerPartnerKey hook is retained (no-op cache) for source compatibility
  // until its last caller is removed.
  const [, setPartnerKeys] = useState<PartnerKeyMap>({});
  const { identity } = useAuth();

  const registerPartnerKey = useCallback((sheetId: string, publicKeyB64: string) => {
    setPartnerKeys((prev) => ({ ...prev, [sheetId]: publicKeyB64 }));
  }, []);

  const get = useCallback(
    (sheetId: string) => keys[sheetId],
    [keys],
  );

  const cache = useCallback((sheetId: string, key: Uint8Array) => {
    setKeys((prev) => ({ ...prev, [sheetId]: key }));
  }, []);

  async function unwrapFor(sheetId: string): Promise<Uint8Array> {
    if (keys[sheetId]) return keys[sheetId];
    if (!identity) throw new Error("not signed in");
    // Build the actor via buildAgent so it targets the configured replica
    // host (config.ts, :40436 locally) and *awaits* fetchRootKey. Passing
    // an identity straight to createActor defaults the host to :4943 with
    // an un-awaited fetchRootKey, which surfaced as "certificate
    // verification / Invalid signature" errors on a fresh sheet-page load.
    const agent = await buildAgent(identity);
    const actor = createActor(agent) as any;

    if (isProdVetkd()) {
      // Prod path: vetkd IBE. Each device holds its own transport
      // key; the IC's vetkd decrypts the same K_sheet for any
      // device whose transport public key was registered.
      const transport = await loadOrCreateTransportKey();
      const masterPubKey = await actor.vetkd_public_key();
      const encVetKey = await actor.vetkd_wrap_sheet_key(
        sheetId,
        Array.from(transport.publicKey),
      );
      // `decryptAndVerify` requires a DerivedPublicKey bound to a
      // specific canister; the canister id (as principal bytes) is
      // the "audience" of the IBE ciphertext.
      const canisterIdBytes = Principal.fromText(canisterIdString).toUint8Array();
      const K_sheet = await deriveSheetKeyProd(
        sheetId,
        transport,
        new Uint8Array(masterPubKey),
        new Uint8Array(encVetKey),
        canisterIdBytes,
      );
      setKeys((prev) => ({ ...prev, [sheetId]: K_sheet }));
      return K_sheet;
    }

    // Dev path (v1.10.0+): try SELF-unwrap first — works when I sealed my own slot
    // (I created the sheet, or I joined via accept_invite, which self-wraps K_sheet
    // under my key). If that throws, the blob was CROSS-wrapped by the other member
    // (a sheet they created AFTER I joined — they can't self-wrap for me). Such blobs
    // are TAGGED with the sealer's pubkey, so unwrapTaggedSheetKey needs no external
    // lookup and stays readable even after that member leaves and their slot is
    // anonymized / promoted.
    const myKp = await deriveUserKeypair(identity.getPrincipal().toText());
    const wrapped = unwrap(await actor.get_sheet_wrapped_key(sheetId));
    if (!wrapped || wrapped.length === 0) {
      throw new Error("no wrapped key for this sheet");
    }
    const blob = new Uint8Array(wrapped);
    let K_sheet: Uint8Array;
    try {
      K_sheet = await unwrapSheetKey(blob, myKp.privateKey, myKp.publicKey);
    } catch {
      // Cross-wrapped by the other member — unwrap via the embedded sender pubkey.
      // Map both "not a tagged blob" (null) and a decrypt failure (throw) to one
      // friendly error.
      let K: Uint8Array | null = null;
      try {
        K = await unwrapTaggedSheetKey(blob, myKp.privateKey);
      } catch {
        K = null;
      }
      if (!K) throw new Error("cannot unwrap sheet key");
      K_sheet = K;
    }
    setKeys((prev) => ({ ...prev, [sheetId]: K_sheet }));
    return K_sheet;
  }

  function forget(sheetId: string) {
    setKeys((prev) => {
      const next = { ...prev };
      delete next[sheetId];
      return next;
    });
  }

  return (
    <SheetKeyContext.Provider
      value={{ keys, registerPartnerKey, unwrapFor, get, cache, forget }}
    >
      {children}
    </SheetKeyContext.Provider>
  );
}

export function useSheetKey() {
  const ctx = useContext(SheetKeyContext);
  if (!ctx) throw new Error("useSheetKey must be inside <SheetKeyProvider>");
  return ctx;
}
