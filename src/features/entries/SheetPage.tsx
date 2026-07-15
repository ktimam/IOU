// /sheet/:sheetId — the main IOU page.
//
// Loads the sheet, decrypts all entries with K_sheet, shows balance
// cards and the history list. "Add entry" and "edit" both open the
// same form in a modal.

import { useEffect, useMemo, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { unwrap, isActive, useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useAuth } from "../auth/AuthProvider";
import {
  decryptEntryPayload,
  encryptEntryPayload,
  decryptName,
  encryptName,
} from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";
import {
  computeBalances,
  computeBalancesAsOf,
  endOfPrevMonth,
  formatMinor,
  portionsOf,
  orientPayload,
  orientDirection,
  flipDirection,
  type Balance,
} from "./balance";
import { EntryForm } from "./EntryForm";
import { CloseSheetButton } from "./CloseSheetButton";
import { downloadCsv, entriesToCsv } from "./csvExport";
import { useToasts } from "../ui/Toasts";
import { usePreferences } from "../settings/usePreferences";
import { useTemplates } from "../templates/TemplatesContext";
import { TemplatesManager } from "../templates/TemplatesManager";
import { templateToInitial } from "../templates/templateBase";
import { parseDraft, isDuplicateDraft, extractTs } from "./draft";
import {
  getRelayConfig,
  fetchPending,
  deletePending,
  type PendingDraft,
} from "../relay/relay";
import { pollActionInbox, getActionInboxConfig } from "../openchat/actionInboxClient";
import {
  collapseByMessageId,
  parseImportedMessageIds,
  serializeImportedMessageIds,
  deriveDeployTag,
  planScopedInboxKey,
} from "../openchat/inboxDedupe";

// The two inbox dedup sets below (dismissed inbox ids; imported messageIds) persist so a handled
// draft stays gone across refreshes — the inbox is append-only and the poll cursor is in-memory.
// But they are SPECIFIC TO ONE OpenChat deployment: inbox action ids (`oc-<id>`) restart from 1 on
// every clean redeploy, and messageIds come from a specific OpenChat instance. A set carried over
// from an EARLIER deployment would wrongly suppress a fresh deployment's low-/reused-id deposits —
// the "confirmed in OpenChat but never imported after an environment restart" bug. So we SCOPE both
// by the OpenChat user_index canister id, which changes on every clean redeploy: a new deployment
// reads empty sets, and keys from other deployments (and the pre-scoping legacy key) are purged.
function deployTag(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return deriveDeployTag(env?.VITE_OC_USER_INDEX_CANISTER_ID);
  } catch {
    return "default";
  }
}
const DEPLOY_TAG = deployTag();
function scopedInboxKey(prefix: string, legacyKey: string): string {
  try {
    const existing: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) existing.push(k);
    }
    const { keep, remove } = planScopedInboxKey(prefix, DEPLOY_TAG, legacyKey, existing);
    for (const k of remove) localStorage.removeItem(k); // legacy + other-deployment keys
    return keep;
  } catch {
    /* no localStorage in tests/Node */
    return `${prefix}.${DEPLOY_TAG}`;
  }
}
const HANDLED_INBOX_KEY = scopedInboxKey(
  "iou.openchat.handledInboxDrafts.v2",
  "iou.openchat.handledInboxDrafts.v1",
);
const HANDLED_INBOX_CAP = 1000;
function loadHandledInboxIds(): Set<string> {
  try {
    const raw = localStorage.getItem(HANDLED_INBOX_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}
const handledInboxIds = loadHandledInboxIds();
function markInboxDraftHandled(id: string): void {
  handledInboxIds.add(id);
  try {
    localStorage.setItem(
      HANDLED_INBOX_KEY,
      JSON.stringify([...handledInboxIds].slice(-HANDLED_INBOX_CAP)),
    );
  } catch {
    /* best-effort: the in-memory set still applies for this session */
  }
}

// A single chat message can, in a rare double-confirm race, produce two on-chain
// deposits with the SAME context.messageId (different confirmedBy). The draft-id
// guard only catches an ALREADY-WRITTEN entry, so both cards could still be
// accepted before the first entry lands. We dedupe by messageId as well: once a
// messageId has been imported we treat any sibling card as already-added. Persist
// it (same rationale as handledInboxIds) so the guard survives a reload.
const IMPORTED_MSG_KEY = scopedInboxKey(
  "iou.openchat.importedMessageIds.v2",
  "iou.openchat.importedMessageIds.v1",
);
const IMPORTED_MSG_CAP = 1000;
const importedMessageIds = parseImportedMessageIds(
  (() => {
    try {
      return localStorage.getItem(IMPORTED_MSG_KEY);
    } catch {
      return null;
    }
  })(),
);
function markMessageImported(messageId: string): void {
  importedMessageIds.add(messageId);
  try {
    localStorage.setItem(IMPORTED_MSG_KEY, serializeImportedMessageIds(importedMessageIds, IMPORTED_MSG_CAP));
  } catch {
    /* best-effort: the in-memory set still applies for this session */
  }
}
import {
  readCachedLinks,
  writeCachedLinks,
  fetchChatSheetLinks,
  storeChatSheetLink,
  draftBelongsOnSheet,
  type ChatSheetLinks,
} from "../openchat/chatSheetLinks";

// Build entry-form defaults from a template.
// templateToInitial (template → entry defaults, incl. relative-schedule anchoring) is extracted to
// ../templates/templateBase for unit testing; imported above.

// Unwrap a Candid opt<vec nat8> to a Uint8Array (or null).
function optBytes(o: any): Uint8Array | null {
  const v = Array.isArray(o) ? o[0] : o;
  return v == null ? null : new Uint8Array(v);
}

// Per-due display lines for an IOU history row (date + the value due then,
// after any fee). Returns null for settlements.
function dueDisplayLines(
  p: EntryPayload,
): { date: string; value: string }[] | null {
  if (p.txn_type === "settlement") return null;
  return portionsOf(p).map((x) => ({
    date: new Date(x.due_ts).toISOString().slice(0, 10),
    value: formatMinor(x.amount_minor, x.currency),
  }));
}

type EntryHistoryVersion = { payload: EntryPayload; replacedAt: number };

type DecryptedEntry = {
  id: number;
  created_by: string;
  created_at_server: number;
  updated_at_server: number | null;
  payload: EntryPayload;
  deleted: boolean;
  history: EntryHistoryVersion[]; // prior versions, oldest first
};

type SortKey = "newest" | "oldest" | "amount-desc" | "amount-asc";

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "newest", label: "Newest first" },
  { value: "oldest", label: "Oldest first" },
  { value: "amount-desc", label: "Largest amount" },
  { value: "amount-asc", label: "Smallest amount" },
];

export function SheetPage() {
  const { sheetId = "" } = useParams();
  const { state } = useAuth();
  const { actor } = useActor();
  const { get, unwrapFor } = useSheetKey();
  const toasts = useToasts();
  const { prefs, cacheSheetName, cacheAccountName, cachePartnerName } = usePreferences();

  const [sheet, setSheet] = useState<any>(null);
  const [entries, setEntries] = useState<DecryptedEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [modal, setModal] = useState<null | {
    initial: Partial<EntryPayload> | null;
    entryId: number | null;
    // For an EDIT: did the current viewer author this entry? The form shows/edits direction in the
    // viewer's frame; on save we orient back to the author's frame so storage stays author-relative.
    createdByMe?: boolean;
  }>(null);
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const { templates } = useTemplates();
  const [addOpen, setAddOpen] = useState(false);
  const [typesOpen, setTypesOpen] = useState(false);
  const [renamingSheet, setRenamingSheet] = useState(false);
  const [sheetNameDraft, setSheetNameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renamingAccount, setRenamingAccount] = useState(false);
  const [accountNameDraft, setAccountNameDraft] = useState("");
  const [accountRenameBusy, setAccountRenameBusy] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [openHistory, setOpenHistory] = useState<Set<number>>(new Set());
  const toggleHistory = (id: number) =>
    setOpenHistory((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [draftErrors, setDraftErrors] = useState<string[]>([]);
  const openAdd = (initial: Partial<EntryPayload> | null) => {
    setModal({ initial, entryId: null });
    setAddOpen(false);
  };
  // Import an AI-extracted draft (chat bridge, Milestone 0): parse the pasted
  // JSON, dedupe by draft_id, then open the prefilled EntryForm to confirm.
  // Nothing is written until the user confirms in the form (no auto-write).
  // Resolve the template a chat message was routed to (the manifest keyword_map / model sets
  // `raw.template` to the template's NAME — see actionManifest buildTemplateRules) into a defaults
  // baseline, so parseDraft can fill gaps the extraction left. Matched case-insensitively by name,
  // with an id fallback for any older id-based manifest. Unknown/deleted/renamed → no match →
  // undefined → parseDraft behaves as before.
  const resolveTemplateBase = (raw: unknown): Partial<EntryPayload> | undefined => {
    if (raw == null || typeof raw !== "object") return undefined;
    const ref = (raw as { template?: unknown }).template;
    if (typeof ref !== "string" || ref.trim() === "") return undefined;
    const key = ref.trim().toLowerCase();
    const t =
      templates.find((x) => x.name.trim().toLowerCase() === key) ??
      templates.find((x) => x.id === ref);
    // Anchor the template's due schedule at the draft's transaction date (same date the entry gets),
    // so "due in 0 days" lands on the reservation date, not today.
    return t ? templateToInitial(t, extractTs(raw as { note?: unknown; date?: unknown })) : undefined;
  };

  const openFromDraft = () => {
    setDraftErrors([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftText);
    } catch {
      setDraftErrors(["not valid JSON — paste the JSON your assistant produced"]);
      return;
    }
    const res = parseDraft(parsed, resolveTemplateBase(parsed));
    if (!res.ok) {
      setDraftErrors(res.errors);
      return;
    }
    if (isDuplicateDraft(entries, res.value.draftId)) {
      toasts.show({ kind: "info", text: "Already added from this draft" });
      setDraftOpen(false);
      setDraftText("");
      return;
    }
    setDraftOpen(false);
    setDraftText("");
    openAdd(res.value.initial);
  };

  // "Pending from chat": drafts the chat connector pushed to the key-blind relay.
  // We poll, show them, and import each through the same confirm seam; on a
  // successful write we clear it from the relay. The relay never holds K_sheet.
  const [pending, setPending] = useState<PendingDraft[]>([]);
  const [inboxPending, setInboxPending] = useState<PendingDraft[]>([]);
  const [pendingRelayId, setPendingRelayId] = useState<string | null>(null);
  // messageId of the draft under review (openchat v2 wrapper only) — recorded on
  // a successful write so a sibling double-confirm card can't be imported twice.
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  // Chat → sheet mapping (delivery provenance): canister-backed, cache-first.
  const [chatLinks, setChatLinks] = useState<ChatSheetLinks>(() => readCachedLinks());
  // The chat key of the draft currently being reviewed (openchat drafts only),
  // and whether "remember this chat → this sheet" is ticked (default on).
  const [pendingChatKey, setPendingChatKey] = useState<string | null>(null);
  const [rememberChat, setRememberChat] = useState(true);
  const reloadPending = async () => {
    const cfg = getRelayConfig();
    if (!cfg) {
      setPending([]);
      return;
    }
    try {
      setPending(await fetchPending(cfg));
    } catch {
      /* relay unreachable — leave the inbox as-is */
    }
  };
  const clearRelay = async (id: string) => {
    if (id.startsWith("oc-")) {
      // On-chain inbox actions are append-only; drop it from the local pending view and remember
      // it as handled so it does not reappear on the next refresh/poll.
      markInboxDraftHandled(id);
      setInboxPending((prev) => prev.filter((p) => p.id !== id));
      return;
    }
    const cfg = getRelayConfig();
    if (cfg) {
      try {
        await deletePending(cfg, id);
      } catch {
        /* ignore */
      }
    }
    await reloadPending();
  };
  const closeEntryModal = () => {
    setModal(null);
    setPendingRelayId(null);
    setPendingChatKey(null);
    setPendingMessageId(null);
  };
  const importFromRelay = (p: PendingDraft) => {
    const res = parseDraft(p.draft, resolveTemplateBase(p.draft));
    if (!res.ok) {
      toasts.show({ kind: "error", text: "Invalid draft from chat: " + res.errors.join("; ") });
      return;
    }
    // Idempotency: a chat draft carries a UNIQUE messageId per card, so that is the reliable dedup
    // key — key off it and do NOT also content-dedup. Two legitimately-distinct entries can share
    // amount/currency/date/note (two same-price bookings, or repeated same-day drafts before the
    // date is parsed), which the content hash (draftId) would wrongly flag as "already added" and
    // permanently suppress WITHOUT importing. Fall back to the content hash only for wrapper-less
    // pastes that have no messageId.
    const mid = p.context?.messageId;
    const alreadyAdded = mid
      ? importedMessageIds.has(mid)
      : isDuplicateDraft(entries, res.value.draftId);
    if (alreadyAdded) {
      toasts.show({ kind: "info", text: "Already added — clearing it from chat" });
      void clearRelay(p.id);
      return;
    }
    setPendingRelayId(p.id);
    // Track the source chat so confirming can remember chat → sheet.
    setPendingChatKey(p.context?.chat ?? null);
    setPendingMessageId(mid ?? null);
    setRememberChat(true);
    openAdd(res.value.initial);
  };
  // Persist a chat → sheet mapping: optimistic (state + cache first), then the
  // canister call; on failure roll back and let the next fetch re-sync.
  const rememberChatMapping = (chatKey: string) => {
    const prev = chatLinks;
    const next = { ...prev, [chatKey]: sheetId };
    setChatLinks(next);
    writeCachedLinks(next);
    if (!actor) return;
    void storeChatSheetLink(actor, chatKey, sheetId).catch(() => {
      setChatLinks(prev);
      writeCachedLinks(prev);
      toasts.show({ kind: "error", text: "Could not save the chat → sheet mapping" });
    });
  };
  useEffect(() => {
    const cfg = getRelayConfig();
    if (!cfg) return;
    let cancelled = false;
    const load = async () => {
      try {
        const p = await fetchPending(cfg);
        if (!cancelled) setPending(p);
      } catch {
        /* relay down */
      }
    };
    void load();
    const iv = setInterval(() => void load(), 15000);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh the chat → sheet links from the canister (cache-first: state is
  // seeded from localStorage above, the canister copy wins when it arrives).
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    void fetchChatSheetLinks(actor)
      .then((links) => {
        if (!cancelled) setChatLinks(links);
      })
      .catch(() => {
        /* canister unreachable — keep the cached copy */
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor]);

  // "Pending from OpenChat": confirmed actions OpenChat deposited on-chain. We pull them from the action_inbox
  // canister, verify OpenChat's provenance signature + decrypt locally, then feed each through the same seam.
  useEffect(() => {
    let cancelled = false;
    let iv: ReturnType<typeof setInterval> | undefined;
    // The inbox canister id is auto-derived from OpenChat's registered manifest (getActionInboxConfig
    // is async), so the fetch + null-guard live inside this IIFE; the effect callback stays sync.
    void (async () => {
      const cfg = await getActionInboxConfig();
      if (cancelled || !cfg) return;
      let since = 0n;
      const load = async () => {
        try {
          const drafts = await pollActionInbox({ config: cfg, sinceId: since });
          if (cancelled || drafts.length === 0) return;
          for (const d of drafts) if (d.id >= since) since = d.id + 1n;
          setInboxPending((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const add: PendingDraft[] = drafts
              .filter((d) => !seen.has(`oc-${d.id}`) && !handledInboxIds.has(`oc-${d.id}`))
              .map((d) => ({
                id: `oc-${d.id}`,
                draft: d.draft,
                // action_inbox stores TimestampMillis — no nanosecond conversion.
                created_at: Number(d.created_at),
                source: "openchat",
                // Real delivery provenance from the v2 envelope wrapper; older
                // wrapper-less deposits have no context and keep the fallback.
                provenance: { openchat_user: d.context?.confirmedBy ?? "action-inbox" },
                ...(d.context ? { context: d.context } : {}),
              }));
            return add.length ? [...prev, ...add] : prev;
          });
        } catch {
          /* inbox unreachable — leave as-is */
        }
      };
      await load();
      if (cancelled) return;
      iv = setInterval(() => void load(), 15000);
    })();
    return () => {
      cancelled = true;
      if (iv) clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const myPrincipal = state.kind === "authenticated"
    ? state.identity.getPrincipal().toText()
    : "";
  // member_a/member_b are Principal objects (Candid), not strings. Treating
  // them as strings — comparing with === and calling .slice() — threw
  // "them.slice is not a function" and blanked the whole page (no error
  // boundary). Convert to text before any string use.
  const principalText = (p: any): string =>
    p && typeof p.toText === "function" ? p.toText() : String(p ?? "");
  const memberAText = sheet ? principalText(sheet.member_a) : "";
  const memberBText = sheet ? principalText(sheet.member_b) : "";
  const partnerPrincipal =
    memberAText === myPrincipal ? memberBText : memberAText;

  async function reload() {
    if (!actor || !sheetId) return;
    setLoading(true);
    setErr(null);
    try {
      const sh = unwrap(await (actor as any).get_sheet(sheetId));
      if (!sh) {
        setErr("sheet not found");
        setSheet(null);
        return;
      }
      setSheet(sh);
      const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
      // Decrypt names (best-effort) and cache the plaintext locally so the
      // accounts list / headers render instantly. Names are E2E-encrypted
      // under K_sheet; failures are non-fatal (fall back to principals).
      try {
        const senc = optBytes(sh.name_enc);
        const siv = optBytes(sh.name_iv);
        if (senc && siv) {
          const nm = await decryptName(K_sheet, siv, senc);
          if (nm) cacheSheetName(sheetId, nm);
        }
        const pr = unwrap(await (actor as any).get_pair(sh.pair_id));
        if (pr) {
          const aenc = optBytes(pr.name_enc);
          const aiv = optBytes(pr.name_iv);
          if (aenc && aiv) {
            const an = await decryptName(K_sheet, aiv, aenc);
            if (an) cacheAccountName(sh.pair_id, an);
          }
          const meIsA = principalText(pr.members[0]) === myPrincipal;
          const penc = optBytes(meIsA ? pr.member_b_name_enc : pr.member_a_name_enc);
          const piv = optBytes(meIsA ? pr.member_b_name_iv : pr.member_a_name_iv);
          if (penc && piv) {
            const pn = await decryptName(K_sheet, piv, penc);
            if (pn) cachePartnerName(sh.pair_id, pn);
          }
          // Publish my profile name on this account if it isn't set yet, so
          // my partner sees it. One-time per account (skip once present).
          const myEnc = optBytes(meIsA ? pr.member_a_name_enc : pr.member_b_name_enc);
          if (!myEnc && prefs.profileName.trim()) {
            const { enc, iv } = await encryptName(K_sheet, prefs.profileName.trim());
            await (actor as any).set_member_name(sh.pair_id, enc, iv);
          }
        }
      } catch {
        /* names are best-effort */
      }
      const res = await (actor as any).list_entries(sheetId, [], 200);
      const dec: DecryptedEntry[] = [];
      for (const e of res.entries) {
        const pt = await decryptEntryPayload(
          new Uint8Array(e.entry_key),
          new Uint8Array(e.iv),
          new Uint8Array(e.ciphertext),
          K_sheet,
        );
        // Decrypt prior versions (edit history), oldest first.
        const versions: any[] = e.history && e.history.length ? e.history[0] : [];
        const history: EntryHistoryVersion[] = [];
        for (const v of versions) {
          try {
            const vpt = await decryptEntryPayload(
              new Uint8Array(v.entry_key),
              new Uint8Array(v.iv),
              new Uint8Array(v.ciphertext),
              K_sheet,
            );
            history.push({ payload: decodeEntry(vpt), replacedAt: Number(v.replaced_at) });
          } catch {
            /* skip an undecryptable version */
          }
        }
        dec.push({
          id: Number(e.id),
          created_by: e.created_by.toText(),
          created_at_server: Number(e.created_at_server),
          updated_at_server: e.updated_at_server && e.updated_at_server.length
            ? Number(e.updated_at_server[0])
            : null,
          payload: decodeEntry(pt),
          deleted: !!(e.deleted_at && e.deleted_at.length),
          history,
        });
      }
      setEntries(dec);
    } catch (e) {
      setErr((e as Error).message);
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, sheetId]);

  const sorted = useMemo(() => {
    const arr = entries.filter((e) => showDeleted || !e.deleted);
    switch (sortKey) {
      case "newest":
        return arr.sort((a, b) => b.payload.ts - a.payload.ts);
      case "oldest":
        return arr.sort((a, b) => a.payload.ts - b.payload.ts);
      case "amount-desc":
        return arr.sort(
          (a, b) => b.payload.amount_minor - a.payload.amount_minor,
        );
      case "amount-asc":
        return arr.sort(
          (a, b) => a.payload.amount_minor - b.payload.amount_minor,
        );
    }
  }, [entries, sortKey, showDeleted]);

  async function onSubmit(p: EntryPayload) {
    if (!actor) return;
    // Direction is stored in the entry author's frame. The form works in the viewer's frame, so when
    // editing a PARTNER's entry (createdByMe === false), orient back before storing. Adds are always
    // authored by me → my frame IS the author frame → no change.
    const toStore: EntryPayload =
      modal?.createdByMe === false ? { ...p, direction: flipDirection(p.direction) } : p;
    const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
    const enc = await encryptEntryPayload(
      new TextEncoder().encode(JSON.stringify(toStore)),
      K_sheet,
    );
    if (modal?.entryId != null) {
      await (actor as any).edit_entry({
        sheet_id: sheetId,
        entry_id: BigInt(modal.entryId),
        entry_key: Array.from(enc.entryKey),
        ciphertext: Array.from(enc.ciphertext),
        iv: Array.from(enc.iv),
      });
      toasts.show({ kind: "success", text: "Entry updated" });
    } else {
      await (actor as any).add_entry({
        sheet_id: sheetId,
        entry_key: Array.from(enc.entryKey),
        ciphertext: Array.from(enc.ciphertext),
        iv: Array.from(enc.iv),
      });
      toasts.show({ kind: "success", text: "Entry added" });
      if (pendingRelayId) await clearRelay(pendingRelayId);
      // Remember this messageId so a sibling double-confirm card is caught by
      // the accept-path guard even before the new entry is re-fetched.
      if (pendingMessageId) markMessageImported(pendingMessageId);
      // First import from a chat that isn't mapped yet: honour the
      // "remember" checkbox (default on) by pinning chat → this sheet.
      if (pendingRelayId && pendingChatKey && rememberChat && !chatLinks[pendingChatKey]) {
        rememberChatMapping(pendingChatKey);
      }
    }
    setPendingRelayId(null);
    setPendingChatKey(null);
    setPendingMessageId(null);
    setModal(null);
    await reload();
  }

  async function onDelete(entryId: number) {
    if (!actor) return;
    try {
      await (actor as any).delete_entry(sheetId, BigInt(entryId));
      toasts.show({ kind: "success", text: "Entry deleted" });
      await reload();
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    }
  }

  async function onRestore(entryId: number) {
    if (!actor) return;
    try {
      await (actor as any).restore_entry(sheetId, BigInt(entryId));
      toasts.show({ kind: "success", text: "Entry restored" });
      await reload();
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    }
  }

  function onExportCsv() {
    // Export only live (non-deleted) entries.
    const live = entries.filter((e) => !e.deleted);
    if (live.length === 0) return;
    const me = state.kind === "authenticated"
      ? state.identity.getPrincipal().toText()
      : "";
    const rows = live.map((e) => ({
      payload: e.payload,
      created_by_me: e.created_by === me,
      edited: e.updated_at_server != null,
    }));
    const csv = entriesToCsv(rows);
    const date = new Date().toISOString().slice(0, 10);
    const filename = `iou-${sheetId.slice(0, 8)}-${date}.csv`;
    try {
      downloadCsv(filename, csv);
      toasts.show({ kind: "success", text: `Exported ${rows.length} entries` });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    }
  }

  async function saveAccountName() {
    if (!actor || !sheet) return;
    setAccountRenameBusy(true);
    try {
      const K = get(sheetId) ?? (await unwrapFor(sheetId));
      const { enc, iv } = await encryptName(K, accountNameDraft.trim());
      await (actor as any).set_pair_name(sheet.pair_id, enc, iv);
      cacheAccountName(sheet.pair_id, accountNameDraft.trim());
      setRenamingAccount(false);
      toasts.show({ kind: "success", text: "Account renamed" });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setAccountRenameBusy(false);
    }
  }

  async function saveSheetName() {
    if (!actor) return;
    setRenameBusy(true);
    try {
      const K = get(sheetId) ?? (await unwrapFor(sheetId));
      const { enc, iv } = await encryptName(K, sheetNameDraft.trim());
      await (actor as any).set_sheet_name(sheetId, enc, iv);
      cacheSheetName(sheetId, sheetNameDraft.trim());
      setRenamingSheet(false);
      toasts.show({ kind: "success", text: "Sheet renamed" });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setRenameBusy(false);
    }
  }

  if (!state.kind || state.kind !== "authenticated") {
    return <p>Please sign in.</p>;
  }
  if (loading && !sheet) return <p>Loading…</p>;
  if (err) return <p className="err">{err}</p>;
  if (!sheet) return <p>Not found.</p>;

  // Balances ignore deleted entries. Direction is stored in the AUTHOR's frame ("credit" = the OTHER
  // member owes the author), so orient each entry to the CURRENT viewer — otherwise both members see
  // the same sign and each thinks the other owes them. A partner sees the mirror of what was entered.
  const payloads = entries
    .filter((e) => !e.deleted)
    .map((e) => orientPayload(e.payload, e.created_by === myPrincipal));
  const overall = computeBalances(payloads);
  const thisMonth = computeBalancesAsOf(payloads, Date.now());
  const prevMonth = computeBalancesAsOf(payloads, endOfPrevMonth(Date.now()));
  const me = myPrincipal;
  const them = partnerPrincipal;
  // Solo sheet: partner slot is the anonymous principal until a partner
  // joins and is granted access. Show friendly copy instead of "2vxsx…".
  const ANON = "2vxsx-fae";
  const isSolo = them === "" || them === ANON;
  const pairId: string = sheet.pair_id;
  const partnerName = prefs.partnerNames[pairId] || "";
  const sheetName = prefs.sheetNames[sheetId] || "";
  // Counterparty label: decrypted name if known, else solo copy, else a
  // shortened principal.
  const themShort = partnerName || (isSolo ? "your partner" : `${them.slice(0, 5)}…`);
  const buckets: { label: string; hint: string; list: Balance[] }[] = [
    { label: "This month", hint: "due so far", list: thisMonth },
    { label: "Previous month", hint: "due by end of last month", list: prevMonth },
    { label: "Overall", hint: "incl. upcoming", list: overall },
  ];
  // Inbox drafts whose source chat is pinned to a DIFFERENT sheet are hidden
  // here — they show up on their mapped sheet's page instead. Drafts without
  // context (wrapper-less deposits) and unmapped chats stay visible.
  //
  // A double-confirm race can surface two cards for the same messageId; collapse
  // them by keeping the first (earliest — poll appends in order). Drafts with no
  // messageId (wrapper-less) are never collapsed — each undefined stays distinct.
  const visibleInbox = collapseByMessageId(
    inboxPending.filter((p) => draftBelongsOnSheet(p.context?.chat, chatLinks, sheetId)),
  );
  // The draft under review came from a chat with no mapping yet → offer to
  // remember the chat → sheet link on confirm.
  const showRememberChat = pendingRelayId != null && !!pendingChatKey && !chatLinks[pendingChatKey];

  return (
    <div className="sheet-page">
      <header>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <Link to="/pairs">← Accounts</Link>
          <Link to={`/pair/${pairId}`} className="muted small">
            Details →
          </Link>
        </div>
        {renamingAccount ? (
          <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 4 }}>
            <span className="muted small">Account:</span>
            <input
              value={accountNameDraft}
              onChange={(e) => setAccountNameDraft(e.target.value)}
              maxLength={48}
              placeholder="Account name"
              autoFocus
            />
            <button
              className="small"
              onClick={() => void saveAccountName()}
              disabled={accountRenameBusy || !accountNameDraft.trim()}
            >
              {accountRenameBusy ? "Saving…" : "Save"}
            </button>
            <button
              className="secondary small"
              onClick={() => setRenamingAccount(false)}
              disabled={accountRenameBusy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, alignItems: "center", marginTop: 4 }}>
            <span className="muted small">
              Account: {prefs.accountNames[pairId] || "(unnamed)"}
            </span>
            <button
              className="secondary small"
              onClick={() => {
                setAccountNameDraft(prefs.accountNames[pairId] ?? "");
                setRenamingAccount(true);
              }}
            >
              Rename
            </button>
          </div>
        )}
        {renamingSheet ? (
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <input
              value={sheetNameDraft}
              onChange={(e) => setSheetNameDraft(e.target.value)}
              maxLength={48}
              placeholder="Sheet name"
              autoFocus
            />
            <button
              className="small"
              onClick={() => void saveSheetName()}
              disabled={renameBusy || !sheetNameDraft.trim()}
            >
              {renameBusy ? "Saving…" : "Save"}
            </button>
            <button
              className="secondary small"
              onClick={() => setRenamingSheet(false)}
              disabled={renameBusy}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <h1 style={{ margin: 0 }}>
              {sheetName || `Sheet ${sheet.id.slice(0, 8)}…`}
            </h1>
            <button
              className="secondary small"
              onClick={() => {
                setSheetNameDraft(sheetName);
                setRenamingSheet(true);
              }}
            >
              Rename sheet
            </button>
          </div>
        )}
        <p className="muted small">
          {isSolo && !partnerName ? (
            "Solo sheet"
          ) : (
            <>with {partnerName ? partnerName : <code>{them.slice(0, 8)}…</code>}</>
          )}{" "}
          · {isActive(sheet.state) ? "Active" : "Closed"} ·{" "}
          {sheet.enabled_currencies.join(", ")}
        </p>
      </header>

      <section className="balances">
        <h2>Balances</h2>
        {overall.length === 0 ? (
          <p className="muted">
            🎉 All settled. Add an entry to get started.
          </p>
        ) : (
          <div className="balance-buckets">
            {buckets.map((bk) => (
              <div key={bk.label} className="card" style={{ padding: 12 }}>
                <div className="muted small">
                  {bk.label} <span style={{ opacity: 0.6 }}>· {bk.hint}</span>
                </div>
                {bk.list.length === 0 ? (
                  <p className="muted small">All settled.</p>
                ) : (
                  <ul>
                    {bk.list.map((b) => {
                      const iOweThem = b.amount_minor < 0;
                      return (
                        <li key={b.currency}>
                          <strong>
                            {iOweThem
                              ? `You owe ${themShort}`
                              : `${themShort} owes you`}
                          </strong>{" "}
                          <span
                            className={`amt ${iOweThem ? "amt-debt" : "amt-credit"}`}
                          >
                            {formatMinor(Math.abs(b.amount_minor), b.currency)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {!modal && isActive(sheet.state) && pending.length + visibleInbox.length > 0 && (
        <section className="card" style={{ marginBottom: 12 }}>
          <h2 style={{ marginTop: 0 }}>✨ Pending from chat ({pending.length + visibleInbox.length})</h2>
          <p className="muted small" style={{ marginTop: 0 }}>
            Drafts your AI assistant sent. Review each before it's saved — nothing is
            written until you confirm.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {[...pending, ...visibleInbox].map((p) => {
              const r = parseDraft(p.draft, resolveTemplateBase(p.draft));
              return (
                <li
                  key={p.id}
                  className="row"
                  style={{ justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0" }}
                >
                  <span className="small">
                    {p.source === "openchat" && (
                      <span
                        className="lock-cue"
                        title={
                          p.context
                            ? `Confirmed by ${p.context.confirmedBy} in ${p.context.chat} (message ${p.context.messageId})`
                            : `Forwarded by OpenChat user ${p.provenance?.openchat_user ?? "?"}`
                        }
                        style={{ marginRight: 6 }}
                      >
                        ✦ OpenChat
                        {p.context && (
                          <span className="muted" style={{ marginLeft: 4 }}>
                            · {p.context.chat}
                          </span>
                        )}
                      </span>
                    )}
                    {r.ok ? r.value.summary : "⚠ invalid draft"}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button className="secondary small" onClick={() => importFromRelay(p)}>
                      Review &amp; add
                    </button>
                    <button
                      className="secondary small"
                      onClick={() => void clearRelay(p.id)}
                      title="Dismiss without adding"
                    >
                      ✕
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <div className="row">
        {isActive(sheet.state) && !modal && (
          <>
            {templates.length > 0 ? (
              <div style={{ position: "relative", display: "inline-block" }}>
                <button onClick={() => setAddOpen((o) => !o)}>+ Add ▾</button>
                {addOpen && (
                  <div
                    className="card"
                    style={{
                      position: "absolute",
                      zIndex: 10,
                      marginTop: 4,
                      padding: 8,
                      minWidth: 200,
                    }}
                  >
                    <button
                      className="secondary"
                      style={{ display: "block", width: "100%", marginBottom: 6 }}
                      onClick={() => openAdd(null)}
                    >
                      Blank entry
                    </button>
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        className="secondary"
                        style={{ display: "block", width: "100%", marginBottom: 6 }}
                        onClick={() => openAdd(templateToInitial(t))}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <button onClick={() => openAdd(null)}>+ Add entry</button>
            )}
            <button
              className="secondary"
              onClick={() => {
                setDraftErrors([]);
                setDraftText("");
                setAddOpen(false);
                setDraftOpen(true);
              }}
              title="Import an entry your AI assistant extracted from a screenshot"
            >
              ✨ Import
            </button>
            <CloseSheetButton
              sheetId={sheet.id}
              pairId={pairId}
              currencies={sheet.enabled_currencies}
              closingDays={Number(sheet.closing_window_days)}
              // Pass VIEWER-ORIENTED payloads (same as the displayed balances): the closing
              // user authors the carry-forward entries, so the outstanding balance — and thus
              // the debt/credit direction carried forward — must be in the closer's frame.
              // Passing raw author-relative payloads inverts the sign for partner-authored
              // entries (carry-forward would flip who owes whom).
              entries={payloads}
            />
          </>
        )}
        {entries.length > 0 && (
          <button
            className="secondary"
            onClick={() => onExportCsv()}
            title="Download as CSV for Google Sheets"
          >
            ⤓ Export CSV
          </button>
        )}
        {!modal && (
          <button
            className="secondary"
            onClick={() => setTypesOpen(true)}
            title="Create or edit reusable transaction types"
          >
            Add type
          </button>
        )}
      </div>

      <section className="history">
        <div className="history-head">
          <h2>History</h2>
          <div className="row" style={{ gap: 12, alignItems: "center" }}>
            {entries.some((e) => e.deleted) && (
              <label className="row" style={{ gap: 4, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={showDeleted}
                  onChange={(e) => setShowDeleted(e.target.checked)}
                />
                <span className="muted small">
                  Show deleted ({entries.filter((e) => e.deleted).length})
                </span>
              </label>
            )}
            {entries.length > 1 && (
              <label className="sort">
                <span className="muted small">Sort:</span>
                <select
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                >
                  {SORT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
        {entries.length === 0 ? (
          <p className="muted">📝 No entries yet. Add one above.</p>
        ) : (
          <ul>
            {sorted.map((e) => {
              const mine = e.created_by === me;
              // Orient the stored (author-relative) direction to this viewer for display.
              const dir = orientDirection(e.payload.direction, mine);
              const sign = dir === "credit" ? "+" : "−";
              return (
                <li key={e.id}>
                  <div
                    style={
                      e.deleted
                        ? {
                            textDecoration: "line-through",
                            color: "var(--debt)",
                            opacity: 0.6,
                          }
                        : undefined
                    }
                  >
                    <div className="row-1">
                      <strong>{e.payload.note || "(no note)"}</strong>
                      <span className="muted small">
                        {" · "}
                        {new Date(e.payload.ts).toISOString().slice(0, 10)}
                        {" · "}
                        {mine ? "you" : themShort}
                        {" · "}
                        {dir === "credit" ? "Credit" : "Debit"}
                        {" · "}
                        {e.payload.txn_type === "settlement" ? "settlement" : "IOU"}
                        {e.history.length > 0 ? ` · edited ${e.history.length}×` : ""}
                      </span>
                    </div>
                    <div
                      className={
                        "row-2" +
                        (e.deleted
                          ? ""
                          : dir === "credit"
                            ? " amt-credit"
                            : " amt-debt")
                      }
                    >
                      {sign}
                      {formatMinor(e.payload.amount_minor, e.payload.currency)}
                    </div>
                    {e.payload.fee &&
                      (() => {
                        const f = e.payload.fee;
                        const cur = e.payload.currency;
                        const fx = f.fixed_minor ?? 0;
                        // A foreign fixed fee is its OWN currency line — it doesn't reduce the entry
                        // net (only the percent does), so show it as a separate note, not in the chain.
                        const foreign = fx > 0 && !!f.fixed_currency && f.fixed_currency !== cur;
                        const gross = formatMinor(f.gross_amount_minor, cur);
                        const pct = f.percent > 0 ? ` − ${f.percent}%` : "";
                        const net = formatMinor(e.payload.amount_minor, cur);
                        return (
                          <div className="muted small">
                            {foreign
                              ? `${gross}${pct} → net ${net} (+ ${formatMinor(fx, f.fixed_currency!)} fee)`
                              : `${gross}${pct}${fx > 0 ? ` − ${formatMinor(fx, cur)}` : ""} fee → net ${net}`}
                          </div>
                        );
                      })()}
                    {(() => {
                      const lines = dueDisplayLines(e.payload);
                      if (!lines) return null;
                      if (lines.length === 1) {
                        return (
                          <div className="muted small">due {lines[0].date}</div>
                        );
                      }
                      return (
                        <div className="muted small">
                          {lines.map((l, i) => (
                            <div key={i}>
                              due {l.date}: {l.value}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                    {e.payload.convert && (
                      <div className="muted small">
                        from {e.payload.convert.from_amount_minor / 100}{" "}
                        {e.payload.convert.from_currency} @{" "}
                        {e.payload.convert.rate.toFixed(4)} (
                        {e.payload.convert.rate_source})
                      </div>
                    )}
                  </div>

                  <div className="row" style={{ gap: 10, alignItems: "center", marginTop: 4 }}>
                    {e.deleted ? (
                      <>
                        <span className="muted small" style={{ color: "var(--debt)" }}>
                          deleted
                        </span>
                        {mine && isActive(sheet.state) && (
                          <button className="small secondary" onClick={() => void onRestore(e.id)}>
                            restore
                          </button>
                        )}
                      </>
                    ) : (
                      mine &&
                      isActive(sheet.state) && (
                        <>
                          <button
                            className="small"
                            onClick={() =>
                              setModal({
                                // Show the entry in the viewer's frame (orient the stored author-relative direction).
                                initial: orientPayload(e.payload, e.created_by === me),
                                entryId: e.id,
                                createdByMe: e.created_by === me,
                              })
                            }
                          >
                            edit
                          </button>
                          <button className="small secondary" onClick={() => void onDelete(e.id)}>
                            delete
                          </button>
                        </>
                      )
                    )}
                    {e.history.length > 0 && (
                      <button className="small secondary" onClick={() => toggleHistory(e.id)}>
                        {openHistory.has(e.id) ? "hide history" : "history"}
                      </button>
                    )}
                  </div>

                  {openHistory.has(e.id) && e.history.length > 0 && (
                    <div
                      className="muted small"
                      style={{ marginTop: 4, paddingLeft: 8, borderLeft: "2px solid var(--debt)" }}
                    >
                      {e.history.map((v, i) => (
                        <div key={i}>
                          changed {new Date(v.replacedAt / 1_000_000).toISOString().slice(0, 10)} — was:{" "}
                          {v.payload.note || "(no note)"} ·{" "}
                          {orientDirection(v.payload.direction, mine) === "credit" ? "+" : "−"}
                          {formatMinor(v.payload.amount_minor, v.payload.currency)}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {modal && (
        <div className="modal-backdrop" onClick={closeEntryModal}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>{modal.entryId != null ? "Edit entry" : "Add entry"}</h3>
            {showRememberChat && (
              <label
                className="row muted small"
                style={{ gap: 6, alignItems: "center", marginBottom: 8 }}
                title={`Future drafts confirmed in ${pendingChatKey} will be offered on this sheet only`}
              >
                <input
                  type="checkbox"
                  checked={rememberChat}
                  onChange={(e) => setRememberChat(e.target.checked)}
                />
                <span>Remember: always import this chat's drafts into this sheet</span>
              </label>
            )}
            <EntryForm
              enabledCurrencies={sheet.enabled_currencies}
              myPrincipal={me}
              partnerPrincipal={them}
              initial={modal.initial ?? undefined}
              isEdit={modal.entryId != null}
              onCancel={closeEntryModal}
              onSubmit={onSubmit}
            />
          </div>
        </div>
      )}

      {typesOpen && (
        <div className="modal-backdrop" onClick={() => setTypesOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{ maxHeight: "85vh", overflowY: "auto" }}
          >
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="secondary small" onClick={() => setTypesOpen(false)}>
                Close
              </button>
            </div>
            <TemplatesManager onSaved={() => setTypesOpen(false)} />
          </div>
        </div>
      )}

      {draftOpen && (
        <div className="modal-backdrop" onClick={() => setDraftOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>Import</h3>
            <p className="muted small">
              Paste the JSON your assistant produced from the screenshot. You'll
              review and confirm every field before anything is saved — nothing is
              written automatically.
            </p>
            <textarea
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={
                '{\n  "kind": "settlement",\n  "amount": 25.00,\n  "currency": "USD",\n  "direction": "credit",\n  "date": "2026-06-20",\n  "counterparty": "Sam",\n  "note": "lunch"\n}'
              }
              style={{ width: "100%", fontFamily: "monospace", fontSize: 13 }}
            />
            {draftErrors.length > 0 && (
              <ul className="err" style={{ marginTop: 8 }}>
                {draftErrors.map((er, i) => (
                  <li key={i}>{er}</li>
                ))}
              </ul>
            )}
            <div className="actions" style={{ marginTop: 8 }}>
              <button type="button" onClick={() => setDraftOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={openFromDraft}
                disabled={!draftText.trim()}
              >
                Review in form
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
