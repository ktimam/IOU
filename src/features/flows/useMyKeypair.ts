// Partner public-key exchange.
//
// In v1 dev (no real vetkd), the partner's P-256 public key is
// registered on the pair page after both members are present. The
// flow is:
//
//   1. User A creates a pair — gets an invite code.
//   2. User B joins with the invite code.
//   3. User A opens /pair/:pairId — derives their keypair (or loads it
//      from localStorage), shows the public key, and has the
//      partner's principal pre-registered (from the pair's members
//      list).
//   4. User B also opens /pair/:pairId — does the same.
//   5. When the sheet is later created, the creator wraps K_sheet for
//      both members using their own private key. Both members have
//      already cached the partner's public key (this is the PWA-only
//      "exchange" — in production with real vetkd this would be
//      handled by the vetkd-encrypted blob itself).
//
// For now, v1 dev short-circuits this: when the Pair page loads, it
// derives (or loads) the user's keypair and exposes it via
// useMyKeypair(). The PWA also calls get_partner_public_key() to fetch
// the partner's previously-published key (also persisted in
// localStorage on the partner's device).
//
// In v1, the PWA is local-first, so partner-key exchange is best-
// effort: the user can either (a) type the partner's public key in
// manually, (b) share a link, or (c) use the "same browser" mode
// where the PWA switches identities via the auth flow.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { deriveUserKeypair } from "../crypto/devVetkd";

export function useMyKeypair() {
  const { state } = useAuth();
  const [kp, setKp] = useState<{
    publicKeyB64: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      setKp(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const k = await deriveUserKeypair(state.identity.getPrincipal().toText());
        if (!cancelled) setKp({ publicKeyB64: k.publicKeyB64 });
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  return { keypair: kp, err };
}
