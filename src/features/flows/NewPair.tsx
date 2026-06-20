import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "./useActor";
import { useSheetKey } from "./SheetKeyContext";
import { usePreferences } from "../settings/usePreferences";
import { deriveUserKeypair } from "../crypto/devVetkd";
import { createSheetForPair, publishAccountNames } from "./createSheet";

export function NewPair() {
  const { state } = useAuth();
  const { actor, err } = useActor();
  const { cache } = useSheetKey();
  const { prefs, cacheAccountName, cacheSheetName } = usePreferences();
  const nav = useNavigate();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [accountName, setAccountName] = useState("");
  const [sheetName, setSheetName] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "authenticated") {
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

  async function doJoin() {
    if (!actor || !inviteCode.trim()) {
      setError("Enter an invite code");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pairId = await actor.join_pair(inviteCode.trim());
      // Publish my wrap pubkey on-canister so the creator can seal K_sheet
      // to me when they grant access (dev path; harmless in prod).
      if (state.kind === "authenticated") {
        try {
          const myKp = await deriveUserKeypair(
            state.identity.getPrincipal().toText(),
          );
          await actor.register_sheet_pubkey(
            Array.from(new TextEncoder().encode(myKp.publicKeyB64)),
          );
        } catch {
          /* non-fatal */
        }
      }
      // The creator must grant access before I can read the sheet, so land
      // on the account details page (shows status) rather than the sheet.
      nav(`/pair/${pairId}`, { replace: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h1>New account</h1>
      <div className="row" style={{ marginBottom: 16 }}>
        <button
          className={mode === "create" ? "" : "secondary"}
          onClick={() => setMode("create")}
        >
          Create
        </button>
        <button
          className={mode === "join" ? "" : "secondary"}
          onClick={() => setMode("join")}
        >
          Join
        </button>
      </div>

      {err && <p style={{ color: "var(--debt)" }}>Actor error: {err}</p>}

      {mode === "create" && (
        <div className="card">
          <p className="muted">
            Create an account with someone. We'll start your first sheet so
            you can record entries right away — invite a partner anytime from
            the account's details.
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
      )}

      {mode === "join" && (
        <div className="card">
          <p className="muted">
            Enter the invite code your partner shared with you.
          </p>
          <div className="col">
            <label htmlFor="invite">Invite code</label>
            <input
              id="invite"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              maxLength={9}
            />
          </div>
          {error && <p style={{ color: "var(--debt)" }}>{error}</p>}
          <div className="cta">
            <button onClick={doJoin} disabled={busy || !inviteCode.trim()}>
              {busy ? "Joining…" : "Join account"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
