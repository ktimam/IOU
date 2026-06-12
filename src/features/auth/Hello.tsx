import { useAuth } from "./AuthProvider";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

type WhoAmIResult = string | null;

export function Hello() {
  const { state, signIn, signOut } = useAuth();
  const nav = useNavigate();
  const [who, setWho] = useState<WhoAmIResult>(null);

  useEffect(() => {
    // Stub: whoami would be called via the actor. Until Candid types
    // are generated, we just show the principal from the auth state.
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
        <h1>IOU</h1>
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
        <h1>Hello.</h1>
        <button className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>

      <div className="card">
        <h3>You are signed in</h3>
        <p className="muted" style={{ wordBreak: "break-all", fontFamily: "monospace" }}>
          {who}
        </p>
      </div>

      <div className="card">
        <h3>What's next?</h3>
        <p className="muted">
          Phase 1 lands you on this "hello" page after sign-in. Phase 2
          adds pair setup, Phase 3 adds the entries, Phase 4 adds the
          rest of the v1.0 product.
        </p>
        <button
          onClick={() => void signIn()}
          style={{ marginTop: 12 }}
        >
          Re-authenticate (test)
        </button>
      </div>
    </div>
  );
}
