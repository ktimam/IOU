// Re-register the OpenChat manifest with the user's ACCOUNT-SCOPED types
// once on app load (per signed-in identity).
//
// Types live in per-account pair slots (pairTemplates.ts), and each
// account's chat routes through THIS user's manifest — so the manifest's
// keyword rules must cover the types of ALL the user's accounts. A fresh
// deploy re-registers the BASE manifest (no template rules); without this
// sync a participating user's existing types would stay unmapped until
// their next type edit (the pair-slot publish path re-syncs on every edit,
// and Connect re-syncs too — this covers plain app loads).
//
// This used to live in TemplatesProvider fed by the LEGACY personal store;
// it now folds slot types via loadAllSharedTemplates, which needs the
// sheet-key unwrapper — hence a component INSIDE SheetKeyProvider (the
// templates provider sits outside it). Renders nothing.
//
// Cheap gate first: skip the pair walk + crypto entirely unless the user
// participates in OpenChat (connected via the 6-digit Connect OR linked) —
// the same participation rule maybeSyncManifest enforces.

import { useEffect } from "react";
import { useAuth, buildAgent } from "../auth/AuthProvider";
import { createActor } from "../../backend/declarations";
import { useSheetKey } from "../flows/SheetKeyContext";
import { loadAllSharedTemplates } from "../templates/pairTemplatesActor";
import { syncManifestWithTypes } from "./syncManifest";
import { readManifestSyncState, shouldSyncOpenChatManifest } from "./manifestSync";

export function ManifestTypesSync() {
  const { identity, state } = useAuth();
  const { unwrapFor } = useSheetKey();

  useEffect(() => {
    if (!identity || state.kind !== "authenticated") return;
    let cancelled = false;
    void (async () => {
      try {
        const principal = identity.getPrincipal().toText();
        if (!shouldSyncOpenChatManifest(readManifestSyncState(principal))) return;
        const actor = createActor(await buildAgent(identity)) as any;
        const types = await loadAllSharedTemplates(actor, unwrapFor);
        if (cancelled) return;
        await syncManifestWithTypes(identity, types);
      } catch {
        /* best-effort — the next type edit or Connect re-syncs */
      }
    })();
    return () => {
      cancelled = true;
    };
    // unwrapFor is stable enough for this once-per-identity sync; keying on
    // it would re-fire on every sheet-key cache update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, state.kind]);

  return null;
}
