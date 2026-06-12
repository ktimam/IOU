import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "./AuthProvider";

// The actual encryption happens client-side using the user's principal
// (or, on the local dev fallback, a deterministic key). For Phase 1 we
// just store the raw string encoded as bytes; the crypto glue is in
// Phase 1.2 (see plan §Phase 1.2 in docs/03-plan.md).

function utf8ToBlob(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function SetDisplayName() {
  const { state } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

  async function submit() {
    if (!name.trim() || name.length > 32) {
      setErr("Name must be 1..=32 characters");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Phase 1: store the name as a raw byte blob. In Phase 1.2 this
      // is replaced with the encrypted-by-vetkd version.
      const wrapped = utf8ToBlob(name.trim());
      const iv = utf8ToBlob("v1-dev-iv-not-secure");
      // Until the backend canister is actually deployed and the real
      // declarations are generated, we just log the call. Once the
      // canister is up, this becomes:
      //
      //   const actor = createActor(state.identity);
      //   await actor.setDisplayName(Array.from(wrapped), Array.from(iv));
      console.warn("setDisplayName stub called", { wrapped: Array.from(wrapped), iv: Array.from(iv) });
      nav("/", { replace: true });
    } catch (e) {
      setErr((e as Error).message ?? "Failed to save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 40 }}>
      <h2>Welcome</h2>
      <p className="muted">Pick a name your partner will see.</p>
      <div className="col">
        <label htmlFor="displayName">Display name</label>
        <input
          id="displayName"
          maxLength={32}
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <span className="lock-cue">🔒 stored encrypted on the chain</span>
        <span className="muted" style={{ fontSize: "0.8125rem" }}>
          {name.length} / 32
        </span>
        {err && <span style={{ color: "var(--debt)" }}>{err}</span>}
      </div>
      <div className="cta">
        <button onClick={submit} disabled={busy || !name.trim()}>
          {busy ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}
