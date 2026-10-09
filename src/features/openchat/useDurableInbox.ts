import { useCallback, useEffect, useRef, useState } from "react";
import type { Identity } from "@dfinity/agent";
import type { TxnTemplate } from "../templates/TemplatesContext";
import type { EntryPayload } from "../entries/types";
import { host as backendHost, canisterId as backendCanisterId } from "../auth/config";
import { createLocalImportSaveLock, type LocalSheetImport } from "./localImportSheet";
import type { IouDeliveryContext } from "./localImportEncryption";
import { loadDurableInbox, saveDurableInboxItem, dismissDurableInboxItem, type DurableInboxItem } from "./durableInboxService";

type Options = {
  enabled: boolean;
  actor: any;
  principal: string | null;
  identity: Identity | null | undefined;
  sheetId: string;
  pairId: string | undefined;
  ready: boolean;
  /** True only while the current sheet's required Types are still loading. */
  waiting?: boolean;
  generation: unknown;
  templates: readonly TxnTemplate[];
  unwrapFor: (sheetId: string) => Promise<Uint8Array>;
};

/** Loads encrypted pending deliveries into the existing sheet UI. Polling never saves or dismisses. */
export function useDurableInbox(options: Options) {
  const live = useRef(options);
  live.current = options;
  const mounted = useRef(true);
  const [loaded, setLoaded] = useState<{ owner: Options; items: DurableInboxItem[] }>();
  const [loadState, setLoadState] = useState<{ owner: Options; pending: boolean }>();
  const [selection, setSelection] = useState<{ owner: Options; item: DurableInboxItem }>();
  const [notice, setNotice] = useState("");
  const [refreshTick, setRefreshTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const operationRevision = useRef(0);
  const saveLocks = useRef(new Map<string, ReturnType<typeof createLocalImportSaveLock>>());
  const refresh = useCallback(() => setRefreshTick(value => value + 1), []);

  function matches(captured: Options) {
    const current = live.current;
    return mounted.current && captured.enabled && current.enabled && current.ready &&
      !!captured.actor && !!captured.principal && !!captured.identity && !!captured.pairId &&
      captured.actor === current.actor && captured.principal === current.principal &&
      captured.identity === current.identity && captured.sheetId === current.sheetId &&
      captured.pairId === current.pairId && captured.generation === current.generation &&
      captured.templates === current.templates;
  }
  function assertCurrent(captured: Options) {
    if (!matches(captured)) throw new Error("The IOU account, sheet or Types changed. Reopen the pending entry; nothing further was submitted.");
  }
  function context(captured: Options): IouDeliveryContext {
    assertCurrent(captured);
    return { principal: captured.principal!, backendHost, backendCanisterId,
      pairId: captured.pairId!, sheetId: captured.sheetId };
  }

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    operationRevision.current++;
    setSelection(undefined); setNotice(""); saveLocks.current.clear();
  }, [options.actor, options.identity, options.principal, options.sheetId, options.pairId, options.generation, options.templates]);

  useEffect(() => {
    const captured = live.current;
    if (!captured.enabled || !captured.ready || !captured.actor || !captured.identity || !captured.principal || !captured.pairId) return;
    let cancelled = false;
    let loading = false;
    const assert = () => { if (cancelled) throw new Error("Pending inbox view closed"); assertCurrent(captured); };
    const load = async () => {
      if (loading || cancelled || working.current) return;
      loading = true;
      setLoadState({ owner: captured, pending: true });
      const revision = operationRevision.current;
      try {
        assert();
        const result = await loadDurableInbox({ actor: captured.actor, principal: captured.principal!,
          identity: captured.identity!, context: context(captured), templates: [...captured.templates], assertCurrent: assert });
        assert();
        if (working.current || revision !== operationRevision.current) return;
        setLoaded({ owner: captured, items: [...result.items] });
        if (result.errors.length) setNotice(result.errors.join(" "));
      } catch {
        if (!cancelled && matches(captured) && !working.current && revision === operationRevision.current) {
          setNotice("Pending entries could not be refreshed. Existing drafts were not removed. Retry when IOU is available.");
        }
      } finally {
        loading = false;
        if (!cancelled && matches(captured)) setLoadState({ owner: captured, pending: false });
      }
    };
    void load();
    const visible = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    document.addEventListener("visibilitychange", visible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [options.enabled, options.actor, options.identity, options.principal, options.sheetId, options.pairId,
    options.ready, options.generation, options.templates, refreshTick]);

  const items = loaded && matches(loaded.owner) ? loaded.items : [];
  const loading = options.enabled && !!options.actor && !!options.principal && !!options.identity && !!options.pairId && !busy &&
    (!!options.waiting || (options.ready && (!loadState || !matches(loadState.owner) || loadState.pending)));
  const selected = selection && matches(selection.owner) && items.some(item => item.id === selection.item.id)
    ? selection : undefined;

  async function dismiss(item: DurableInboxItem) {
    const captured = live.current;
    if (working.current) return;
    operationRevision.current++;
    working.current = true; setBusy(true);
    try {
      assertCurrent(captured);
      await dismissDurableInboxItem({ actor: captured.actor, item, assertCurrent: () => assertCurrent(captured) });
      assertCurrent(captured);
      setLoaded(before => before && matches(before.owner)
        ? { ...before, items: before.items.filter(candidate => candidate.id !== item.id) } : before);
      setSelection(before => before?.item.id === item.id ? undefined : before);
      setNotice("Pending entry dismissed. No ledger entry was added.");
    } catch {
      if (matches(captured)) setNotice("Dismissal was not confirmed. The pending entry was retained; refresh before retrying.");
    } finally { working.current = false; if (mounted.current) { setBusy(false); refresh(); } }
  }

  function forReview(item: DurableInboxItem, captured: Options): LocalSheetImport {
    return {
      sheetId: captured.sheetId, pairId: captured.pairId!, importId: item.id,
      drafts: item.drafts ?? [], ready: matches(captured) && !!item.drafts?.length && !item.error,
      saved: false, notice,
      assertCurrent: () => assertCurrent(captured),
      dismiss: () => { void dismiss(item); },
      save: async (payloads: readonly EntryPayload[]) => {
        assertCurrent(captured);
        if (working.current || item.error || !item.drafts?.length) throw new Error("This pending entry is unavailable or already being handled.");
        let lock = saveLocks.current.get(item.id);
        if (!lock) { lock = createLocalImportSaveLock(item.id, item.drafts.length); saveLocks.current.set(item.id, lock); }
        const reviewed = lock(payloads);
        operationRevision.current++;
        working.current = true; setBusy(true);
        try {
          const sheetKey = await captured.unwrapFor(captured.sheetId); assertCurrent(captured);
          const result = await saveDurableInboxItem({ actor: captured.actor, item, context: context(captured),
            payloads: reviewed, sheetKey, assertCurrent: () => assertCurrent(captured) });
          assertCurrent(captured);
          setNotice(result.acknowledged
            ? (result.acknowledgement.replayed ? "Already saved in IOU. No duplicate was added; later form changes were not applied." : "Saved in IOU.")
            : "Saved in IOU, but clearing the pending item was not confirmed. Retrying this same item cannot add a duplicate.");
          if (result.acknowledged) {
            setLoaded(before => before && matches(before.owner)
              ? { ...before, items: before.items.filter(candidate => candidate.id !== item.id) } : before);
          }
          setSelection(undefined); refresh();
        } catch {
          if (matches(captured)) setNotice("Saving was not confirmed. Check this sheet before retrying the same pending entry; do not create another proposal.");
          throw new Error("Saving was not confirmed. Check the sheet and retry only this same pending entry.");
        } finally { working.current = false; if (mounted.current) setBusy(false); }
      },
    };
  }

  function select(item: DurableInboxItem): LocalSheetImport {
    const captured = live.current;
    assertCurrent(captured);
    if (working.current || !items.some(candidate => candidate.id === item.id) || item.error || !item.drafts?.length) {
      throw new Error(item.error || "This pending entry is not ready to review.");
    }
    setSelection({ owner: captured, item });
    return forReview(item, captured);
  }

  return { items, notice, busy, loading, refresh, select, dismiss,
    active: selected ? forReview(selected.item, selected.owner) : undefined };
}
