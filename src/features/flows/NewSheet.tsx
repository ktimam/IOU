import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "./useActor";
import { useSheetKey } from "./SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import {
  createSheetForPair,
  publishAccountNames,
  SheetCreatedSetupError,
} from "./createSheet";

export function NewSheet() {
  const [params] = useSearchParams();
  const pairId = params.get("pairId") || "";
  const { state } = useAuth();
  const { actor, err } = useActor();
  const { cache } = useSheetKey();
  const { prefs, cacheSheetName } = usePreferences();
  const nav = useNavigate();
  const [sheetName, setSheetName] = useState("");
  const [closingDays, setClosingDays] = useState(365);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Redirect only when definitively anonymous — never during "loading" (avoids the refresh bounce).
    if (state.kind === "anonymous") {
      nav("/sign-in", { replace: true });
    }
  }, [state, nav]);

  if (state.kind !== "authenticated") return null;

  async function doCreate() {
    if (!actor || !pairId) return;
    if (state.kind !== "authenticated") {
      setError("Please sign in first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { sheet, K_sheet } = await createSheetForPair(actor, state.identity, {
        pairId,
        closingDays,
        name: sheetName,
      });
      // Re-publish account + member names under the new sheet's K_sheet
      // (names are encrypted per active sheet). Account name comes from the
      // local cache; falls back to a no-op if unknown.
      await publishAccountNames(actor, K_sheet, {
        pairId,
        accountName: prefs.accountNames[pairId],
        profileName: prefs.profileName,
      });
      cache(sheet.id, K_sheet);
      if (sheetName.trim()) cacheSheetName(sheet.id, sheetName.trim());
      nav(`/sheet/${sheet.id}`, { replace: true });
    } catch (e) {
      if (e instanceof SheetCreatedSetupError) {
        if (e.K_sheet) cache(e.sheet.id, e.K_sheet);
        if (sheetName.trim()) cacheSheetName(e.sheet.id, sheetName.trim());
        nav(`/sheet/${e.sheet.id}`, { replace: true });
        return;
      }
      const msg = (e as Error).message;
      setError(
        msg.includes("pair is not active")
          ? "This account isn't active yet — your partner needs to join with the invite code before you can start a sheet."
          : msg,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <Link to={`/pair/${pairId}`} className="muted">
        ← Back to account
      </Link>
      <h1>New sheet</h1>
      {err && <p style={{ color: "var(--debt)" }}>{err}</p>}

      <div className="card">
        <div className="col">
          <label htmlFor="sheetName">Sheet name (optional)</label>
          <input
            id="sheetName"
            maxLength={48}
            placeholder="e.g. 2026, June, Q3"
            value={sheetName}
            onChange={(e) => setSheetName(e.target.value)}
          />
          <span className="lock-cue">🔒 stored end-to-end encrypted</span>
        </div>
      </div>

      <div className="card">
        <h2>Closing window</h2>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          After this many days of inactivity, the sheet can be closed and a
          new one started.
        </p>
        <input
          type="number"
          min={30}
          max={730}
          value={closingDays}
          onChange={(e) => setClosingDays(Number(e.target.value))}
        />
      </div>

      {error && <p style={{ color: "var(--debt)" }}>{error}</p>}

      <div className="cta">
        {/* Gate on the ACTOR too — see NewPair: an early click silently no-ops otherwise. */}
        <button onClick={doCreate} disabled={busy || !actor}>
          {busy ? "Creating…" : !actor ? "Connecting…" : "Create sheet"}
        </button>
      </div>
    </div>
  );
}
