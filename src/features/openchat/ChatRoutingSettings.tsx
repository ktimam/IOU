import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useActor, unwrap } from "../flows/useActor";
import { usePreferences, type Preferences } from "../settings/usePreferences";
import {
  nat64ToSheetId,
  fetchChatSheetLinks,
  sheetIdToNat64,
} from "./chatSheetLinks";

export type ActiveRouteSheet = {
  sheetId: string;
  label: string;
};

export type PendingChatRoute = {
  pendingId: string;
  chatName: string | null;
  lastSeen: bigint;
  hasCurrentLink: boolean;
  currentSheetId: string | null;
};

export type ChatRouteRow = {
  kind: "pending";
  internalKey: string;
  pendingId: string;
  label: string;
  lastSeen: bigint;
  hasCurrentLink: boolean;
  currentSheetId: string | null;
  chatName: string | null;
  isMostRecent: boolean;
};

export type ChatRouteClaimOutcome =
  | { kind: "success"; pendingId: string }
  | { kind: "invalid-token" }
  | { kind: "not-configured" }
  | { kind: "not-linked" }
  | { kind: "token-unavailable" }
  | { kind: "wrong-account" }
  | { kind: "invalid-binding" }
  | { kind: "binding-changed" }
  | { kind: "remote-error" };

export function decodeChatRouteClaimOutcome(value: unknown): ChatRouteClaimOutcome {
  if (!value || typeof value !== "object") return { kind: "remote-error" };
  const variant = value as Record<string, unknown>;
  const success = variant.Success;
  if (success && typeof success === "object") {
    const pendingId = (success as { pending_id?: unknown }).pending_id;
    if (typeof pendingId === "string" && /^[0-9a-f]{64}$/.test(pendingId)) {
      return { kind: "success", pendingId };
    }
    return { kind: "remote-error" };
  }
  if ("InvalidToken" in variant) return { kind: "invalid-token" };
  if ("NotConfigured" in variant) return { kind: "not-configured" };
  if ("NotLinked" in variant) return { kind: "not-linked" };
  if ("TokenUnavailable" in variant) return { kind: "token-unavailable" };
  if ("WrongAccount" in variant) return { kind: "wrong-account" };
  if ("InvalidBinding" in variant) return { kind: "invalid-binding" };
  if ("BindingChanged" in variant) return { kind: "binding-changed" };
  return { kind: "remote-error" };
}

export function chatRouteClaimMessage(outcome: ChatRouteClaimOutcome): string {
  switch (outcome.kind) {
    case "success":
      return "This chat is ready. Choose its account / sheet below.";
    case "invalid-token":
      return "This chat setup link is malformed. Open setup again from that chat.";
    case "token-unavailable":
      return "This chat setup link expired or was already used. Open setup again from that chat.";
    case "wrong-account":
      return "This link belongs to a different connected OpenChat account. Sign out and sign in to its IOU account; the link has not been used.";
    case "not-linked":
      return "This IOU account is not connected to OpenChat. Sign in to the matching IOU account or connect it, then retry.";
    case "not-configured":
      return "Chat setup is not configured for this IOU deployment.";
    case "invalid-binding":
      return "This IOU/OpenChat connection is stale. Reconnect the matching account, then open setup again from that chat.";
    case "binding-changed":
      return "The IOU/OpenChat connection changed during setup. Open setup again from that chat.";
    case "remote-error":
      return "Chat setup could not be verified. Retry without copying or sharing the setup link.";
  }
}

type PairSummary = {
  id: string;
  active_sheet_id?: unknown;
  archived_at?: unknown;
};

function optText(value: unknown): string | null {
  const unwrapped = unwrap(value);
  if (typeof unwrapped === "string") return unwrapped;
  if (
    unwrapped &&
    typeof unwrapped === "object" &&
    "id" in unwrapped &&
    typeof (unwrapped as { id?: unknown }).id === "string"
  ) {
    return (unwrapped as { id: string }).id;
  }
  return null;
}

export function activeRouteSheets(
  pairs: PairSummary[],
  prefs: Pick<Preferences, "accountNames" | "partnerNames" | "sheetNames">,
): ActiveRouteSheet[] {
  const active = pairs
    .filter((pair) => unwrap(pair.archived_at) == null)
    .map((pair) => ({ pair, sheetId: optText(pair.active_sheet_id) }))
    .filter((row): row is { pair: PairSummary; sheetId: string } => row.sheetId !== null);
  return active
    .map(({ pair, sheetId }, index) => {
      const account =
        prefs.accountNames[pair.id] || prefs.partnerNames[pair.id] || `Account ${index + 1}`;
      const sheet = prefs.sheetNames[sheetId];
      return {
        sheetId,
        label: sheet && sheet !== account ? `${account} — ${sheet}` : account,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label) || left.sheetId.localeCompare(right.sheetId));
}

export function routableSheetIdSet(routableWire: unknown): Set<string> {
  const routableIds = new Set<string>();
  const values =
    Array.isArray(routableWire) || routableWire instanceof BigUint64Array
      ? routableWire
      : [];
  for (const value of values) {
    try {
      routableIds.add(nat64ToSheetId(BigInt(value as bigint)));
    } catch {
      // Ignore malformed values from a stale/mismatched declaration.
    }
  }
  return routableIds;
}

export function buildChatRouteRows(
  pending: PendingChatRoute[],
): ChatRouteRow[] {
  let durableIndex = 0;
  return [...pending]
    .sort((left, right) =>
      left.lastSeen === right.lastSeen
        ? left.pendingId.localeCompare(right.pendingId)
        : left.lastSeen > right.lastSeen
          ? -1
          : 1,
    )
    .map((route, index) => {
      const durable = route.lastSeen === 0n && route.hasCurrentLink;
      if (durable) durableIndex += 1;
      return {
        kind: "pending",
        internalKey: `pending:${route.pendingId}`,
        pendingId: route.pendingId,
        label:
          route.chatName ??
          (durable
            ? durableIndex === 1
              ? "Unnamed linked OpenChat chat"
              : `Unnamed linked OpenChat chat ${durableIndex}`
            : index === 0
              ? "Unnamed recent OpenChat chat"
              : `Unnamed earlier OpenChat chat ${index}`),
        lastSeen: route.lastSeen,
        hasCurrentLink: route.hasCurrentLink,
        currentSheetId: route.currentSheetId,
        chatName: route.chatName,
        isMostRecent: !durable && index === 0,
      } satisfies ChatRouteRow;
    });
}

function requestedAt(lastSeen: bigint): string {
  const milliseconds = lastSeen / 1_000_000n;
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return "recently";
  return new Date(Number(milliseconds)).toLocaleString();
}

type ViewProps = {
  sectionRef?: RefObject<HTMLElement>;
  sheets: ActiveRouteSheet[];
  rows: ChatRouteRow[];
  selections: Record<string, string>;
  loading?: boolean;
  claiming?: boolean;
  busyKey?: string | null;
  status?: string | null;
  focusedPendingId?: string | null;
  onSelect?: (internalKey: string, sheetId: string) => void;
  onSave?: (row: ChatRouteRow) => void;
  onRemove?: (row: ChatRouteRow) => void;
  onRefresh?: () => void;
  onRouteFocused?: () => void;
};

/// Presentation-only export keeps the privacy boundary testable: route handles and pending ids may
/// be held in closures/state, but are never rendered into text, attributes, URLs, or form values.
export function ChatRoutingView({
  sectionRef,
  sheets,
  rows,
  selections,
  loading = false,
  claiming = false,
  busyKey = null,
  status = null,
  focusedPendingId = null,
  onSelect = () => undefined,
  onSave = () => undefined,
  onRemove = () => undefined,
  onRefresh = () => undefined,
  onRouteFocused = () => undefined,
}: ViewProps) {
  const routeElements = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!focusedPendingId) return;
    const row = rows.find((candidate) => candidate.pendingId === focusedPendingId);
    if (!row) return;
    const element = routeElements.current.get(row.internalKey);
    element?.scrollIntoView({ block: "center" });
    element?.querySelector<HTMLSelectElement>("select")?.focus();
    onRouteFocused();
  }, [focusedPendingId, onRouteFocused, rows]);

  return (
    <section className="card" id="openchat-routing" ref={sectionRef}>
      <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Chat routing</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Each name comes from the exact OpenChat chat that opened setup. Choose the IOU
            account / sheet for that chat; saving one row never changes another chat.
          </p>
        </div>
        <button
          className="secondary"
          disabled={loading || claiming || busyKey !== null}
          onClick={onRefresh}
        >
          Refresh
        </button>
      </div>

      {loading && <p className="muted">Loading chat routes…</p>}
      {!loading && sheets.length === 0 && (
        <p className="muted">
          Create an active IOU account/sheet before routing an OpenChat chat.
        </p>
      )}
      {!loading && sheets.length > 0 && rows.length === 0 && (
        <p className="muted">
          No chat is waiting for setup. In that OpenChat chat, open its chat settings page, then use
          AI apps → Open setup. Opening or proposing on a card does not link a sheet.
        </p>
      )}

      {!loading && rows.length > 0 && (
        <p className="muted small">
          {rows.length} chat {rows.length === 1 ? "route" : "routes"} shown. To add another, use
          Open setup inside that exact OpenChat chat.
        </p>
      )}

      {rows.map((row) => {
        const selected = selections[row.internalKey] ?? "";
        const busy = busyKey === row.internalKey;
        const destination = sheets.find((sheet) => sheet.sheetId === selected)?.label ??
          "Choose destination";
        return (
          <div
            className="card"
            key={row.internalKey}
            ref={(element) => {
              if (element) routeElements.current.set(row.internalKey, element);
              else routeElements.current.delete(row.internalKey);
            }}
            style={{ marginTop: 12 }}
          >
            <h3 style={{ marginTop: 0 }}>
              {row.label} <span className="muted">→ {destination}</span>
            </h3>
            <p className="muted small">
              {row.lastSeen === 0n && row.hasCurrentLink
                ? "This chat has a saved routing destination. You can reassign or remove it."
                : `Requested ${requestedAt(row.lastSeen)} through authenticated OpenChat context.${
                    row.hasCurrentLink
                      ? " It already has a saved destination; you can reassign or remove it."
                      : " Pick its destination."
                  }`}
            </p>
            <label>
              Account / sheet
              <select
                aria-label={`${row.label} account or sheet`}
                value={selected}
                disabled={busy || sheets.length === 0}
                onChange={(event) => onSelect(row.internalKey, event.target.value)}
              >
                <option value="">Choose an account / sheet</option>
                {sheets.map((sheet) => (
                  <option key={sheet.sheetId} value={sheet.sheetId}>
                    {sheet.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="row" style={{ marginTop: 10, gap: 8 }}>
              <button disabled={busy || selected === ""} onClick={() => onSave(row)}>
                {busy
                  ? "Saving…"
                  : row.hasCurrentLink
                    ? `Save ${row.label} destination`
                    : `Link ${row.label}`}
              </button>
              <button className="secondary" disabled={busy} onClick={() => onRemove(row)}>
                {row.hasCurrentLink ? "Remove link" : "Dismiss"}
              </button>
            </div>
          </div>
        );
      })}
      {status && <p className="muted small">{status}</p>}
    </section>
  );
}

type ChatRoutingSettingsProps = {
  principal: string;
  launchToken?: string | null;
  onLaunchTokenFinished?: (token: string) => void;
};

type ChatRoutingSettingsContentProps = ChatRoutingSettingsProps & {
  actor: ReturnType<typeof useActor>["actor"];
  prefs: Preferences;
};

/** Production routing logic, exported so the browser regression can mount this exact component. */
export function ChatRoutingSettingsContent({
  actor,
  prefs,
  principal,
  launchToken = null,
  onLaunchTokenFinished = () => undefined,
}: ChatRoutingSettingsContentProps) {
  const sectionRef = useRef<HTMLElement>(null);
  const [sheets, setSheets] = useState<ActiveRouteSheet[]>([]);
  const [pending, setPending] = useState<PendingChatRoute[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [focusedPendingId, setFocusedPendingId] = useState<string | null>(null);
  const reloadGeneration = useRef(0);
  const claimGeneration = useRef(0);
  const attemptedClaim = useRef<string | null>(null);
  const inFlightClaim = useRef<{ key: string; promise: Promise<void> } | null>(null);
  const claimScope = actor && launchToken ? `${principal}\0${launchToken}` : null;
  const currentClaimScope = useRef<string | null>(claimScope);
  currentClaimScope.current = claimScope;

  const rows = useMemo(() => buildChatRouteRows(pending), [pending]);

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current;
    if (!actor) {
      setSheets([]);
      setPending([]);
      setSelections({});
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [pairWire, routableWire, pendingWire] = await Promise.all([
        actor.get_my_pairs(),
        actor.chat_routable_sheet_ids(),
        actor.pending_chat_routes(),
      ]);
      if (generation !== reloadGeneration.current) return;
      const routableIds = routableSheetIdSet(routableWire);
      const nextSheets = activeRouteSheets(
        Array.isArray(pairWire) ? (pairWire as PairSummary[]) : [],
        prefs,
      ).filter((sheet) => routableIds.has(sheet.sheetId));
      const nextPending: PendingChatRoute[] = (Array.isArray(pendingWire) ? pendingWire : [])
        .flatMap((row) => {
          const candidate = row as {
            pending_id?: unknown;
            last_seen?: unknown;
            has_current_link?: unknown;
            current_sheet_id?: unknown;
            chat_name?: unknown;
          };
          if (
            typeof candidate.pending_id !== "string" ||
            !/^[0-9a-f]{64}$/.test(candidate.pending_id)
          ) {
            return [];
          }
          try {
            const currentWire = unwrap(candidate.current_sheet_id);
            const currentSheetId =
              currentWire == null ? null : nat64ToSheetId(BigInt(currentWire as bigint));
            const chatNameWire = unwrap(candidate.chat_name);
            const chatName =
              typeof chatNameWire === "string" &&
              chatNameWire !== "" &&
              chatNameWire.trim() === chatNameWire
                ? chatNameWire
                : null;
            return [{
              pendingId: candidate.pending_id,
              chatName,
              lastSeen: BigInt(candidate.last_seen as bigint),
              hasCurrentLink: candidate.has_current_link === true,
              currentSheetId:
                currentSheetId !== null && routableIds.has(currentSheetId)
                  ? currentSheetId
                  : null,
            }];
          } catch {
            return [];
          }
        });
      setSheets(nextSheets);
      setPending(nextPending);
      const nextRows = buildChatRouteRows(nextPending);
      setSelections(
        Object.fromEntries(
          nextRows.map((row) => [
            row.internalKey,
            row.currentSheetId ?? "",
          ]),
        ),
      );
    } catch (error) {
      if (generation === reloadGeneration.current) {
        setStatus(`Could not load chat routes: ${String((error as Error)?.message ?? error)}`);
      }
    } finally {
      if (generation === reloadGeneration.current) setLoading(false);
    }
  }, [actor, prefs.accountNames, prefs.partnerNames, prefs.sheetNames, principal]);

  useEffect(() => {
    void reload();
    return () => {
      reloadGeneration.current += 1;
    };
  }, [reload]);

  const claimLaunch = useCallback((force = false): Promise<void> => {
    if (!actor || !launchToken) return Promise.resolve();
    const attemptKey = `${principal}\0${launchToken}`;
    const existing = inFlightClaim.current;
    if (existing?.key === attemptKey) return existing.promise;
    if (!force && attemptedClaim.current === attemptKey) return Promise.resolve();
    attemptedClaim.current = attemptKey;
    const generation = ++claimGeneration.current;
    setClaiming(true);
    setStatus("Verifying this chat setup link...");

    let task!: Promise<void>;
    task = (async () => {
      try {
        const outcome = decodeChatRouteClaimOutcome(
          await actor.claim_openchat_chat_route(launchToken),
        );
        if (
          generation !== claimGeneration.current ||
          currentClaimScope.current !== attemptKey
        ) return;
        if (outcome.kind === "success") {
          // Reload and select the exact redeemed row before clearing the parent token. Clearing
          // first changes this component's props and used to cancel its own continuation.
          await reload();
          if (
            generation !== claimGeneration.current ||
            currentClaimScope.current !== attemptKey
          ) return;
          setFocusedPendingId(outcome.pendingId);
          setStatus(chatRouteClaimMessage(outcome));
          onLaunchTokenFinished(launchToken);
          return;
        }
        setStatus(chatRouteClaimMessage(outcome));
        if (outcome.kind === "invalid-token" || outcome.kind === "token-unavailable") {
          onLaunchTokenFinished(launchToken);
        }
      } catch {
        if (
          generation === claimGeneration.current &&
          currentClaimScope.current === attemptKey
        ) {
          // Deliberately generic: agent/reject messages are not rendered because they must never
          // echo the launch argument into the DOM.
          setStatus(chatRouteClaimMessage({ kind: "remote-error" }));
        }
      }
    })().finally(() => {
      if (inFlightClaim.current?.promise === task) {
        inFlightClaim.current = null;
        setClaiming(false);
      }
    });
    inFlightClaim.current = { key: attemptKey, promise: task };
    return task;
  }, [actor, launchToken, onLaunchTokenFinished, principal, reload]);

  useEffect(() => {
    void claimLaunch();
  }, [claimLaunch]);

  useEffect(() => {
    if (globalThis.location?.hash !== "#openchat-routing") return;
    // The child view focuses the exact row returned by token redemption. Do not overwrite that
    // privacy-critical target with the first (most recent) row after the same reload.
    if (focusedPendingId) return;
    sectionRef.current?.scrollIntoView({ block: "start" });
  }, [rows.length, loading]);

  async function save(row: ChatRouteRow) {
    if (!actor) return;
    const sheetId = selections[row.internalKey];
    if (!sheetId) return;
    setBusyKey(row.internalKey);
    setStatus(null);
    try {
      await actor.assign_pending_chat_route(row.pendingId, sheetIdToNat64(sheetId));
      try {
        await fetchChatSheetLinks(actor, principal);
      } catch {
        // The durable write succeeded; another screen can refresh the optimistic cache later.
      }
      await reload();
      const destination =
        sheets.find((sheet) => sheet.sheetId === sheetId)?.label ?? "the selected account";
      setStatus(
        `${row.label} now routes to ${destination}. Other OpenChat chat links were not changed.`,
      );
    } catch (error) {
      setStatus(`Could not save chat destination: ${String((error as Error)?.message ?? error)}`);
    } finally {
      setBusyKey(null);
    }
  }

  async function remove(row: ChatRouteRow) {
    if (!actor) return;
    setBusyKey(row.internalKey);
    setStatus(null);
    try {
      if (row.hasCurrentLink) {
        await actor.remove_pending_chat_route_link(row.pendingId);
        try {
          await fetchChatSheetLinks(actor, principal);
        } catch {
          // The durable unlink succeeded; another screen can refresh the cache later.
        }
      } else {
        await actor.dismiss_pending_chat_route(row.pendingId);
      }
      await reload();
      setStatus(
        row.hasCurrentLink
          ? "Chat link removed."
          : "Chat request dismissed.",
      );
    } catch (error) {
      setStatus(`Could not update chat routing: ${String((error as Error)?.message ?? error)}`);
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <ChatRoutingView
      sectionRef={sectionRef}
      sheets={sheets}
      rows={rows}
      selections={selections}
      loading={loading}
      claiming={claiming}
      busyKey={busyKey}
      status={status}
      focusedPendingId={focusedPendingId}
      onSelect={(internalKey, sheetId) =>
        setSelections((current) => ({ ...current, [internalKey]: sheetId }))}
      onSave={(row) => void save(row)}
      onRemove={(row) => void remove(row)}
      onRefresh={() => {
        if (launchToken) void claimLaunch(true);
        else {
          setStatus(null);
          void reload();
        }
      }}
      onRouteFocused={() => setFocusedPendingId(null)}
    />
  );
}

export function ChatRoutingSettings(props: ChatRoutingSettingsProps) {
  const { actor } = useActor();
  const { prefs } = usePreferences();
  return (
    <ChatRoutingSettingsContent
      {...props}
      actor={actor}
      prefs={prefs}
    />
  );
}
