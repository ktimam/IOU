import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "./useActor";
import { usePreferences } from "../settings/usePreferences";

interface PairSummary {
  id: string;
  other_principal: any;
  active_sheet_id?: any;
  archived_sheet_count: number;
  created_at: bigint;
}

function principalToText(p: any): string {
  if (!p) return "(unknown)";
  if (typeof p.toText === "function") return p.toText();
  if (typeof p === "string") return p;
  return JSON.stringify(p);
}

function optToString(opt: any): string | null {
  const v = unwrap(opt);
  if (!v) return null;
  if (typeof v === "string") return v;
  return v.id ?? null;
}

export function Pairs() {
  const { state } = useAuth();
  const { actor, err } = useActor();
  const { prefs } = usePreferences();
  const nav = useNavigate();
  const [pairs, setPairs] = useState<PairSummary[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (state.kind === "anonymous") {
      nav("/sign-in", { replace: true });
      return;
    }
    if (state.kind !== "authenticated") return; // "loading" — wait for auth to resolve, don't bounce
    if (!actor) return;
    setLoading(true);
    (async () => {
      try {
        const list = await actor.get_my_pairs();
        setPairs(Array.isArray(list) ? list : []);
      } catch (e) {
        setPairs(null);
        console.error("get_my_pairs failed", e);
      } finally {
        setLoading(false);
      }
    })();
  }, [actor, state, nav]);

  return (
    <div>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 16 }}
      >
        <h1>Your accounts</h1>
        <div className="row" style={{ gap: 8 }}>
          <button
            className="secondary"
            onClick={() => nav("/me")}
            title="Settings & profile"
          >
            ⚙ Settings
          </button>
          <button onClick={() => nav("/pair/new")}>+ New account</button>
        </div>
      </div>

      {err && <p style={{ color: "var(--debt)" }}>Actor error: {err}</p>}
      {loading && <p className="muted">Loading…</p>}
      {pairs && pairs.length === 0 && (
        <div className="card">
          <p className="muted">
            You don't have any accounts yet. Create one to start tracking
            IOUs and settlements with someone.
          </p>
        </div>
      )}
      {pairs && pairs.length > 0 && (
        <div className="col">
          {pairs.map((p) => {
            const other = principalToText(p.other_principal);
            const activeSheet = optToString(p.active_sheet_id);
            const accountName = prefs.accountNames[p.id] || "";
            const partnerName = prefs.partnerNames[p.id] || "";
            // Account name if known; else partner's name; else principal.
            const title = accountName || partnerName || `${other.slice(0, 12)}…`;
            const subtitle = accountName
              ? partnerName || other
              : partnerName
                ? other
                : "";
            // Opening an account jumps straight to its active sheet; if
            // there's none yet (e.g. joiner awaiting access), open details.
            const to = activeSheet ? `/sheet/${activeSheet}` : `/pair/${p.id}`;
            return (
              <Link
                key={p.id}
                to={to}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="card" style={{ cursor: "pointer" }}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div>
                      <h3>{title}</h3>
                      {subtitle && (
                        <p className="muted" style={{ fontSize: "0.875rem" }}>
                          {subtitle}
                        </p>
                      )}
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <span className="muted">
                        {activeSheet ? "Open →" : "No active sheet"}
                      </span>
                      {p.archived_sheet_count > 0 && (
                        <p className="muted" style={{ fontSize: "0.875rem" }}>
                          + {p.archived_sheet_count} archived
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
