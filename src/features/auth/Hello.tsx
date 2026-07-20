import { useAuth } from "./AuthProvider";
import { Navigate, useNavigate } from "react-router-dom";
import { IOUWordmark } from "../ui/Logo";

// Landing route ("/"). When signed in, home IS the accounts page, so
// redirect there. The profile/settings hub lives at /settings.
export function Hello() {
  const { state } = useAuth();
  const nav = useNavigate();

  if (state.kind === "loading") {
    return <div className="muted">Loading…</div>;
  }

  if (state.kind === "authenticated") {
    return <Navigate to="/pairs" replace />;
  }

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
