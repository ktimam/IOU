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
  importPublicKeyB64Wrap,
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
  const [partnerKeys, setPartnerKeys] = useState<PartnerKeyMap>({});
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

    // Dev path: P-256 ECDH wrap (back-compat with v1.1.0).
    let senderB64 = partnerKeys[sheetId];
    if (!senderB64) {
      // Fallback so the sheet page works on a fresh load without having
      // visited the pair page first. The creator (member_a) self-wrapped
      // K_sheet with their own key, so derive the wrap-sender from the
      // sheet: my own pubkey if I'm the creator, else the creator's
      // published pubkey (granted-partner case).
      const sheet = unwrap(await actor.get_sheet(sheetId));
      if (sheet) {
        const me = identity.getPrincipal().toText();
        const creatorText =
          sheet.member_a && typeof sheet.member_a.toText === "function"
            ? sheet.member_a.toText()
            : String(sheet.member_a ?? "");
        if (me === creatorText) {
          const myKp = await deriveUserKeypair(me);
          senderB64 = myKp.publicKeyB64;
        } else {
          const raw = unwrap(await actor.get_sheet_pubkey(sheet.member_a));
          if (raw) {
            senderB64 = new TextDecoder().decode(
              new Uint8Array(raw as number[]),
            );
          }
        }
      }
    }
    if (!senderB64) {
      throw new Error(
        "missing partner public key for sheet " + sheetId +
          " — visit the pair page first so it can be cached",
      );
    }
    const wrapped = unwrap(await actor.get_sheet_wrapped_key(sheetId));
    if (!wrapped) throw new Error("no wrapped key for this sheet");
    const senderPub = await importPublicKeyB64Wrap(senderB64);
    const myKp = await deriveUserKeypair(identity.getPrincipal().toText());
    const K_sheet = await unwrapSheetKey(
      new Uint8Array(wrapped),
      myKp.privateKey,
      senderPub,
    );
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
