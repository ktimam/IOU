// Refresh IOU's static public OpenChat manifest once on app load for a
// participating identity. Private account templates never enter this path;
// matching happens locally inside the linked account after import.

import { useEffect } from "react";
import { useAuth } from "../auth/AuthProvider";
import { syncOpenChatManifest } from "./syncManifest";
import { readManifestSyncState, shouldSyncOpenChatManifest } from "./manifestSync";

export function ManifestTypesSync() {
  const { identity, state } = useAuth();

  useEffect(() => {
    if (!identity || state.kind !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      try {
        const principal = identity.getPrincipal().toText();
        if (!shouldSyncOpenChatManifest(readManifestSyncState(principal))) return;
        if (cancelled) return;
        await syncOpenChatManifest(identity);
      } catch {
        /* best-effort — Connect or a later app load retries */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [identity, state.kind]);

  return null;
}
