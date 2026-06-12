// Sheet-key session cache.
//
// K_sheet is unwrapped once via get_sheet_wrapped_key + devVetkd, then
// held in memory for the rest of the browser session. Closing the PWA
// tab or hard-refresh forces a re-unwrap, which is the desired
// behavior for "zero plaintext on disk".
//
// The wrap-sender's P-256 public key is required for unwrap. It's
// registered via `registerPartnerKey(sheetId, publicKeyB64)` from the
// Pair page (where the user has just exchanged/derived it).

import { createContext, useContext, useState, useCallback } from "react";
import { createActor } from "../../backend/declarations";
import { unwrapSheetKey, importPublicKeyB64Wrap, deriveUserKeypair } from "../crypto/devVetkd";
import { useAuth } from "../auth/AuthProvider";
import { unwrap } from "./useActor";

type SheetKeyMap = Record<string, Uint8Array>;
type PartnerKeyMap = Record<string, string>; // sheetId -> wrap-sender's public key (b64)

interface SheetKeyContextValue {
  keys: SheetKeyMap;
  registerPartnerKey: (sheetId: string, publicKeyB64: string) => void;
  unwrapFor: (sheetId: string) => Promise<Uint8Array>;
  get: (sheetId: string) => Uint8Array | undefined;
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

  async function unwrapFor(sheetId: string): Promise<Uint8Array> {
    if (keys[sheetId]) return keys[sheetId];
    if (!identity) throw new Error("not signed in");
    const senderB64 = partnerKeys[sheetId];
    if (!senderB64) {
      throw new Error(
        "missing partner public key for sheet " + sheetId +
          " — visit the pair page first so it can be cached",
      );
    }
    const actor = createActor(identity) as any;
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
      value={{ keys, registerPartnerKey, unwrapFor, get, forget }}
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
