// /settings — the profile & settings hub (merged with the former /me page).
//
// Sign-out and your principal (formerly /me), plus your username
// and default currency. The username is your single, global name: on save it
// publishes EAGERLY to every account you're in (E2E under each K_sheet, one
// set_member_name per active sheet) so every partner immediately sees "manager"
// instead of your principal — and future accounts pick it up on create/open.
// Reached from the username badge in the top-right of every page. Transaction
// types/templates are managed from the "Add type" button on a sheet, not here.

import { useState } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "./usePreferences";
import { orderedCurrencies } from "./currencies";
import { useAuth } from "../auth/AuthProvider";
import { SignInButtons } from "../auth/SignInButtons";
import { useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { publishUsernameToAllPairs } from "../flows/createSheet";
import { IOUMark } from "../ui/Logo";
import { RelaySettings } from "../relay/RelaySettings";
import { OpenChatSettings } from "../openchat/OpenChatSettings";

export function SettingsPage() {
  const { state, signOut } = useAuth();
  const { prefs, setDefaultCurrency, setProfileName } = usePreferences();
  const { actor } = useActor();
  const { unwrapFor } = useSheetKey();
  const [name, setName] = useState(prefs.profileName);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveUsername() {
    const trimmed = name.trim();
    setBusy(true);
    setStatus(null);
    // Persist locally first (so create/open of future accounts uses it too)…
    setProfileName(trimmed);
    // …then eagerly push it to every existing account.
    try {
      if (!actor) {
        setStatus("Saved. It’ll publish when you next open an account.");
      } else if (!trimmed) {
        setStatus("Cleared.");
      } else {
        const { published, total } = await publishUsernameToAllPairs(
          actor,
          unwrapFor,
          trimmed,
        );
        setStatus(
          total === 0
            ? "Saved. It’ll publish to accounts as you create them."
            : `Saved and published to ${published} of ${total} account${total === 1 ? "" : "s"}.`,
        );
      }
    } catch (e) {
      setStatus(
        "Saved locally, but publishing to accounts failed: " +
          String((e as Error)?.message ?? e).slice(0, 120),
      );
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") return <p className="muted">Loading…</p>;

  if (state.kind !== "authenticated") {
    // Render sign-in INLINE (like LinkChatPage) rather than redirecting to "/": a redirect drops
    // the URL and its #openchat-connect hash, so an unsigned visitor — e.g. the OpenChat "Open the
    // code page in IOU" button opening a fresh (or desktop-external) browser tab that isn't signed
    // into IOU — would be bounced to the landing page instead of the Connect section. Signing in
    // here keeps /settings#openchat-connect, so the page re-renders authenticated and scrolls to it.
    return (
      <div className="card" style={{ textAlign: "center", marginTop: 24 }}>
        <h2>Settings</h2>
        <p className="muted">Sign in to manage your account and connect OpenChat.</p>
        <SignInButtons />
      </div>
    );
  }

  return (
    <div>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 16 }}
      >
        <div className="row" style={{ gap: 10 }}>
          <IOUMark size={28} />
          <h1 style={{ margin: 0 }}>Settings</h1>
        </div>
        <button className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </div>

      <Link to="/pairs" className="muted">
        ← Accounts
      </Link>

      <div className="card">
        <h2>Username</h2>
        <p className="muted small">
          Your single, global name. Partners see this on shared accounts
          instead of your principal. Stored end-to-end encrypted; on save it
          publishes to every account you’re in and to any you join later.
        </p>
        <input
          maxLength={32}
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setStatus(null);
          }}
        />
        <span className="lock-cue">🔒 published encrypted to every account</span>
        <div className="cta">
          <button disabled={busy} onClick={saveUsername}>
            {busy ? "Publishing…" : "Save username"}
          </button>
        </div>
        {status && <p className="muted small">{status}</p>}
      </div>

      <div className="card">
        <h2>Default currency</h2>
        <p className="muted small">
          Pre-selected when you add entries or create an account.
        </p>
        <select
          value={prefs.defaultCurrency}
          onChange={(e) => setDefaultCurrency(e.target.value)}
        >
          {orderedCurrencies(prefs.defaultCurrency).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="card">
        <h3>You are signed in</h3>
        <p
          className="muted"
          style={{ wordBreak: "break-all", fontFamily: "monospace" }}
        >
          {state.principal}
        </p>
      </div>

      <RelaySettings />
      <OpenChatSettings />
    </div>
  );
}
