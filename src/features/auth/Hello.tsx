import { useAuth } from "./AuthProvider";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { IOUWordmark, IOUMark } from "../ui/Logo";

type WhoAmIResult = string | null;

export function Hello() {
  const { state, signOut } = useAuth();
  const nav = useNavigate();
  const [who, setWho] = useState<WhoAmIResult>(null);

  useEffect(() => {
    if (state.kind === "authenticated") {
      setWho(state.principal);
    } else {
      setWho(null);
    }
  }, [state]);

  if (state.kind === "loading") {
    return <div className="muted">Loading…</div>;
  }

  if (state.kind === "anonymous") {
    return (
      <div className="card" style={{ textAlign: "center", marginTop: 80 }}>
        <h1 style={{ display: "flex", justifyContent: "center", margin: "8px 0 12px" }}>
          <IOUWordmark height={56} />
        </h1>
        <p className="muted">Track who owes whom. Encrypted. Yours only.</p>
        <div className="cta-row" style={{ justifyContent: "center" }}>
          <button onClick={() => nav("/sign-in")}>Sign in with Internet Identity</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 24 }}>
        <div className="row" style={{ gap: 10 }}>
          <IOUMark size={28} />
          <h1 style={{ margin: 0 }}>Hello.</h1>
        </div>
        <button className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>

      <div className="card">
        <h3>You are signed in</h3>
        <p className="muted" style={{ wordBreak: "break-all", fontFamily: "monospace" }}>
          {who}
        </p>
        <div className="cta-row" style={{ marginTop: 12 }}>
          <Link to="/settings/recovery-key">
            <button className="secondary">Recovery key (optional)</button>
          </Link>
        </div>
      </div>

      <div className="card">
        <h3>What's next?</h3>
        <p className="muted">
          Set up a pair with someone, then create a sheet to start tracking
          IOUs in your chosen currencies.
        </p>
        <div className="cta-row">
          <Link to="/pairs">
            <button>Go to my pairs</button>
          </Link>
        </div>
      </div>
    </div>
  );
}
