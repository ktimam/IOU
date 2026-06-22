// /settings — browser-local preferences.
//
// Default currency + profile name. The profile name publishes per-account
// (E2E under K_sheet). Transaction types/templates are managed from the
// "Add type" button on a sheet, not here.

import { useState } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "./usePreferences";
import { COMMON_CURRENCIES } from "./currencies";
import { RelaySettings } from "../relay/RelaySettings";

export function SettingsPage() {
  const { prefs, setDefaultCurrency, setProfileName } = usePreferences();
  const [name, setName] = useState(prefs.profileName);
  const [saved, setSaved] = useState(false);

  return (
    <div>
      <Link to="/me" className="muted">
        ← Back
      </Link>
      <h1>Settings</h1>

      <div className="card">
        <h2>Profile name</h2>
        <p className="muted small">
          Your partner sees this on shared accounts instead of your
          principal. Stored end-to-end encrypted; it publishes to an account
          the next time you create or open it.
        </p>
        <input
          maxLength={32}
          placeholder="e.g. Alice"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
        <span className="lock-cue">🔒 published encrypted, per account</span>
        <div className="cta">
          <button
            onClick={() => {
              setProfileName(name.trim());
              setSaved(true);
            }}
          >
            Save name
          </button>
        </div>
        {saved && (
          <p className="muted small">
            Saved. It’ll publish to your accounts when you next open them.
          </p>
        )}
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
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <RelaySettings />
    </div>
  );
}
