// /settings — browser-local preferences.
//
// Default currency + username. The username is your single, global name: on
// save it publishes EAGERLY to every account you're in (E2E under each
// K_sheet, one set_member_name per active sheet) so every partner immediately
// sees "manager" instead of your principal — and future accounts pick it up on
// create/open. Transaction types/templates are managed from the "Add type"
// button on a sheet, not here.

import { useState } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "./usePreferences";
import { orderedCurrencies } from "./currencies";
import { useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { publishUsernameToAllPairs } from "../flows/createSheet";
import { RelaySettings } from "../relay/RelaySettings";
import { OpenChatSettings } from "../openchat/OpenChatSettings";

export function SettingsPage() {
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

  return (
    <div>
      <Link to="/me" className="muted">
        ← Back
      </Link>
      <h1>Settings</h1>

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

      <RelaySettings />
      <OpenChatSettings />
    </div>
  );
}
