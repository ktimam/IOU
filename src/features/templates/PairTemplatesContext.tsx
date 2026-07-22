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
//     decrypts BOTH per-member slots (full v2 payloads: templates +
//     dismissed card ids) — a partner slot that fails AES-GCM (stale after
//     a K_sheet rotation, until they republish) degrades to the readable
//     slot instead of throwing;
//   * MIRRORS my personal template list into MY slot: types are ALWAYS
//     shared to the account (no Share toggle). A reconcile effect compares
//     the personal list to my current slot (reconcileSlot) and publishes
//     ONLY when a real diff exists — new/changed ids upserted at nextRev,
//     ids no longer in my personal list dropped (absence, not tombstone:
//     a removed copy-on-write override lets the partner's original
//     resurface via the merge). Content comparison ignores rev/updatedAt
//     bookkeeping, so the effect cannot publish-loop;
//   * exposes the commutative merge (shared view), the merged `dismissed`
//     union (cross-member "✕ dismissed" pending-card messageIds), and
//     dismissCard(messageId) which appends to MY slot's dismissed list and
//     republishes — the partner's client picks it up on its next pair load
//     (reload() is exposed for the visibilitychange hook);
//   * after each publish, re-syncs the OpenChat manifest with the merged
//     personal + shared list so chat keywords on partner-authored types
//     route on THIS member's manifest too.
//
// The user-level TemplatesProvider store is untouched: shared types AUGMENT
// per-pair consumption (combineTemplates), they don't replace it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { encryptWithSheetKey } from "../crypto/devVetkd";
import { syncManifestWithTypes } from "../openchat/syncManifest";
import { useTemplates } from "./TemplatesContext";
import {
  type SharedTemplate,
  type PairSlotPayload,
  encodePairSlot,
  mergePairTemplates,
  mergeDismissed,
  reconcileSlot,
  visibleTemplates,
  combineTemplates,
} from "./pairTemplates";
import { decryptSlot, myMemberIndex } from "./pairTemplatesActor";

export type PairTemplatesApi = {
  /** Visible merged shared templates (tombstones hidden), name-sorted. */
  shared: SharedTemplate[];
  /** Full merged view incl. legacy tombstones (rev bookkeeping). */
  merged: SharedTemplate[];
  /** Cross-member dismissed pending-card messageIds (mine ∪ partner's). */
  dismissed: Set<string>;
  loading: boolean;
  error: string | null;
  /** Dismiss a pending chat card for ALL members: append the messageId to
   *  MY slot's dismissed list and republish. */
  dismissCard: (messageId: string) => Promise<void>;
  /** Re-fetch the pair slots (e.g. when the tab regains visibility), so a
   *  partner's dismissals/templates land without a full page reload. */
  reload: () => void;
};

const EMPTY_PAYLOAD: PairSlotPayload = { templates: [], dismissed: [] };

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
  const { templates: personal, loading: personalLoading } = useTemplates();

  const [mySlot, setMySlot] = useState<PairSlotPayload>(EMPTY_PAYLOAD);
  const [partnerSlot, setPartnerSlot] = useState<PairSlotPayload>(EMPTY_PAYLOAD);
  // Only reconcile against a slot we actually LOADED — publishing before the
  // fetch lands would clobber the real slot with an empty-based mirror.
  const [slotsLoaded, setSlotsLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setMySlot(EMPTY_PAYLOAD);
    setPartnerSlot(EMPTY_PAYLOAD);
    setSlotsLoaded(false);
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
        setSlotsLoaded(true);
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
  }, [pairId, sheetId, actor, identity, reloadTick]);

  // Memoized: consumers use these as effect/useMemo deps (e.g. SheetPage's
  // visibleInbox keys on `dismissed`), so keep the identities stable.
  const merged = useMemo(
    () => mergePairTemplates(mySlot.templates, partnerSlot.templates),
    [mySlot, partnerSlot],
  );
  const shared = useMemo(() => visibleTemplates(merged), [merged]);
  const dismissed = useMemo(
    () => new Set(mergeDismissed(mySlot.dismissed, partnerSlot.dismissed)),
    [mySlot, partnerSlot],
  );

  const publish = useCallback(
    async (next: PairSlotPayload) => {
      if (!pairId || !sheetId || !actor) throw new Error("no active pair/sheet");
      const K = get(sheetId) ?? (await unwrapFor(sheetId));
      const { iv, ciphertext } = await encryptWithSheetKey(
        K,
        encodePairSlot(next.templates, next.dismissed),
      );
      await actor.set_pair_templates(pairId, Array.from(ciphertext), Array.from(iv));
      setMySlot(next);
      // Keep the OpenChat manifest in lock-step with what this member can
      // now be routed to: personal + the NEW merged shared list.
      const nextShared = visibleTemplates(
        mergePairTemplates(next.templates, partnerSlot.templates),
      );
      void syncManifestWithTypes(identity, combineTemplates(personal, nextShared));
    },
    [pairId, sheetId, actor, get, unwrapFor, partnerSlot, personal, identity],
  );

  // ── the mirror: my slot ≡ my personal templates ────────────────────
  // Publishes only on real drift (reconcileSlot returns null otherwise) and
  // never concurrently; on success setMySlot makes the next pass a no-op, on
  // failure the deps are unchanged so the effect does not retry-loop.
  const publishing = useRef(false);
  useEffect(() => {
    if (!slotsLoaded || personalLoading || publishing.current) return;
    const next = reconcileSlot(personal, mySlot.templates, merged, Date.now());
    if (!next) return;
    publishing.current = true;
    void publish({ templates: next, dismissed: mySlot.dismissed })
      .catch((e) => setError((e as Error).message))
      .finally(() => {
        publishing.current = false;
      });
    // merged is derived from the two slots; personal/mySlot/partnerSlot cover it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotsLoaded, personalLoading, personal, mySlot, partnerSlot]);

  const dismissCard = useCallback(
    async (messageId: string) => {
      if (mySlot.dismissed.includes(messageId)) return;
      await publish({
        templates: mySlot.templates,
        dismissed: mergeDismissed(mySlot.dismissed, [messageId]),
      });
    },
    [mySlot, publish],
  );

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  return { shared, merged, dismissed, loading, error, dismissCard, reload };
}

// The non-hook helpers (rotateMyPairTemplates for the sheet-rotation step,
// loadAllSharedTemplates for the settings-page manifest fold) live in
// pairTemplatesActor.ts so Node-side callers never import React.
