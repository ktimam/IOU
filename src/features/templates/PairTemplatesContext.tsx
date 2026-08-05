// ACCOUNT-SCOPED transaction types — the client wiring around the pure
// core (pairTemplates.ts).
//
// A type belongs to the account (pair) where it was created: it lives in
// its author's encrypted slot on THAT Pair, is visible to both members of
// that account only, and nothing follows the author into their other
// accounts. Unlike the legacy app-wide TemplatesProvider (user-PERSONAL
// templates under a self-derived key — now a read-only migration source),
// these are scoped to ONE pair and sealed under that pair's ACTIVE sheet
// K_sheet, so there is no app-level provider here:
// `usePairTemplates(pairId, sheetId)` is a per-pair hook the sheet page
// mounts with the ids it already has (a global context can't know the
// pair). It:
//
//   * loads the Pair via get_pair, unwraps K_sheet via useSheetKey, and
//     decrypts BOTH per-member slots (full v2 payloads: templates +
//     dismissed card ids) — a partner slot that fails AES-GCM (stale after
//     a K_sheet rotation, until they republish) degrades to the readable
//     slot instead of throwing;
//   * exposes the account's type CRUD: upsertMyTemplate (create, edit, AND
//     copy-on-write of a partner's type — a same-id upsert into MY slot at
//     nextRev, their slot untouched) and removeMyTemplate (drop the id from
//     MY slot — absence, not tombstone: removing my override resurfaces the
//     partner's original; removing my own type removes it for both);
//   * exposes the commutative merge (shared view), `myIds` (live ids in MY
//     slot — everything else in `shared` is partner-authored), the merged
//     `dismissed` union (cross-member "✕ dismissed" pending-card
//     messageIds), and dismissCard(messageId) which appends to MY slot's
//     dismissed list and republishes — the partner's client picks it up on
//     its next pair load (reload() is exposed for the visibilitychange
//     hook). Every publish carries MY current dismissed list forward, so
//     type CRUD never drops a dismissal;
//   * keeps those decrypted names and keywords inside the linked account;
//     they are never folded into OpenChat's public, user-global manifest.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { encryptWithSheetKey } from "../crypto/devVetkd";
import type { TxnTemplate } from "./TemplatesContext";
import {
  type SharedTemplate,
  type PairSlotPayload,
  encodePairSlot,
  mergePairTemplates,
  mergeDismissed,
  upsertMyTemplateSlot,
  removeTemplateFromSlot,
  visibleTemplates,
} from "./pairTemplates";
import { decryptSlot, myMemberIndex } from "./pairTemplatesActor";

export type PairTemplatesApi = {
  /** Visible merged shared templates (tombstones hidden), name-sorted. */
  shared: SharedTemplate[];
  /** Full merged view incl. legacy tombstones (rev bookkeeping). */
  merged: SharedTemplate[];
  /** Ids present LIVE in MY slot — mine to Edit/Remove. Everything in
   *  `shared` whose id is NOT here is partner-authored ("Edit a copy"). */
  myIds: Set<string>;
  /** Cross-member dismissed pending-card messageIds (mine ∪ partner's). */
  dismissed: Set<string>;
  loading: boolean;
  error: string | null;
  /** Create / edit / copy-on-write a type in THIS account (id absent → one
   *  is generated). A same-id upsert of a partner's type lands MY override
   *  in MY slot at the next rev — their slot is never touched. */
  upsertMyTemplate: (t: Omit<TxnTemplate, "id"> & { id?: string }) => Promise<void>;
  /** Remove a type from THIS account: drop the id from MY slot (absence,
   *  not tombstone). Removing my override resurfaces the partner's
   *  original; removing my own type removes it for both members. */
  removeMyTemplate: (id: string) => Promise<void>;
  /** Dismiss a pending chat card for ALL members: append the messageId to
   *  MY slot's dismissed list and republish. */
  dismissCard: (messageId: string) => Promise<void>;
  /** Re-fetch the pair slots (e.g. when the tab regains visibility), so a
   *  partner's dismissals/templates land without a full page reload. */
  reload: () => void;
};

const EMPTY_PAYLOAD: PairSlotPayload = { templates: [], dismissed: [] };

/**
 * Per-pair account-scoped templates. Pass the pair id and its ACTIVE sheet
 * id (the K_sheet everything is sealed under); either missing → inert empty
 * API.
 */
export function usePairTemplates(
  pairId: string | undefined,
  sheetId: string | undefined,
): PairTemplatesApi {
  const { identity } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();

  const [mySlot, setMySlot] = useState<PairSlotPayload>(EMPTY_PAYLOAD);
  const [partnerSlot, setPartnerSlot] = useState<PairSlotPayload>(EMPTY_PAYLOAD);
  // Only allow slot CRUD against a slot we actually LOADED — publishing
  // before the fetch lands would clobber the real slot with an empty base.
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
  const myIds = useMemo(
    () => new Set(mySlot.templates.filter((t) => !t.deleted).map((t) => t.id)),
    [mySlot],
  );
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
    },
    [pairId, sheetId, actor, get, unwrapFor],
  );

  const upsertMyTemplate = useCallback(
    async (t: Omit<TxnTemplate, "id"> & { id?: string }) => {
      if (!slotsLoaded) throw new Error("account types are still loading — try again");
      const id =
        t.id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await publish({
        templates: upsertMyTemplateSlot(mySlot.templates, merged, { ...t, id }, Date.now()),
        dismissed: mySlot.dismissed,
      });
    },
    [slotsLoaded, mySlot, merged, publish],
  );

  const removeMyTemplate = useCallback(
    async (id: string) => {
      if (!slotsLoaded) throw new Error("account types are still loading — try again");
      await publish({
        templates: removeTemplateFromSlot(mySlot.templates, id),
        dismissed: mySlot.dismissed,
      });
    },
    [slotsLoaded, mySlot, publish],
  );

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

  return {
    shared,
    merged,
    myIds,
    dismissed,
    loading,
    error,
    upsertMyTemplate,
    removeMyTemplate,
    dismissCard,
    reload,
  };
}

// Non-hook helpers for sheet rotation and diagnostics live in
// pairTemplatesActor.ts so Node-side callers never import React.
