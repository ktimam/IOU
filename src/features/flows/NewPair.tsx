import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "./useActor";
import { useSheetKey } from "./SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import { createSheetForPair, publishAccountNames } from "./createSheet";

// Creating a new account. Joining an existing one no longer lives here — a
// partner joins by opening an invite link (see AcceptInvitePage), so this page
// is create-only.
export function NewPair() {
  const { state } = useAuth();
  const { actor, err } = useActor();
  const { cache } = useSheetKey();
  const { prefs, cacheAccountName, cacheSheetName } = usePreferences();
  const nav = useNavigate();
  const [accountName, setAccountName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Only redirect once auth is DEFINITIVELY anonymous — never during "loading", or a refresh /
    // deep-link bounces through /sign-in back to /pairs before the session hydrates.
    if (state.kind === "anonymous") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

  async function doCreate() {
    if (!actor || state.kind !== "authenticated") return;
    setBusy(true);
    setError(null);
    try {
      // 1. Create the account (pair). 2. Create its first sheet (so there's
      // somewhere to record entries immediately). 3. Publish the account +
      // your profile name, E2E-encrypted under the new sheet's K_sheet.
      const out = await actor.create_pair();
      const pairId: string = out.pair_id;
      const { sheet, K_sheet } = await createSheetForPair(actor, state.identity, {
        pairId,
        currencies: [prefs.defaultCurrency || "USD"],
        closingDays: 365,
        name: sheetName,
      });
      await publishAccountNames(actor, K_sheet, {
        pairId,
        accountName,
        profileName: prefs.profileName,
      });
      cache(sheet.id, K_sheet);
      if (accountName.trim()) cacheAccountName(pairId, accountName.trim());
      if (sheetName.trim()) cacheSheetName(sheet.id, sheetName.trim());
      nav(`/sheet/${sheet.id}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>New account</h1>

      {err && <p style={{ color: "var(--debt)" }}>Actor error: {err}</p>}

      <div className="card">
        <p className="muted">
          Create an account with someone. We'll start your first sheet so
          you can record entries right away — invite a partner anytime from
          the sheet itself.
        </p>
        <div className="col">
          <label htmlFor="accountName">Account name (optional)</label>
          <input
            id="accountName"
            maxLength={48}
            placeholder="e.g. Alice, Rent, Trip"
            value={accountName}
            onChange={(e) => setAccountName(e.target.value)}
          />
          <label htmlFor="sheetName">First sheet name (optional)</label>
          <input
            id="sheetName"
            maxLength={48}
            placeholder="e.g. 2026, June, Q3"
            value={sheetName}
            onChange={(e) => setSheetName(e.target.value)}
          />
          <span className="lock-cue">🔒 names stored end-to-end encrypted</span>
        </div>
        {error && <p style={{ color: "var(--debt)" }}>{error}</p>}
        <div className="cta">
          <button onClick={doCreate} disabled={busy}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </div>
      </div>
    </div>
  );
}
