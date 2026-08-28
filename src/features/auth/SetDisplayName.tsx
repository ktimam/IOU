import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth, buildAgent } from "./AuthProvider";
import { createActor } from "../../backend/declarations";
import { usePreferences } from "../settings/usePreferences";
import {
  normalizeProfileName,
  persistEncryptedProfileName,
} from "../settings/profileName";

export function SetDisplayName() {
  const { state } = useAuth();
  const { setProfileName } = usePreferences();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Redirect only when definitively anonymous — never during "loading" (avoids the refresh bounce).
    if (state.kind === "anonymous") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

  async function submit() {
    const normalized = normalizeProfileName(name);
    if (normalized === undefined) {
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
      // Build an authenticated actor, derive the account's existing prod/dev user key, and send
      // only fresh AES-GCM ciphertext. The obsolete plaintext sentinel is never written again.
      const agent = await buildAgent(state.identity);
      const actor = createActor(agent);
      await persistEncryptedProfileName(actor as any, state.principal, normalized);
      setProfileName(normalized);
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
