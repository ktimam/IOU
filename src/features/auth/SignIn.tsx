import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";
import { useEffect } from "react";
import { IOUWordmark } from "../ui/Logo";

export function SignIn() {
  const { state, signIn, signInDev } = useAuth();
  const nav = useNavigate();

  useEffect(() => {
    if (state.kind === "authenticated") {
      nav("/", { replace: true });
    }
  }, [state, nav]);

  return (
    <div className="card" style={{ textAlign: "center", marginTop: 80 }}>
      <h1 style={{ display: "flex", justifyContent: "center", margin: "8px 0 12px" }}>
        <IOUWordmark height={56} />
      </h1>
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
      {import.meta.env.DEV && (
        <div className="cta-row" style={{ justifyContent: "center", marginTop: 12 }}>
          <button
            className="secondary"
            onClick={async () => {
              try {
                await signInDev();
              } catch (e) {
                console.error(e);
              }
            }}
          >
            Sign in (dev — local identity)
          </button>
        </div>
      )}
      <p className="muted" style={{ marginTop: 24, fontSize: "0.875rem" }}>
        No email. No password. No one — not even us — can read your data.
      </p>
      {import.meta.env.DEV && (
        <p className="muted" style={{ fontSize: "0.75rem", marginTop: 4 }}>
          The dev sign-in is for local dev only. It creates a
          Secp256k1 identity in your browser's localStorage; sign
          out to clear it. For production, use Internet Identity.
        </p>
      )}
    </div>
  );
}
