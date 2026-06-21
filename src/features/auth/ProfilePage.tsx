import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { IOUMark } from "../ui/Logo";

// /me — the profile/settings hub (formerly the home page): principal,
// links to Settings + Recovery key, and sign out. Reached from the
// accounts page's Settings button.
export function ProfilePage() {
  const { state, signOut } = useAuth();
  const nav = useNavigate();
  const [who, setWho] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/", { replace: true });
      return;
    }
    setWho(state.principal);
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

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

      <Link to="/pairs" className="muted">
        ← Accounts
      </Link>

      <div className="card">
        <h3>You are signed in</h3>
        <p className="muted" style={{ wordBreak: "break-all", fontFamily: "monospace" }}>
          {who}
        </p>
        <div className="cta-row" style={{ marginTop: 12 }}>
          <Link to="/settings">
            <button className="secondary">Settings</button>
          </Link>
          <Link to="/settings/recovery-key">
            <button className="secondary">Recovery key (optional)</button>
          </Link>
        </div>
      </div>
    </div>
  );
}
