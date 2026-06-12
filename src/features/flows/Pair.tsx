import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor, unwrap } from "./useActor";

export function Pair() {
  const { pairId } = useParams<{ pairId: string }>();
  const { state } = useAuth();
  const { actor } = useActor();
  const nav = useNavigate();
  const [pair, setPair] = useState<any | null>(null);
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
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [actor, state, nav, pairId]);

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
      <div className="cta">
        <Link to={`/sheet/new?pairId=${pairId}`}>
          <button>+ New sheet</button>
        </Link>
      </div>
      <p className="muted" style={{ marginTop: 16 }}>
        Sheet view is coming in Phase 3.
      </p>
    </div>
  );
}
