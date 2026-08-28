// /settings — the profile & settings hub (merged with the former /me page).
//
// Sign-out and your principal (formerly /me), plus your username
// and default currency. The username is your single, global name: on save it
// publishes EAGERLY to every account you're in (E2E under each K_sheet, one
// set_member_name per active sheet) so every partner immediately sees "manager"
// instead of your principal — and future accounts pick it up on create/open.
// Reached from the username badge in the top-right of every page. Transaction
// types/templates are managed from the "Add type" button on a sheet, not here.

import { useCallback, useEffect, useState } from "react";
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
import { RelayPairingCard } from "../openchat/OpenChatSettings";
import { ActionInboxSettings } from "../openchat/ActionInboxSettings";
import { ChatRoutingSettings } from "../openchat/ChatRoutingSettings";
import {
  captureOpenChatRoutingLaunch,
  clearOpenChatRoutingLaunch,
} from "../openchat/chatLinkLaunch";
import {
  normalizeProfileName,
  persistEncryptedProfileName,
} from "./profileName";

export function SettingsPage() {
  // Capture before the auth branch: the OS default browser may be signed out or signed in as a
  // different IOU user. The fragment is scrubbed immediately and retained only in process memory
  // while the user switches to the account whose OpenChat binding matches it.
  const [chatLinkToken, setChatLinkToken] = useState(captureOpenChatRoutingLaunch);
  useEffect(() => {
    const captureLaunch = () => setChatLinkToken(captureOpenChatRoutingLaunch());
    window.addEventListener("hashchange", captureLaunch);
    return () => window.removeEventListener("hashchange", captureLaunch);
  }, []);
  const finishChatLinkToken = useCallback((token: string) => {
    clearOpenChatRoutingLaunch(token);
    setChatLinkToken((current) => (current === token ? null : current));
  }, []);
  const { state, signOut } = useAuth();
  const { prefs, setDefaultCurrency, setProfileName } = usePreferences();
  const { actor } = useActor();
  const { unwrapFor } = useSheetKey();
  const [name, setName] = useState(prefs.profileName);
  const [nameDirty, setNameDirty] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // ProfileNameSync may hydrate after this page first renders. Adopt it unless the user has already
  // started typing; a slow canister read must never replace an in-progress edit.
  useEffect(() => {
    if (!nameDirty) setName(prefs.profileName);
  }, [prefs.profileName, nameDirty]);

  // Local first so every picker updates instantly, then persist to the canister so the choice
  // follows the user to their other devices (DefaultCurrencySync pulls it on load there).
  async function saveDefaultCurrency(code: string) {
    setDefaultCurrency(code);
    setStatus(null);
    if (!actor) return;
    try {
      await actor.set_default_currency(code);
    } catch (e) {
      // The local value still applies on this device; surface the failure rather than pretending.
      setStatus(`Saved on this device only — could not reach your account: ${(e as Error).message}`);
    }
  }

  async function saveUsername() {
    const trimmed = normalizeProfileName(name);
    if (trimmed === undefined) {
      setStatus("Username must be 1 to 32 characters.");
      return;
    }
    if (state.kind !== "authenticated") {
      setStatus("Sign in before saving your username.");
      return;
    }
    setBusy(true);
    setStatus(null);
    // Persist locally first so future account creation and an offline retry use the same value.
    setProfileName(trimmed);
    setName(trimmed);
    setNameDirty(false);
    if (!actor) {
      setStatus("Saved on this device only — your account connection is not ready.");
      setBusy(false);
      return;
    }

    let accountError: string | undefined;
    let publishError: string | undefined;
    let published = 0;
    let total = 0;
    try {
      await persistEncryptedProfileName(actor, state.principal, trimmed);
    } catch (error) {
      accountError = String((error as Error)?.message ?? error).slice(0, 120);
    }
    try {
      ({ published, total } = await publishUsernameToAllPairs(
        actor,
        unwrapFor,
        trimmed,
      ));
    } catch (error) {
      publishError = String((error as Error)?.message ?? error).slice(0, 120);
    }

    if (accountError !== undefined && publishError !== undefined) {
      setStatus(
        `Saved on this device, but encrypted account sync failed (${accountError}) and publishing to accounts failed (${publishError}).`,
      );
    } else if (accountError !== undefined) {
      setStatus(
        `Published to ${published} of ${total} account${total === 1 ? "" : "s"}, but encrypted account sync failed: ${accountError}`,
      );
    } else if (publishError !== undefined) {
      setStatus(`Saved to your encrypted account, but publishing failed: ${publishError}`);
    } else {
      setStatus(
        total === 0
          ? "Saved to your encrypted account. It’ll publish to accounts as you create them."
          : `Saved to your encrypted account and published to ${published} of ${total} account${total === 1 ? "" : "s"}.`,
      );
    }
    setBusy(false);
  }

  if (state.kind === "loading") return <p className="muted">Loading…</p>;

  if (state.kind !== "authenticated") {
    // Render sign-in INLINE rather than redirecting to "/": a redirect drops
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
            setNameDirty(true);
            setStatus(null);
          }}
        />
        <span className="lock-cue">🔒 encrypted on your account and shared accounts</span>
        <div className="cta">
          <button disabled={busy} onClick={saveUsername}>
            {busy ? "Saving…" : "Save username"}
          </button>
        </div>
        {status && <p className="muted small">{status}</p>}
      </div>

      <div className="card">
        <h2>Default currency</h2>
        <p className="muted small">
          Your one default, used everywhere: pre-selected on every entry, on new accounts and
          sheets, and applied to anything you import from a chat that names no currency. Sheets have
          no currency of their own — any entry can use any currency. Saved to your account, so it
          follows you to your other devices.
        </p>
        <select
          value={prefs.defaultCurrency}
          onChange={(e) => void saveDefaultCurrency(e.target.value)}
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

      {/* The OpenChat card: the claim-token Connect flow is the only default-visible integration
          surface. Admin/debug surfaces AND the legacy off-chain relay cards (passed as children)
          sit behind its "Advanced" disclosure — auto-expanded when a relay is already configured. */}
      <ActionInboxSettings>
        <p className="muted small" style={{ marginTop: 12 }}>
          Legacy off-chain path — superseded by the on-chain OpenChat connection above.
        </p>
        <RelaySettings />
        <RelayPairingCard />
      </ActionInboxSettings>

      <ChatRoutingSettings
        principal={state.principal}
        launchToken={chatLinkToken}
        onLaunchTokenFinished={finishChatLinkToken}
      />
    </div>
  );
}
