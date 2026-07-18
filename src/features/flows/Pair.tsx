import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "./useActor";
import { useSheetKey } from "./SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import { useToasts } from "../ui/Toasts";
import { encryptName } from "../crypto/devVetkd";

const ANON = "2vxsx-fae";

export function Pair() {
  const { pairId } = useParams<{ pairId: string }>();
  const { state } = useAuth();
  const { actor } = useActor();
  const { unwrapFor } = useSheetKey();
  const { prefs, cacheAccountName } = usePreferences();
  const toasts = useToasts();
  const nav = useNavigate();
  const [pair, setPair] = useState<any | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [archivedCount, setArchivedCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  // Lifecycle confirmations (leave / archive / delete).
  const [confirm, setConfirm] = useState<null | "leave" | "delete">(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [deleteText, setDeleteText] = useState("");

  useEffect(() => {
    // Redirect only when DEFINITIVELY anonymous — never during "loading" (avoids the refresh /
    // deep-link bounce through /sign-in). While loading, fall through and wait.
    if (state.kind === "anonymous") {
      nav("/sign-in", { replace: true });
      return;
    }
    if (state.kind !== "authenticated" || !actor || !pairId) return;
    setLoading(true);
    (async () => {
      try {
        const p = unwrap(await actor.get_pair(pairId));
        if (!p) {
          setError("You're not a member of this pair.");
          setPair(null);
        } else {
          setPair(p);
          // Find the active sheet + archived count for this pair (if any).
          const summaries = await actor.get_my_pairs();
          const sum = (summaries as any[]).find((s) => s.id === pairId);
          setActiveSheetId(sum ? unwrap(sum.active_sheet_id) : null);
          setArchivedCount(Number(sum?.archived_sheet_count ?? 0));
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, state, nav, pairId]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) {
    return (
      <div>
        <p style={{ color: "var(--debt)" }}>{error}</p>
        <Link to="/pairs">Back to accounts</Link>
      </div>
    );
  }
  if (!pair) return <p className="muted">No pair.</p>;

  // A pair is only "shared" once a second member has joined. Until then
  // members[1] is the anonymous principal (2vxsx-fae).
  const partner = pair.members?.[1];
  const partnerText =
    partner && typeof partner.toText === "function"
      ? partner.toText()
      : String(partner ?? "");
  const hasPartner = partnerText !== "" && partnerText !== ANON;
  const isArchived = unwrap(pair.archived_at) != null;

  async function saveAccountName() {
    if (!actor || !activeSheetId || !pairId) return;
    setRenameBusy(true);
    try {
      // Account names are E2E-encrypted under the active sheet's K_sheet.
      const K = await unwrapFor(activeSheetId);
      const { enc, iv } = await encryptName(K, nameDraft.trim());
      await actor.set_pair_name(pairId, enc, iv);
      cacheAccountName(pairId, nameDraft.trim());
      setRenaming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRenameBusy(false);
    }
  }

  async function doArchive(archived: boolean) {
    if (!actor || !pairId) return;
    setActionBusy(true);
    try {
      await (actor as any)[archived ? "archive_pair" : "unarchive_pair"](pairId);
      toasts.show({
        kind: "success",
        text: archived ? "Account archived" : "Account unarchived",
      });
      if (archived) nav("/pairs", { replace: true });
      else setPair({ ...pair, archived_at: [] });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setActionBusy(false);
    }
  }

  async function doLeave() {
    if (!actor || !pairId) return;
    setActionBusy(true);
    try {
      await (actor as any).leave_pair(pairId);
      toasts.show({ kind: "success", text: "You left the account" });
      nav("/pairs", { replace: true });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setActionBusy(false);
      setConfirm(null);
    }
  }

  async function doDelete() {
    if (!actor || !pairId) return;
    setActionBusy(true);
    try {
      await (actor as any).delete_pair(pairId);
      toasts.show({ kind: "success", text: "Account deleted permanently" });
      nav("/pairs", { replace: true });
    } catch (e) {
      toasts.show({ kind: "error", text: (e as Error).message });
    } finally {
      setActionBusy(false);
      setConfirm(null);
    }
  }

  const accountName =
    (pairId && prefs.accountNames[pairId]) || `Account ${pairId?.slice(0, 12)}…`;

  return (
    <div>
      <Link to="/pairs" className="muted">
        ← All accounts
      </Link>
      {renaming ? (
        <div className="row" style={{ gap: 8, alignItems: "center", margin: "8px 0" }}>
          <input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            maxLength={48}
            placeholder="Account name"
            autoFocus
          />
          <button
            className="small"
            onClick={() => void saveAccountName()}
            disabled={renameBusy || !nameDraft.trim()}
          >
            {renameBusy ? "Saving…" : "Save"}
          </button>
          <button
            className="secondary small"
            onClick={() => setRenaming(false)}
            disabled={renameBusy}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, alignItems: "center" }}>
          <h1 style={{ margin: 0 }}>{accountName}</h1>
          {isArchived && <span className="pill muted">📦 Archived</span>}
          {activeSheetId && (
            <button
              className="secondary small"
              onClick={() => {
                setNameDraft(prefs.accountNames[pairId ?? ""] ?? "");
                setRenaming(true);
              }}
            >
              Rename
            </button>
          )}
        </div>
      )}
      <p className="muted" style={{ fontSize: "0.875rem" }}>
        Created {new Date(Number(pair.created_at) / 1_000_000).toLocaleString()}
        {hasPartner ? " · 2 members" : " · solo"}
      </p>

      {activeSheetId ? (
        <div className="cta">
          <Link to={`/sheet/${activeSheetId}`}>
            <button>Open active sheet →</button>
          </Link>
        </div>
      ) : (
        <div>
          <div className="cta">
            <Link to={`/sheet/new?pairId=${pairId}`}>
              <button>+ New sheet</button>
            </Link>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Start a sheet, then invite a partner from the sheet itself — they'll
            join instantly from your invite link.
          </p>
        </div>
      )}

      {archivedCount > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          <Link to={`/pair/${pairId}/archived`}>
            📦 {archivedCount} archived sheet
            {archivedCount === 1 ? "" : "s"}
          </Link>
        </p>
      )}

      {/* Account lifecycle controls. */}
      <div className="cta-row" style={{ marginTop: 24 }}>
        {isArchived ? (
          <>
            <button
              className="secondary"
              disabled={actionBusy}
              onClick={() => void doArchive(false)}
            >
              Unarchive
            </button>
            {hasPartner && (
              <button
                className="secondary"
                disabled={actionBusy}
                onClick={() => setConfirm("leave")}
              >
                Leave
              </button>
            )}
            {!hasPartner && (
              <button
                className="danger"
                disabled={actionBusy}
                onClick={() => {
                  setDeleteText("");
                  setConfirm("delete");
                }}
              >
                Delete forever
              </button>
            )}
          </>
        ) : (
          <>
            {hasPartner && (
              <button
                className="secondary"
                disabled={actionBusy}
                onClick={() => setConfirm("leave")}
              >
                Leave
              </button>
            )}
            <button
              className="secondary"
              disabled={actionBusy}
              onClick={() => void doArchive(true)}
            >
              Archive
            </button>
          </>
        )}
      </div>

      {confirm === "leave" && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2>Leave this account?</h2>
            <p className="muted">
              You'll lose access to its sheets. The other member keeps
              everything. This can't be undone (you'd need a fresh invite to
              rejoin).
            </p>
            <div className="cta-row">
              <button
                className="secondary"
                onClick={() => setConfirm(null)}
                disabled={actionBusy}
              >
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => void doLeave()}
                disabled={actionBusy}
              >
                {actionBusy ? "Leaving…" : "Leave account"}
              </button>
            </div>
          </div>
        </div>
      )}

      {confirm === "delete" && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h2>Delete this account forever?</h2>
            <p className="muted">
              This permanently erases the account and every sheet, entry, and
              record in it. It cannot be recovered. Type <b>DELETE</b> to
              confirm.
            </p>
            <input
              value={deleteText}
              onChange={(e) => setDeleteText(e.target.value)}
              placeholder="DELETE"
              autoFocus
            />
            <div className="cta-row">
              <button
                className="secondary"
                onClick={() => setConfirm(null)}
                disabled={actionBusy}
              >
                Cancel
              </button>
              <button
                className="danger"
                onClick={() => void doDelete()}
                disabled={actionBusy || deleteText.trim() !== "DELETE"}
              >
                {actionBusy ? "Deleting…" : "Delete forever"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
