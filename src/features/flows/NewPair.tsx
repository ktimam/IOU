import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "./useActor";
import { deriveUserKeypair } from "../crypto/devVetkd";

export function NewPair() {
  const { state } = useAuth();
  const { actor, err } = useActor();
  const nav = useNavigate();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdInvite, setCreatedInvite] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

  async function doCreate() {
    if (!actor) return;
    setBusy(true);
    setError(null);
    try {
      const out = await actor.create_pair();
      setCreatedInvite(out.invite_code);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doJoin() {
    if (!actor || !inviteCode.trim()) {
      setError("Enter an invite code");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pairId = await actor.join_pair(inviteCode.trim());
      // Publish my wrap pubkey on-canister so the creator can seal K_sheet
      // to me when they grant access (dev path; harmless in prod).
      if (state.kind === "authenticated") {
        try {
          const myKp = await deriveUserKeypair(
            state.identity.getPrincipal().toText(),
          );
          await actor.register_sheet_pubkey(
            Array.from(new TextEncoder().encode(myKp.publicKeyB64)),
          );
        } catch {
          /* non-fatal */
        }
      }
      nav(`/pair/${pairId}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>Set up a pair</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <button
          className={mode === "create" ? "" : "secondary"}
          onClick={() => setMode("create")}
        >
          Create
        </button>
        <button
          className={mode === "join" ? "" : "secondary"}
          onClick={() => setMode("join")}
        >
          Join
        </button>
      </div>

      {err && <p style={{ color: "var(--debt)" }}>Actor error: {err}</p>}

      {mode === "create" && !createdInvite && (
        <div className="card">
          <p className="muted">
            Start a new pair. You'll get an invite code to share with your
            partner.
          </p>
          <div className="cta">
            <button onClick={doCreate} disabled={busy}>
              {busy ? "Creating…" : "Create pair"}
            </button>
          </div>
        </div>
      )}

      {mode === "create" && createdInvite && (
        <div className="card">
          <h2>Share this code with your partner</h2>
          <div
            className="row"
            style={{
              fontSize: "1.5rem",
              fontWeight: 700,
              letterSpacing: "0.1em",
              margin: "16px 0",
            }}
          >
            {createdInvite}
          </div>
          <button
            className="secondary"
            onClick={() => {
              navigator.clipboard?.writeText(createdInvite);
            }}
          >
            Copy
          </button>
          <p className="muted" style={{ marginTop: 16 }}>
            The code is good for one use. After your partner joins, you'll
            see them in your pairs list.
          </p>
          <div className="cta">
            <Link to="/pairs">
              <button>Go to my pairs</button>
            </Link>
          </div>
        </div>
      )}

      {mode === "join" && (
        <div className="card">
          <p className="muted">
            Enter the invite code your partner shared with you.
          </p>
          <div className="col">
            <label htmlFor="invite">Invite code</label>
            <input
              id="invite"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              maxLength={9}
            />
          </div>
          {error && <p style={{ color: "var(--debt)" }}>{error}</p>}
          <div className="cta">
            <button onClick={doJoin} disabled={busy || !inviteCode.trim()}>
              {busy ? "Joining…" : "Join pair"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
