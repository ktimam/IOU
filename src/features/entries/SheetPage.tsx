// /sheet/:sheetId — the main IOU page.
//
// Loads the sheet, decrypts all entries with K_sheet, shows balance
// cards and the history list. "Add entry" and "edit" both open the
// same form in a modal.

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { unwrap, isActive, useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { useAuth } from "../auth/AuthProvider";
import {
  encryptEntryPayload,
  decryptName,
  encryptName,
} from "../crypto/devVetkd";
import type { EntryPayload } from "./types";
import { decryptEntryRecords, type DecryptedEntry } from "./decryptEntries";
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
import { buildInviteLink } from "../flows/inviteLink";
import { isProdVetkd } from "../crypto/devVetkd";
import { usePreferences } from "../settings/usePreferences";
import { usePairTemplates } from "../templates/PairTemplatesContext";
import { TemplatesManager } from "../templates/TemplatesManager";
import { templateToInitial } from "../templates/templateBase";
import {
  resolveTemplateBase as resolveTemplateBaseFor,
  templateEvidenceForImport,
} from "./resolveTemplateBase";
import {
  parseDraft,
  isDuplicateDraft,
  baseWithDefaultCurrency,
  parseDraftBatch,
  parsedToPayload,
  batchSummary,
  type ParsedDraft,
  type DraftBaseResolverContext,
} from "./draft";
import { BatchConfirmModal } from "./BatchConfirmModal";
import {
  addEntryBatch,
  batchImportContextMatches,
  finalizeAcceptedChatImport,
  type BatchImportContext,
} from "./batchImport";
import {
  getRelayConfig,
  fetchPending,
  deletePending,
  type PendingDraft,
} from "../relay/relay";
import {
  acknowledgeActionInbox,
  pollActionInbox,
  getActionInboxConfig,
} from "../openchat/actionInboxClient";
import {
  InboxAcknowledgementQueue,
  isDurablyHandledInboxMessage,
} from "../openchat/actionInboxAcknowledgement";
import {
  parseImportedMessageIds,
  serializeImportedMessageIds,
  deriveDeployTag,
  inboxDedupeStorageKey,
  isImportedIntoSheet,
  planObsoleteInboxStorageCleanup,
} from "../openchat/inboxDedupe";
import { visibleInboxFor } from "../openchat/inboxFilter";
import {
  restoreOpenChatTemplateRefs,
} from "../openchat/templateRefImport";

// The two inbox dedup sets below (signed delivery identities; imported messageIds) persist so a
// handled draft stays gone across refreshes. They remain specific to one OpenChat deployment, so
// both stores are scoped by UserIndex. Recreated local deployments start empty and obsolete scopes
// are purged without ever trusting the ActionInbox query's numeric storage id as an identity.
function deployTag(): string {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string> }).env;
    return deriveDeployTag(env?.VITE_OC_USER_INDEX_CANISTER_ID);
  } catch {
    return "default";
  }
}
const DEPLOY_TAG = deployTag();
const HANDLED_INBOX_CAP = 1000;

// A single chat message can, in a rare double-confirm race, produce two on-chain
// deposits with the SAME context.messageId (different confirmedBy). The draft-id
// guard only catches an ALREADY-WRITTEN entry, so both cards could still be
// accepted before the first entry lands. We dedupe by messageId as well: once a
// messageId has been imported we treat any sibling card as already-added. Persist
// it (same rationale as handledInboxIds) so the guard survives a reload.
const IMPORTED_MSG_CAP = 1000;

type ScopedInboxState = {
  handledKey: string | null;
  importedKey: string | null;
  handledInboxIds: Set<string>;
  importedMessageIds: Set<string>;
};
const inboxStateByScope = new Map<string, ScopedInboxState>();

function loadScopedInboxState(principal: string | null): ScopedInboxState {
  if (!principal) {
    return {
      handledKey: null,
      importedKey: null,
      handledInboxIds: new Set(),
      importedMessageIds: new Set(),
    };
  }
  const handledKey = inboxDedupeStorageKey(
    "iou.openchat.handledInboxDrafts.v3",
    principal,
    DEPLOY_TAG,
  );
  const importedKey = inboxDedupeStorageKey(
    "iou.openchat.importedMessageIds.v3",
    principal,
    DEPLOY_TAG,
  );
  const existing = inboxStateByScope.get(handledKey);
  if (existing) return existing;
  let handledRaw: string | null = null;
  let importedRaw: string | null = null;
  try {
    handledRaw = localStorage.getItem(handledKey);
    importedRaw = localStorage.getItem(importedKey);
    function* existingStorageKeys(): Generator<string> {
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index);
        if (key !== null) yield key;
      }
    }
    for (const obsolete of planObsoleteInboxStorageCleanup(existingStorageKeys())) {
      localStorage.removeItem(obsolete);
    }
  } catch {
    /* storage-denied contexts retain only the scoped in-memory sets */
  }
  const state: ScopedInboxState = {
    handledKey,
    importedKey,
    handledInboxIds: parseImportedMessageIds(handledRaw),
    importedMessageIds: parseImportedMessageIds(importedRaw),
  };
  inboxStateByScope.set(handledKey, state);
  return state;
}

function markScopedInboxHandled(state: ScopedInboxState, id: string): void {
  state.handledInboxIds.add(id);
  if (!state.handledKey) return;
  try {
    localStorage.setItem(
      state.handledKey,
      serializeImportedMessageIds(state.handledInboxIds, HANDLED_INBOX_CAP),
    );
  } catch {
    /* in-memory isolation still applies */
  }
}

function markScopedMessageImported(state: ScopedInboxState, messageId: string): void {
  state.importedMessageIds.add(messageId);
  if (!state.importedKey) return;
  try {
    localStorage.setItem(
      state.importedKey,
      serializeImportedMessageIds(state.importedMessageIds, IMPORTED_MSG_CAP),
    );
  } catch {
    /* in-memory isolation still applies */
  }
}
import {
  readCachedLinks,
  writeCachedLinks,
  fetchChatSheetLinks,
  storeChatSheetLink,
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
  const principal = state.kind === "authenticated" ? state.principal : null;
  const inboxDedupe = useMemo(
    () => loadScopedInboxState(principal),
    [principal],
  );
  const { handledInboxIds, importedMessageIds } = inboxDedupe;
  const inboxAckQueueRef = useRef(new InboxAcknowledgementQueue());
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
  // Types are ACCOUNT-SCOPED: everything templates feed on this page
  // (picker + chat-draft routing) comes from THIS pair's merged slot view —
  // the legacy personal store feeds nothing here.
  const pairTemplates = usePairTemplates(sheet?.pair_id as string | undefined, sheetId);
  const allTemplates = pairTemplates.shared;
  // PARTNER-authored types (id not live in MY slot) get a badge.
  const partnerSharedIds = new Set(
    pairTemplates.shared.filter((s) => !pairTemplates.myIds.has(s.id)).map((s) => s.id),
  );
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
  // Invite link (share modal): builds <origin>/pair/accept#c/s/k — the key rides
  // in the fragment (dev) so the invitee self-joins with no creator "grant".
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  async function openInvite() {
    if (!actor) return;
    setInviteBusy(true);
    try {
      // Mint a FRESH, live single-use code every time (the stored pair.invite_code
      // goes stale once consumed and after a partner leaves — see issue_invite).
      const code = (await (actor as any).issue_invite(sheet.pair_id)) as string;
      let kSheet: Uint8Array | undefined;
      if (!isProdVetkd()) {
        kSheet = get(sheetId) ?? (await unwrapFor(sheetId));
      }
      setInviteLink(buildInviteLink(window.location.origin, { code, sheetId, kSheet }));
      setInviteOpen(true);
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setInviteBusy(false);
    }
  }
  const openAdd = (initial: Partial<EntryPayload> | null) => {
    setModal({ initial, entryId: null });
    setAddOpen(false);
  };
  // Import an AI-extracted draft (chat bridge, Milestone 0): parse the pasted
  // JSON, dedupe by draft_id, then open the prefilled EntryForm to confirm.
  // Nothing is written until the user confirms in the form (no auto-write).
  // Resolve the template a chat message was routed to (the manifest keyword_map / model sets
  // `raw.template` to the template's NAME) against THIS account's types, so parseDraft can fill gaps
  // the extraction left. Unknown/deleted/renamed — and any name that only exists on ANOTHER of the
  // user's accounts, which the single per-user manifest roster makes routable here — resolves to no
  // base, so no foreign fee/schedule/currency can reach this sheet. See resolveTemplateBase.ts.
  const resolveTemplateBase = (
    raw: unknown,
    context?: DraftBaseResolverContext,
  ): Partial<EntryPayload> | undefined =>
    resolveTemplateBaseFor(allTemplates, raw, {
      evidence: context?.multiEntry ? "row-local" : "full",
    }).base;

  const openFromDraft = () => {
    setDraftErrors([]);
    let parsed: unknown;
    try {
      parsed = JSON.parse(draftText);
    } catch {
      setDraftErrors(["not valid JSON — paste the JSON your assistant produced"]);
      return;
    }
    const res = parseDraft(
      parsed,
      baseWithDefaultCurrency(resolveTemplateBase(parsed), prefs.defaultCurrency),
    );
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
  const [pendingImportContext, setPendingImportContext] = useState<BatchImportContext | null>(null);
  // messageId of the draft under review (OpenChat v4 wrapper only) — recorded on
  // a successful write so a sibling double-confirm card can't be imported twice.
  const [pendingMessageId, setPendingMessageId] = useState<string | null>(null);
  // Chat → sheet mapping (delivery provenance): canister-backed, cache-first.
  const [chatLinks, setChatLinks] = useState<ChatSheetLinks>(
    () => readCachedLinks(principal),
  );
  // The chat key of the draft currently being reviewed (openchat drafts only),
  // and whether "remember this chat → this sheet" is ticked (default on).
  const [pendingChatKey, setPendingChatKey] = useState<string | null>(null);
  const [rememberChat, setRememberChat] = useState(true);
  // A multi-entry chat card (confirmPayload was a JSON array): the whole batch confirms once through
  // the BatchConfirmModal below — ONE deposit / ONE messageId consumed for all N entries.
  const [batch, setBatch] = useState<null | {
    drafts: ParsedDraft[];
    messageId: string | null;
    relayId: string;
    chatKey: string | null;
    context: BatchImportContext;
  }>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const reloadPending = async () => {
    const cfg = getRelayConfig(principal);
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
  const flushInboxAcknowledgements = () => {
    void inboxAckQueueRef.current
      .flush(handledInboxIds, ({ id, acknowledgementSecret, config }) =>
        acknowledgeActionInbox({ config, throughId: id, acknowledgementSecret }),
      )
      .catch(() => {
        /* update unavailable/rejected: retain the encrypted capability and retry on the next poll */
      });
  };
  const clearRelay = async (id: string) => {
    if (id.startsWith("oc-")) {
      // On-chain inbox actions are append-only; drop it from the local pending view and remember
      // it as handled so it does not reappear on the next refresh/poll. (This local set is the
      // instant/offline echo — cross-member sync rides on the pair slot, see dismissCard below.)
      markScopedInboxHandled(inboxDedupe, id);
      setInboxPending((prev) => prev.filter((p) => p.id !== id));
      flushInboxAcknowledgements();
      return;
    }
    const cfg = getRelayConfig(principal);
    if (cfg) {
      try {
        await deletePending(cfg, id);
      } catch {
        /* ignore */
      }
    }
    await reloadPending();
  };
  // "✕" dismisses a pending card for ALL members: the local handledInboxIds echo hides it
  // instantly (and keeps it hidden offline), while the card's messageId is appended to MY pair
  // slot's dismissed list (set_pair_templates) so the PARTNER's client filters it out too on its
  // next pair load / visibility-regain reload. Best-effort: if the publish fails, the local echo
  // still applies and the partner simply keeps their copy of the card.
  const dismissDraft = (p: PendingDraft) => {
    const mid = p.context?.messageHandle;
    if (mid !== undefined && p.id.startsWith("oc-")) {
      void pairTemplates.dismissCard(mid).catch(() => {
        /* best-effort — local echo already hides it for me */
      });
    }
    void clearRelay(p.id);
  };
  const closeEntryModal = () => {
    setModal(null);
    setPendingRelayId(null);
    setPendingImportContext(null);
    setPendingChatKey(null);
    setPendingMessageId(null);
  };
  const importFromRelay = async (p: PendingDraft) => {
    if (!principal) {
      toasts.show({ kind: "error", text: "Sign in before importing this chat card" });
      return;
    }
    let inboundDraft = p.draft;
    if (p.source === "openchat") {
      try {
        const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
        inboundDraft = await restoreOpenChatTemplateRefs(
          p.draft,
          K_sheet,
          p.context
            ? {
              sheetId,
                contextVersion: p.context.contextVersion,
                appSubject: p.context.appSubject,
                chatHandle: p.context.chatHandle,
                messageHandle: p.context.messageHandle,
                appId: p.context.appId,
                appRevision: BigInt(p.context.appRevision),
                actionId: p.context.actionId,
              }
            : undefined,
          new Set(allTemplates.map((template) => template.id)),
        );
      } catch {
        toasts.show({
          kind: "error",
          text: "The account type selected in OpenChat could not be verified. Reload the card and try again.",
        });
        return;
      }
    }
    // A card's confirmPayload is EITHER a single entry (JSON object) or MULTIPLE (a JSON array);
    // parseDraftBatch normalizes both. resolveTemplateBase runs per element (each may route to a
    // different template) and the IOU default currency is injected per element.
    const { drafts, errors } = parseDraftBatch(
      inboundDraft,
      (raw, context) =>
        resolveTemplateBaseFor(allTemplates, raw, {
          // Every OpenChat row is model-produced, including an array that the
          // model filtered down to one survivor. Its repeated full `message`
          // may mention a dropped sibling, so only row-local note evidence may
          // select account-private money defaults. Local/non-OpenChat singles
          // retain the existing full-message convenience matching.
          evidence: templateEvidenceForImport(p.source, context?.multiEntry ?? false),
        }).base,
      prefs.defaultCurrency,
    );
    if (drafts.length === 0) {
      toasts.show({ kind: "error", text: "Invalid draft from chat: " + errors.join("; ") });
      return;
    }
    // Idempotency: a chat draft carries a UNIQUE messageId per card, so that is the reliable dedup
    // key — key off it and do NOT also content-dedup. Two legitimately-distinct entries can share
    // amount/currency/date/note (two same-price bookings, or repeated same-day drafts before the
    // date is parsed), which the content hash (draftId) would wrongly flag as "already added" and
    // permanently suppress WITHOUT importing. Fall back to the content hash only for wrapper-less
    // pastes that have no messageId (a multi-entry wrapper-less card keys off its FIRST entry). The
    // mid branch checks BOTH my local imported set and the sheet's decrypted entries
    // (import_message_id) — the latter catches the PARTNER's import of their fanned-out copy.
    const mid = p.context?.messageHandle;
    const alreadyAdded = mid
      ? importedMessageIds.has(mid) || isImportedIntoSheet(entries, mid, undefined)
      : isDuplicateDraft(entries, drafts[0].draftId);
    if (alreadyAdded) {
      toasts.show({ kind: "info", text: "Already added — clearing it from chat" });
      void clearRelay(p.id);
      return;
    }
    // ≥2 entries → confirm the whole batch once through the BatchConfirmModal (one deposit consumed).
    if (drafts.length > 1) {
      setBatch({
        drafts,
        messageId: mid ?? null,
        relayId: p.id,
        chatKey: p.context?.chatHandle ?? null,
        context: { sheetId, principal },
      });
      setRememberChat(true);
      return;
    }
    // Single entry → the existing EntryForm confirm flow, unchanged.
    // Persist the cross-member key on the entry-to-be: every member's fanned-out envelope carries
    // the SAME messageId, so once this import lands, isImportedIntoSheet hides the card for the
    // partner too (their local handled/imported sets never see it).
    if (mid) drafts[0].initial.import_message_id = mid;
    setPendingRelayId(p.id);
    setPendingImportContext({ sheetId, principal });
    // Track the source chat so confirming can remember chat → sheet.
    setPendingChatKey(p.context?.chatHandle ?? null);
    setPendingMessageId(mid ?? null);
    setRememberChat(true);
    openAdd(drafts[0].initial);
  };
  const activeImportContextRef = useRef<{ sheetId: string; principal: string | null }>({
    sheetId,
    principal,
  });
  activeImportContextRef.current = { sheetId, principal };
  useEffect(() => {
    if (batch && !batchImportContextMatches(batch.context, sheetId, principal)) {
      setBatch(null);
      setBatchBusy(false);
    }
    if (
      pendingImportContext &&
      !batchImportContextMatches(pendingImportContext, sheetId, principal)
    ) {
      closeEntryModal();
    }
    // Route/account changes invalidate a captured import. Pending state itself
    // is intentionally not a dependency: it is captured under the current
    // route/account and only a later route/account change can make it stale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetId, principal]);
  // Persist a chat → sheet mapping: optimistic (state + cache first), then the
  // canister call; on failure roll back and let the next fetch re-sync.
  const rememberChatMapping = (chatKey: string, target: BatchImportContext) => {
    const current = activeImportContextRef.current;
    if (!batchImportContextMatches(target, current.sheetId, current.principal)) return;
    const prev = chatLinks;
    const next = { ...prev, [chatKey]: target.sheetId };
    setChatLinks(next);
    writeCachedLinks(target.principal, next);
    if (!actor) return;
    void storeChatSheetLink(actor, chatKey, target.sheetId).catch(() => {
      setChatLinks(prev);
      writeCachedLinks(target.principal, prev);
      toasts.show({ kind: "error", text: "Could not save the chat → sheet mapping" });
    });
  };
  useEffect(() => {
    const cfg = getRelayConfig(principal);
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
  }, [principal]);

  // Refresh the chat → sheet links from the canister (cache-first: state is
  // seeded from localStorage above, the canister copy wins when it arrives).
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    if (!principal) {
      setChatLinks({});
      return;
    }
    void fetchChatSheetLinks(actor, principal)
      .then((links) => {
        if (!cancelled) setChatLinks(links);
      })
      .catch(() => {
        /* canister unreachable — keep the cached copy */
      });
    return () => {
      cancelled = true;
    };
  }, [actor, principal]);

  // "Pending from OpenChat": confirmed actions OpenChat deposited on-chain. We pull them from the action_inbox
  // canister, verify OpenChat's provenance signature + decrypt locally, then feed each through the same seam.
  useEffect(() => {
    let cancelled = false;
    let iv: ReturnType<typeof setInterval> | undefined;
    const ackQueue = new InboxAcknowledgementQueue();
    inboxAckQueueRef.current = ackQueue;
    // Resolve through the short-lived manifest cache on every poll. This lets a mounted page follow
    // re-registration while preserving each old action's originating route for acknowledgement.
    void (async () => {
      const load = async () => {
        try {
          if (!actor) return;
          const cfg = await getActionInboxConfig(actor);
          if (cancelled || !cfg) return;
          const drafts = await pollActionInbox({ config: cfg });
          if (cancelled) return;
          ackQueue.observe(
            drafts.map(({ id, deliveryId, acknowledgementSecret }) => ({
              id,
              deliveryId,
              acknowledgementSecret,
              config: cfg,
            })),
          );
          void ackQueue
            .flush(handledInboxIds, ({ id, acknowledgementSecret, config }) =>
              acknowledgeActionInbox({ config, throughId: id, acknowledgementSecret }),
            )
            .catch(() => {
              /* keep the candidate queued for the next 15-second poll */
            });
          if (drafts.length === 0) return;
          setInboxPending((prev) => {
            const seen = new Set(prev.map((p) => p.id));
            const add: PendingDraft[] = drafts
              .filter((d) => !seen.has(`oc-${d.deliveryId}`) && !handledInboxIds.has(`oc-${d.deliveryId}`))
              .map((d) => ({
                id: `oc-${d.deliveryId}`,
                draft: d.draft,
                // action_inbox stores TimestampMillis — no nanosecond conversion.
                created_at: Number(d.created_at),
                source: "openchat",
                // Polling emits only fully verified v4 envelopes with authenticated context.
                context: d.context,
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
      if (inboxAckQueueRef.current === ackQueue) {
        inboxAckQueueRef.current = new InboxAcknowledgementQueue();
      }
    };
  }, [actor, principal, handledInboxIds]);

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
      const decoded = await decryptEntryRecords(res.entries, K_sheet);
      if (decoded.failures.length > 0) {
        const entryFailures = decoded.failures.filter((failure) => failure.stage === "entry").length;
        const historyFailures = decoded.failures.length - entryFailures;
        toasts.show({
          kind: "error",
          text: [
            entryFailures
              ? `${entryFailures} unreadable entr${entryFailures === 1 ? "y" : "ies"}`
              : "",
            historyFailures ? `${historyFailures} unreadable history version(s)` : "",
          ]
            .filter(Boolean)
            .join(" and ")
            .replace(/^/, "Skipped "),
          ms: 8000,
        });
      }
      setEntries(decoded.entries);
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

  // Freshness for the cross-member pending filter: the partner's import only hides a card here
  // once OUR `entries` copy contains their entry (with its import_message_id), and the partner's
  // DISMISSALS only land once we re-read the pair slots (their dismissed list). The 15 s inbox
  // polls only ADD cards — entries + slots drive removal — so re-fetch BOTH when the tab regains
  // visibility, letting the hide land without a manual page reload.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void reload();
        pairTemplates.reload();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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

  // Inbox drafts whose source chat is pinned to a DIFFERENT sheet are hidden here — they show up on
  // their mapped sheet's page instead — as are cards any member already imported or dismissed. The
  // whole decision (and the reasoning behind each layer) is in visibleInboxFor; this is its only
  // caller, which is why that seam is unit-tested against the sheets it must NOT leak onto.
  const visibleInbox = useMemo(
    () =>
      visibleInboxFor({
        inboxPending,
        chatLinks,
        sheetId,
        entries,
        dismissed: pairTemplates.dismissed,
        resolveTemplateBase,
        defaultCurrency: prefs.defaultCurrency,
      }),
    // resolveTemplateBase is re-created each render but only reads the account's
    // shared types — dep on those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inboxPending, chatLinks, sheetId, entries, pairTemplates.shared, pairTemplates.dismissed],
  );

  // A partner can import or dismiss their fanned-out copy before this browser acts. Once that
  // durable pair/sheet evidence arrives, this copy is handled too: mark it locally and release the
  // encrypted inbox capability. Do not infer handling merely because routing hides another sheet.
  useEffect(() => {
    const newlyHandled: string[] = [];
    for (const draft of inboxPending) {
      if (!draft.id.startsWith("oc-") || handledInboxIds.has(draft.id)) continue;
      const messageId = draft.context?.messageHandle;
      if (
        isDurablyHandledInboxMessage(
          messageId,
          importedMessageIds,
          pairTemplates.dismissed,
          (id) => isImportedIntoSheet(entries, id, undefined),
        )
      ) {
        markScopedInboxHandled(inboxDedupe, draft.id);
        newlyHandled.push(draft.id);
      }
    }
    if (newlyHandled.length === 0) return;
    const remove = new Set(newlyHandled);
    setInboxPending((current) => current.filter((draft) => !remove.has(draft.id)));
    flushInboxAcknowledgements();
    // Sets are stable, mutable scope stores; inbox/entry/template changes trigger reconciliation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxPending, entries, pairTemplates.dismissed, importedMessageIds, handledInboxIds]);

  // Headless encrypt-under-K_sheet + add_entry for the unchanged single-entry
  // path. Multi-entry confirmation uses addEntryBatch below so one message can
  // never leave a partially appended prefix.
  async function writeEntry(payload: EntryPayload): Promise<void> {
    if (!actor) throw new Error("IOU backend is unavailable; no entry was added");
    const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
    const enc = await encryptEntryPayload(
      new TextEncoder().encode(JSON.stringify(payload)),
      K_sheet,
    );
    await (actor as any).add_entry({
      sheet_id: sheetId,
      entry_key: Array.from(enc.entryKey),
      ciphertext: Array.from(enc.ciphertext),
      iv: Array.from(enc.iv),
    });
  }

  async function onSubmit(p: EntryPayload) {
    if (!actor) {
      toasts.show({ kind: "error", text: "IOU backend is unavailable; no entry was added" });
      return;
    }
    // Direction is stored in the entry author's frame. The form works in the viewer's frame, so when
    // editing a PARTNER's entry (createdByMe === false), orient back before storing. Adds are always
    // authored by me → my frame IS the author frame → no change.
    const toStore: EntryPayload =
      modal?.createdByMe === false ? { ...p, direction: flipDirection(p.direction) } : p;
    if (modal?.entryId != null) {
      const K_sheet = get(sheetId) ?? (await unwrapFor(sheetId));
      const enc = await encryptEntryPayload(
        new TextEncoder().encode(JSON.stringify(toStore)),
        K_sheet,
      );
      await (actor as any).edit_entry({
        sheet_id: sheetId,
        entry_id: BigInt(modal.entryId),
        entry_key: Array.from(enc.entryKey),
        ciphertext: Array.from(enc.ciphertext),
        iv: Array.from(enc.iv),
      });
      toasts.show({ kind: "success", text: "Entry updated" });
    } else if (pendingRelayId) {
      if (
        !pendingImportContext ||
        !batchImportContextMatches(pendingImportContext, sheetId, principal)
      ) {
        closeEntryModal();
        throw new Error("The sheet or signed-in account changed; the chat card was not imported");
      }
      const K_sheet = get(pendingImportContext.sheetId) ??
        (await unwrapFor(pendingImportContext.sheetId));
      const acknowledgement = await addEntryBatch({
        actor: actor as any,
        sheetId: pendingImportContext.sheetId,
        payloads: [toStore],
        messageHandle: pendingMessageId,
        relayId: pendingRelayId,
        sheetKey: K_sheet,
        beforeMutate: () => {
          const current = activeImportContextRef.current;
          if (!batchImportContextMatches(pendingImportContext, current.sheetId, current.principal)) {
            throw new Error("The sheet or signed-in account changed; the chat card was not imported");
          }
        },
      });
      const current = activeImportContextRef.current;
      if (!batchImportContextMatches(pendingImportContext, current.sheetId, current.principal)) {
        throw new Error("The sheet or signed-in account changed; the chat card remains pending");
      }
      toasts.show({
        kind: "success",
        text: acknowledgement.accepted_count === 1
          ? "Entry added"
          : `Added ${acknowledgement.accepted_count} entries`,
      });
      const stillCurrent = await finalizeAcceptedChatImport({
        captured: pendingImportContext,
        clear: () => clearRelay(pendingRelayId),
        current: () => activeImportContextRef.current,
      });
      if (!stillCurrent) return;
      // Remember this messageId so a sibling double-confirm card is caught by
      // the accept-path guard even before the new entry is re-fetched.
      if (pendingMessageId) markScopedMessageImported(inboxDedupe, pendingMessageId);
      // First import from a chat that isn't mapped yet: honour the
      // "remember" checkbox (default on) by pinning chat → this sheet.
      if (pendingRelayId && pendingChatKey && rememberChat && !chatLinks[pendingChatKey]) {
        rememberChatMapping(pendingChatKey, pendingImportContext);
      }
    } else {
      await writeEntry(toStore);
      toasts.show({ kind: "success", text: "Entry added" });
    }
    setPendingRelayId(null);
    setPendingImportContext(null);
    setPendingChatKey(null);
    setPendingMessageId(null);
    setModal(null);
    await reload();
  }

  // Confirm-all for a multi-entry card: write every parsed entry (each tagged with the SAME
  // messageId + its own draft_id), then clear the card + mark the messageId imported + remember the
  // chat mapping ONCE. One human confirm → N entries → one deposit consumed.
  async function confirmBatch() {
    if (!batch || batchBusy) return;
    if (!actor) {
      toasts.show({ kind: "error", text: "IOU backend is unavailable; no entries were added" });
      return;
    }
    if (!batchImportContextMatches(batch.context, sheetId, principal)) {
      setBatch(null);
      toasts.show({
        kind: "error",
        text: "The sheet or signed-in account changed; the chat card was not imported",
      });
      return;
    }
    setBatchBusy(true);
    try {
      const payloads = batch.drafts.map((draft) =>
        parsedToPayload({
          ...draft.initial,
          ...(batch.messageId ? { import_message_id: batch.messageId } : {}),
        }),
      );
      const K_sheet = get(batch.context.sheetId) ?? (await unwrapFor(batch.context.sheetId));
      const acknowledgement = await addEntryBatch({
        actor: actor as any,
        sheetId: batch.context.sheetId,
        payloads,
        messageHandle: batch.messageId,
        relayId: batch.relayId,
        sheetKey: K_sheet,
        beforeMutate: () => {
          const current = activeImportContextRef.current;
          if (!batchImportContextMatches(batch.context, current.sheetId, current.principal)) {
            throw new Error("The sheet or signed-in account changed; the chat card was not imported");
          }
        },
      });
      const current = activeImportContextRef.current;
      if (!batchImportContextMatches(batch.context, current.sheetId, current.principal)) {
        throw new Error("The sheet or signed-in account changed; the chat card remains pending");
      }
      const stillCurrent = await finalizeAcceptedChatImport({
        captured: batch.context,
        clear: () => clearRelay(batch.relayId),
        current: () => activeImportContextRef.current,
      });
      if (!stillCurrent) return;
      if (batch.messageId) markScopedMessageImported(inboxDedupe, batch.messageId);
      if (batch.chatKey && rememberChat && !chatLinks[batch.chatKey]) {
        rememberChatMapping(batch.chatKey, batch.context);
      }
      toasts.show({ kind: "success", text: `Added ${acknowledgement.accepted_count} entries` });
      setBatch(null);
      await reload();
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setBatchBusy(false);
    }
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
          · {isActive(sheet.state) ? "Active" : "Closed"}
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
              // Single OR multi-entry card: batchSummary renders the count ("N entries: …") for a
              // multi card and the plain summary for a single one (byte-identical to before).
              const rb = parseDraftBatch(p.draft, resolveTemplateBase, prefs.defaultCurrency);
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
                            ? "Verified OpenChat delivery with app-scoped provenance"
                            : "Forwarded chat draft"
                        }
                        style={{ marginRight: 6 }}
                      >
                        ✦ OpenChat
                        {p.context && (
                          <span className="muted" style={{ marginLeft: 4 }}>
                            · {p.context.chatHandle.slice(0, 8)}…
                          </span>
                        )}
                      </span>
                    )}
                    {/* Invalid drafts carry the FIRST parse error so the human can see why (e.g.
                        the live "hi" → amount 0 card read as a bare "invalid draft"); the ✕
                        (dismiss-for-everyone) button is the resolution path. */}
                    {batchSummary(rb)}
                  </span>
                  <span className="row" style={{ gap: 6 }}>
                    <button className="secondary small" onClick={() => void importFromRelay(p)}>
                      Review &amp; add
                    </button>
                    <button
                      className="secondary small"
                      onClick={() => dismissDraft(p)}
                      title="Dismiss without adding (for everyone on this sheet)"
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
            {allTemplates.length > 0 ? (
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
                    {allTemplates.map((t) => (
                      <button
                        key={t.id}
                        className="secondary"
                        style={{ display: "block", width: "100%", marginBottom: 6 }}
                        onClick={() => openAdd(templateToInitial(t))}
                      >
                        {t.name}
                        {partnerSharedIds.has(t.id) && (
                          <span className="muted small"> · partner</span>
                        )}
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
              closingDays={Number(sheet.closing_window_days)}
              // Pass VIEWER-ORIENTED payloads (same as the displayed balances): the closing
              // user authors the carry-forward entries, so the outstanding balance — and thus
              // the debt/credit direction carried forward — must be in the closer's frame.
              // Passing raw author-relative payloads inverts the sign for partner-authored
              // entries (carry-forward would flip who owes whom).
              entries={payloads}
            />
            {isSolo && (
              <button
                className="secondary"
                onClick={() => void openInvite()}
                disabled={inviteBusy}
                title="Invite someone to share this account"
              >
                {inviteBusy ? "…" : "🔗 Invite"}
              </button>
            )}
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

      {inviteOpen && inviteLink && (
        <div className="modal-backdrop" onClick={() => setInviteOpen(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3>Invite to this account</h3>
            <p className="muted small">
              Send this link. When they open it and sign in, they join instantly
              with full access — no extra step from you.
              <br />
              🔒 Anyone with the link can join once — share it privately.
            </p>
            <textarea
              readOnly
              value={inviteLink}
              rows={3}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{ width: "100%", fontFamily: "monospace", fontSize: "0.75rem" }}
            />
            <div className="cta-row">
              <button
                className="secondary"
                onClick={() => setInviteOpen(false)}
              >
                Close
              </button>
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(inviteLink);
                  toasts.show({ kind: "success", text: "Invite link copied" });
                }}
              >
                Copy link
              </button>
            </div>
          </div>
        </div>
      )}

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

      {batch && (
        <BatchConfirmModal
          drafts={batch.drafts}
          busy={batchBusy}
          onCancel={() => (batchBusy ? undefined : setBatch(null))}
          onConfirm={() => void confirmBatch()}
          showRemember={!!batch.chatKey && !chatLinks[batch.chatKey]}
          remember={rememberChat}
          onRememberChange={setRememberChat}
        />
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
            <TemplatesManager onSaved={() => setTypesOpen(false)} pair={pairTemplates} />
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
