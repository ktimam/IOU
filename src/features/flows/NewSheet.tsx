import { useEffect, useState } from "react";
import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "./useActor";
import { useSheetKey } from "./SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import { COMMON_CURRENCIES } from "../settings/currencies";
import { createSheetForPair, publishAccountNames } from "./createSheet";

export function NewSheet() {
  const [params] = useSearchParams();
  const pairId = params.get("pairId") || "";
  const { state } = useAuth();
  const { actor, err } = useActor();
  const { cache } = useSheetKey();
  const { prefs, cacheSheetName } = usePreferences();
  const nav = useNavigate();
  const [sheetName, setSheetName] = useState("");
  const [currencies, setCurrencies] = useState<string[]>([
    prefs.defaultCurrency || "USD",
  ]);
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

  function toggleCurrency(c: string) {
    setCurrencies((cur) =>
      cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c],
    );
  }

  async function doCreate() {
    if (!actor || !pairId) return;
    if (state.kind !== "authenticated") {
      setError("Please sign in first");
      return;
    }
    if (currencies.length === 0) {
      setError("Pick at least one currency");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { sheet, K_sheet } = await createSheetForPair(actor, state.identity, {
        pairId,
        currencies,
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
        <h2>Currencies</h2>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Pick the currencies you'll use in this sheet. You can add more
          later.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {COMMON_CURRENCIES.map((c) => (
            <button
              key={c}
              className={currencies.includes(c) ? "" : "secondary"}
              onClick={() => toggleCurrency(c)}
              style={{ fontSize: "0.875rem", padding: "6px 12px" }}
            >
              {c}
            </button>
          ))}
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
        <button onClick={doCreate} disabled={busy || currencies.length === 0}>
          {busy ? "Creating…" : "Create sheet"}
        </button>
      </div>
    </div>
  );
}
