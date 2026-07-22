// SHARED transaction types per account — the client wiring around the pure
// core (pairTemplates.ts).
//
// Unlike the app-wide TemplatesProvider (user-PERSONAL templates under a
// self-derived key), shared templates are scoped to ONE pair and sealed
// under that pair's ACTIVE sheet K_sheet, so there is no app-level provider
// here: `usePairTemplates(pairId, sheetId)` is a per-pair hook the sheet
// page mounts with the ids it already has (a global context can't know the
// pair). It:
//
//   * loads the Pair via get_pair, unwraps K_sheet via useSheetKey, and
//     decrypts BOTH per-member slots — a partner slot that fails AES-GCM
//     (stale after a K_sheet rotation, until they republish) degrades to
//     the readable slot instead of throwing;
//   * exposes the commutative merge (shared view) plus publish actions
//     that ONLY ever rewrite the CALLER's own slot: shareTemplate,
//     unshareTemplate (tombstone) and editShared (copy-on-write override
//     of a partner-authored template at nextRev);
//   * after each publish, re-syncs the OpenChat manifest with the merged
//     personal + shared list so chat keywords on partner-authored types
//     route on THIS member's manifest too.
//
// The user-level TemplatesProvider store is untouched: shared types AUGMENT
// per-pair consumption (combineTemplates), they don't replace it.

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { encryptWithSheetKey } from "../crypto/devVetkd";
import { syncManifestWithTypes } from "../openchat/syncManifest";
import { useTemplates, type TxnTemplate } from "./TemplatesContext";
import {
  type SharedTemplate,
  encodePairSlot,
  mergePairTemplates,
  visibleTemplates,
  nextRev,
  upsertSlot,
  combineTemplates,
} from "./pairTemplates";
import { decryptSlot, myMemberIndex } from "./pairTemplatesActor";

export type PairTemplatesApi = {
  /** Visible merged shared templates (tombstones hidden), name-sorted. */
  shared: SharedTemplate[];
  /** Full merged view incl. tombstones (rev bookkeeping). */
  merged: SharedTemplate[];
  /** Ids currently shared by ME (live in my slot). */
  myIds: Set<string>;
  loading: boolean;
  error: string | null;
  /** Publish (or republish) a template into MY slot at the next rev. */
  shareTemplate: (t: TxnTemplate) => Promise<void>;
  /** Tombstone a shared template in MY slot (hides it for both members). */
  unshareTemplate: (id: string) => Promise<void>;
  /** Copy-on-write edit of a (possibly partner-authored) shared template:
   *  same id, next rev, written into MY slot only. */
  editShared: (t: TxnTemplate) => Promise<void>;
};

const EMPTY: SharedTemplate[] = [];

/**
 * Per-pair shared templates. Pass the pair id and its ACTIVE sheet id (the
 * K_sheet everything is sealed under); either missing → inert empty API.
 */
export function usePairTemplates(
  pairId: string | undefined,
  sheetId: string | undefined,
): PairTemplatesApi {
  const { identity } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();
  const { templates: personal } = useTemplates();

  const [mySlot, setMySlot] = useState<SharedTemplate[]>(EMPTY);
  const [partnerSlot, setPartnerSlot] = useState<SharedTemplate[]>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMySlot(EMPTY);
    setPartnerSlot(EMPTY);
    setError(null);
    if (!pairId || !sheetId || !actor || !identity) return;
    (async () => {
      setLoading(true);
      try {
        const pair = unwrap(await actor.get_pair(pairId)) as any;
        if (!pair) return;
        const idx = myMemberIndex(pair, identity.getPrincipal().toText());
        if (idx == null) return;
        const K = get(sheetId) ?? (await unwrapFor(sheetId));
        const a = await decryptSlot(K, pair.templates_a_enc, pair.templates_a_iv);
        const b = await decryptSlot(K, pair.templates_b_enc, pair.templates_b_iv);
        if (cancelled) return;
        setMySlot(idx === 0 ? a : b);
        setPartnerSlot(idx === 0 ? b : a);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairId, sheetId, actor, identity]);

  const merged = mergePairTemplates(mySlot, partnerSlot);
  const shared = visibleTemplates(merged);
  const myIds = new Set(mySlot.filter((t) => !t.deleted).map((t) => t.id));

  const publish = useCallback(
    async (nextMySlot: SharedTemplate[]) => {
      if (!pairId || !sheetId || !actor) throw new Error("no active pair/sheet");
      const K = get(sheetId) ?? (await unwrapFor(sheetId));
      const { iv, ciphertext } = await encryptWithSheetKey(K, encodePairSlot(nextMySlot));
      await actor.set_pair_templates(pairId, Array.from(ciphertext), Array.from(iv));
      setMySlot(nextMySlot);
      // Keep the OpenChat manifest in lock-step with what this member can
      // now be routed to: personal + the NEW merged shared list.
      const nextShared = visibleTemplates(mergePairTemplates(nextMySlot, partnerSlot));
      void syncManifestWithTypes(identity, combineTemplates(personal, nextShared));
    },
    [pairId, sheetId, actor, get, unwrapFor, partnerSlot, personal, identity],
  );

  const shareTemplate = useCallback(
    async (t: TxnTemplate) => {
      const envelope: SharedTemplate = {
        ...t,
        rev: nextRev(merged, t.id),
        updatedAt: Date.now(),
      };
      delete (envelope as Partial<SharedTemplate>).deleted;
      await publish(upsertSlot(mySlot, envelope));
    },
    [merged, mySlot, publish],
  );

  const unshareTemplate = useCallback(
    async (id: string) => {
      const prior = merged.find((t) => t.id === id);
      if (!prior) return;
      const tombstone: SharedTemplate = {
        ...prior,
        rev: nextRev(merged, id),
        updatedAt: Date.now(),
        deleted: true,
      };
      await publish(upsertSlot(mySlot, tombstone));
    },
    [merged, mySlot, publish],
  );

  // Copy-on-write is literally "share my version at the next rev".
  const editShared = shareTemplate;

  return { shared, merged, myIds, loading, error, shareTemplate, unshareTemplate, editShared };
}

// The non-hook helpers (rotateMyPairTemplates for the sheet-rotation step,
// loadAllSharedTemplates for the settings-page manifest fold) live in
// pairTemplatesActor.ts so Node-side callers never import React.
