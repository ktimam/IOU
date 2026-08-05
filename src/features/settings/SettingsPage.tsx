// /settings — the profile & settings hub (merged with the former /me page).
//
// Sign-out and your principal (formerly /me), plus your username
// and default currency. The username is your single, global name: on save it
// publishes EAGERLY to every account you're in (E2E under each K_sheet, one
// set_member_name per active sheet) so every partner immediately sees "manager"
// instead of your principal — and future accounts pick it up on create/open.
// Reached from the username badge in the top-right of every page. Transaction
// types/templates are managed from the "Add type" button on a sheet, not here.

import { useEffect, useState } from "react";
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

export function SettingsPage() {
  const { state, signOut } = useAuth();
  const { prefs, setDefaultCurrency, setProfileName } = usePreferences();
  const { actor } = useActor();
  const { unwrapFor } = useSheetKey();
  const [name, setName] = useState(prefs.profileName);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The DEPLOYMENT-wide currency the OpenChat card pre-selects (Config.card_currency). "" = unset.
  const [cardCurrency, setCardCurrency] = useState<string>("");
  const [cardStatus, setCardStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!actor) return;
    void (async () => {
      try {
        const cfg = (await actor.get_config()) as { card_currency?: [] | [string] };
        const opt = cfg?.card_currency;
        setCardCurrency(Array.isArray(opt) && opt.length > 0 ? String(opt[0]) : "");
      } catch {
        /* older canister / offline — leave it unset */
      }
    })();
  }, [actor]);

  // Deployment-wide, so it is saved straight to the canister (no local cache).
  async function saveCardCurrency(code: string) {
    setCardCurrency(code);
    setCardStatus(null);
    if (!actor) return;
    try {
      // "" clears it on the canister, so "Not set" really turns the pre-selection off.
      await actor.set_card_currency(code);
      setCardStatus(
        code
          ? `Chat cards now pre-select ${code}.`
          : "Cleared — chat cards will use each person's own default at import.",
      );
    } catch (e) {
      const msg = (e as Error).message;
      setCardStatus(
        /only the creator/i.test(msg)
          ? "Only the deployment's creator can change this."
          : `Could not save: ${msg}`,
      );
    }
  }

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
        <h2>Chat card currency</h2>
        <p className="muted small">
          The currency IOU pre-selects on confirmable cards inside OpenChat. This one is
          <strong> shared by everyone</strong> on this deployment, because a card is rendered in a
          sandboxed frame that cannot tell who is looking at it — so both members of a chat see, and
          import, the same code. Leave it unset to let each person's own default apply at import
          instead. Whoever confirms a card can always change it there first.
        </p>
        <select value={cardCurrency} onChange={(e) => void saveCardCurrency(e.target.value)}>
          <option value="">Not set — use each person's own default</option>
          {orderedCurrencies(cardCurrency || prefs.defaultCurrency).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        {cardStatus && <p className="muted small">{cardStatus}</p>}
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
    </div>
  );
}
