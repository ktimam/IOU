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
  const [archivedCount, setArchivedCount] = useState<number>(0);
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
          setArchivedCount(Number(sum?.archived_sheet_count ?? 0));
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

  // A pair is only "active" once a second member has joined. Until then
  // members[1] is the anonymous principal (2vxsx-fae) and the backend
  // rejects create_sheet ("pair is not active"). Detect it so we offer the
  // invite flow instead of a button that traps.
  const ANON = "2vxsx-fae";
  const partner = pair.members?.[1];
  const partnerText =
    partner && typeof partner.toText === "function"
      ? partner.toText()
      : String(partner ?? "");
  const pairActive = partnerText !== "" && partnerText !== ANON;

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
      ) : pairActive ? (
        <div className="cta">
          <Link to={`/sheet/new?pairId=${pairId}`}>
            <button>+ New sheet</button>
          </Link>
        </div>
      ) : (
        <div className="card">
          <h3>Waiting for your partner</h3>
          <p className="muted">
            An IOU sheet is shared between two people. Share the invite code
            above with your partner — once they join, you can start a sheet
            together.
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
      <div className="card small">
        <p className="muted">Your public key (share with partner if needed)</p>
        <code style={{ wordBreak: "break-all", fontSize: "0.75rem" }}>
          {myKp?.publicKeyB64 ?? "(loading…)"}
        </code>
      </div>
      <div className="cta-row">
        <Link to={`/pair/${pairId}/replace`}>
          <button className="secondary">Replace member (leaving)</button>
        </Link>
        <Link to={`/pair/${pairId}/accept-replace`}>
          <button className="secondary">Accept replacement (staying)</button>
        </Link>
      </div>
    </div>
  );
}
