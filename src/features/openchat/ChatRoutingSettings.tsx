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
  isMostRecent: boolean;
};

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

export function buildChatRouteRows(
  pending: PendingChatRoute[],
): ChatRouteRow[] {
  return [...pending]
    .sort((left, right) =>
      left.lastSeen === right.lastSeen
        ? left.pendingId.localeCompare(right.pendingId)
        : left.lastSeen > right.lastSeen
          ? -1
          : 1,
    )
    .map((route, index) => ({
      kind: "pending",
      internalKey: `pending:${route.pendingId}`,
      pendingId: route.pendingId,
      label: index === 0 ? "Most recent chat request" : `Earlier chat request ${index}`,
      lastSeen: route.lastSeen,
      hasCurrentLink: route.hasCurrentLink,
      currentSheetId: route.currentSheetId,
      isMostRecent: index === 0,
    }));
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
  busyKey?: string | null;
  status?: string | null;
  onSelect?: (internalKey: string, sheetId: string) => void;
  onSave?: (row: ChatRouteRow) => void;
  onRemove?: (row: ChatRouteRow) => void;
  onRefresh?: () => void;
};

/// Presentation-only export keeps the privacy boundary testable: route handles and pending ids may
/// be held in closures/state, but are never rendered into text, attributes, URLs, or form values.
export function ChatRoutingView({
  sectionRef,
  sheets,
  rows,
  selections,
  loading = false,
  busyKey = null,
  status = null,
  onSelect = () => undefined,
  onSave = () => undefined,
  onRemove = () => undefined,
  onRefresh = () => undefined,
}: ViewProps) {
  return (
    <section className="card" id="openchat-routing" ref={sectionRef}>
      <div className="row" style={{ justifyContent: "space-between", gap: 12 }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Chat routing</h2>
          <p className="muted small" style={{ margin: 0 }}>
            Choose which active account/sheet receives each OpenChat chat. Chat identities stay
            private: they are never placed in this page&apos;s URL or shown here.
          </p>
        </div>
        <button className="secondary" disabled={loading || busyKey !== null} onClick={onRefresh}>
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
          No chat is waiting for setup. In OpenChat, propose an IOU action (or request private
          context on its card), then return to Chat details → AI apps → Open setup.
        </p>
      )}

      {rows.map((row) => {
        const selected = selections[row.internalKey] ?? "";
        const busy = busyKey === row.internalKey;
        const canRoute = row.isMostRecent;
        return (
          <div className="card" key={row.internalKey} style={{ marginTop: 12 }}>
            <h3 style={{ marginTop: 0 }}>{row.label}</h3>
            <p className="muted small">
              Requested {requestedAt(row.lastSeen)} from an authenticated IOU card.
              {row.hasCurrentLink
                ? " It already has a saved destination; you can reassign or remove it."
                : " Pick its destination."}
            </p>
            {!canRoute && (
              <p className="muted small">
                For safety, older anonymous requests cannot be reassigned here. Return to that
                chat and retry/open its IOU card so it becomes the most recent request.
              </p>
            )}
            <label>
              Account / sheet
              <select
                aria-label={`${row.label} account or sheet`}
                value={selected}
                disabled={busy || sheets.length === 0 || !canRoute}
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
              <button disabled={busy || selected === "" || !canRoute} onClick={() => onSave(row)}>
                {busy ? "Saving…" : row.hasCurrentLink ? "Save destination" : "Link chat"}
              </button>
              <button className="secondary" disabled={busy} onClick={() => onRemove(row)}>
                {row.hasCurrentLink && canRoute ? "Remove link" : "Dismiss"}
              </button>
            </div>
          </div>
        );
      })}
      {status && <p className="muted small">{status}</p>}
    </section>
  );
}

export function ChatRoutingSettings({ principal }: { principal: string }) {
  const { actor } = useActor();
  const { prefs } = usePreferences();
  const sectionRef = useRef<HTMLElement>(null);
  const [sheets, setSheets] = useState<ActiveRouteSheet[]>([]);
  const [pending, setPending] = useState<PendingChatRoute[]>([]);
  const [selections, setSelections] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const reloadGeneration = useRef(0);

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
    setStatus(null);
    try {
      const [pairWire, routableWire, pendingWire] = await Promise.all([
        actor.get_my_pairs(),
        actor.chat_routable_sheet_ids(),
        actor.pending_chat_routes(),
      ]);
      if (generation !== reloadGeneration.current) return;
      const routableIds = new Set<string>();
      for (const value of Array.isArray(routableWire) ? routableWire : []) {
        try {
          routableIds.add(nat64ToSheetId(BigInt(value as bigint)));
        } catch {
          // Ignore malformed values from a stale/mismatched declaration.
        }
      }
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
            return [{
              pendingId: candidate.pending_id,
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
            row.currentSheetId ??
              (nextSheets.length === 1 && row.isMostRecent ? nextSheets[0].sheetId : ""),
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
  }, [actor, prefs, principal]);

  useEffect(() => {
    void reload();
    return () => {
      reloadGeneration.current += 1;
    };
  }, [reload]);

  useEffect(() => {
    if (globalThis.location?.hash !== "#openchat-routing") return;
    sectionRef.current?.scrollIntoView({ block: "start" });
    sectionRef.current?.querySelector<HTMLSelectElement>("select")?.focus();
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
      setStatus("Chat destination saved. Retry/open the IOU card to load this account's types.");
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
      if (row.hasCurrentLink && row.isMostRecent) {
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
        row.hasCurrentLink && row.isMostRecent
          ? "Chat link removed."
          : "Recent chat request dismissed.",
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
      busyKey={busyKey}
      status={status}
      onSelect={(internalKey, sheetId) =>
        setSelections((current) => ({ ...current, [internalKey]: sheetId }))}
      onSave={(row) => void save(row)}
      onRemove={(row) => void remove(row)}
      onRefresh={() => void reload()}
    />
  );
}
