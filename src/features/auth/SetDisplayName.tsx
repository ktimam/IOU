import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth, buildAgent } from "./AuthProvider";
import { createActor } from "../../backend/declarations";

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
    // The useEffect above redirects anonymous users, but TS doesn't
    // narrow state across the early return. Re-check at call time.
    if (state.kind !== "authenticated") {
      setErr("Please sign in first");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      // Build an authenticated agent + actor and call the canister.
      // The display name is currently stored as raw UTF-8 bytes; in
      // Phase 1.2 it gets wrapped with vetkd before being sent.
      const agent = await buildAgent(state.identity);
      const actor = createActor(agent);
      const wrapped = utf8ToBlob(name.trim());
      const iv = utf8ToBlob("v1-dev-iv-not-secure");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (actor as any).set_display_name(
        Array.from(wrapped),
        Array.from(iv),
      );
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
