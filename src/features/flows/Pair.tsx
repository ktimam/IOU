import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "./useActor";
import { useMyKeypair } from "./useMyKeypair";
import { useSheetKey } from "./SheetKeyContext";

export function Pair() {
  const { pairId } = useParams<{ pairId: string }>();
  const { state } = useAuth();
  const { actor } = useActor();
  const { keypair: myKp } = useMyKeypair();
  const { registerPartnerKey } = useSheetKey();
  const nav = useNavigate();
  const [pair, setPair] = useState<any | null>(null);
  const [activeSheetId, setActiveSheetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/sign-in", { replace: true });
      return;
    }
    if (!actor || !pairId) return;
    setLoading(true);
    (async () => {
      try {
        const p = unwrap(await actor.get_pair(pairId));
        if (!p) {
          setError("You're not a member of this pair.");
          setPair(null);
        } else {
          setPair(p);
          // Find the active sheet for this pair (if any).
          const summaries = await actor.get_my_pairs();
          const sum = (summaries as any[]).find((s) => s.id === pairId);
          const sid = sum ? unwrap(sum.active_sheet_id) : null;
          setActiveSheetId(sid);
          // Register my own public key under the active sheet so the
          // partner can use it as the wrap-sender.
          if (sid && myKp) {
            registerPartnerKey(sid, myKp.publicKeyB64);
          }
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actor, state, nav, pairId, myKp?.publicKeyB64]);

  if (loading) return <p className="muted">Loading…</p>;
  if (error) {
    return (
      <div>
        <p style={{ color: "var(--debt)" }}>{error}</p>
        <Link to="/pairs">Back to pairs</Link>
      </div>
    );
  }
  if (!pair) return <p className="muted">No pair.</p>;

  return (
    <div>
      <Link to="/pairs" className="muted">
        ← All pairs
      </Link>
      <h1>Pair {pairId?.slice(0, 12)}…</h1>
      <div className="card">
        <p className="muted">Invite code</p>
        <h2>{pair.invite_code}</h2>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Created {new Date(Number(pair.created_at) / 1_000_000).toLocaleString()}
        </p>
      </div>
      {activeSheetId ? (
        <div className="cta">
          <Link to={`/sheet/${activeSheetId}`}>
            <button>Open active sheet →</button>
          </Link>
        </div>
      ) : (
        <div className="cta">
          <Link to={`/sheet/new?pairId=${pairId}`}>
            <button>+ New sheet</button>
          </Link>
        </div>
      )}
      <div className="card small">
        <p className="muted">Your public key (share with partner if needed)</p>
        <code style={{ wordBreak: "break-all", fontSize: "0.75rem" }}>
          {myKp?.publicKeyB64 ?? "(loading…)"}
        </code>
      </div>
    </div>
  );
}
