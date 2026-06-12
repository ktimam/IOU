import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useEffect } from "react";

export function SignIn() {
  const { state, signIn } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    if (state.kind === "authenticated") {
      nav("/", { replace: true });
    }
  }, [state, nav]);

  return (
    <div className="card" style={{ textAlign: "center", marginTop: 80 }}>
      <h1>IOU</h1>
      <p className="muted">Track who owes whom. Encrypted. Yours only.</p>
      <div className="cta-row" style={{ justifyContent: "center" }}>
        <button
          onClick={async () => {
            try {
              await signIn();
            } catch (e) {
              console.error(e);
            }
          }}
        >
          Sign in with Internet Identity
        </button>
      </div>
      <p className="muted" style={{ marginTop: 24, fontSize: "0.875rem" }}>
        No email. No password. No one — not even us — can read your data.
      </p>
    </div>
  );
}
