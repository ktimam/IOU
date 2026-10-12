import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "../flows/useActor";
import { isProdVetkd } from "./prodVetkd";
import { loadAccountRoot, getAccountVaultSheetKeypair, addPasskeyBackup, addRecoveryCodeBackup,
  unlockAccountVaultWithPasskey, unlockAccountVaultWithRecoveryCode, VaultConflictError } from "./accountVault";
import { accountVaultScope, recoverAccountVaultPaid, notifyVaultChanged, VAULT_CHANGED_EVENT } from "./vaultAccess";
import { findLegacySheetsToMigrate, migrateLegacySheetKey } from "./vaultSheets";

/** Only encrypted features wait here; existing sign-in and navigation are unchanged. */
export function AccountVaultGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  if (!isProdVetkd() || state.kind !== "authenticated") return <>{children}</>;
  return <VaultSession key={state.principal} principal={state.principal}>{children}</VaultSession>;
}

function VaultSession({ principal, children }: { principal: string; children: ReactNode }) {
  const { signOut } = useAuth();
  const { actor, err } = useActor();
  const [ready, setReady] = useState(false), [initializing, setInitializing] = useState(false);
  const [existing, setExisting] = useState<boolean>(), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    window.addEventListener(VAULT_CHANGED_EVENT, update);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, update);
  }, []);
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      const record = await actor.get_account_vault();
      if (cancelled) return;
      if (!Array.isArray(record) || record.length > 1) throw new Error("Invalid account encryption record.");
      setExisting(record.length === 1);
      const root = await loadAccountRoot(actor, accountVaultScope(principal));
      if (root) {
        root.fill(0);
        await getAccountVaultSheetKeypair(actor, accountVaultScope(principal));
        if (!cancelled) { setReady(true); setError(""); }
      }
    })().catch((cause) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Account encryption could not be loaded."); });
    return () => { cancelled = true; };
  }, [actor, principal, revision]);
  if (ready && !initializing) return <>{children}</>;
  return <main style={{ maxWidth: 680, margin: "24px auto", padding: 16 }}>
    <section className="card" aria-label="Account encryption">
      <h1>{ready ? "Protect access on other devices" : existing ? "Unlock account encryption" : "Account encryption"}</h1>
      <p>Your sign-in is kept across reloads and browser restarts. Encryption keys are protected on this device; they are never shared with OpenChat.</p>
      {(err || error) && <p role="status">{err || error}</p>}
      {actor && existing !== undefined ? <VaultActions actor={actor} principal={principal} ready={ready} existing={existing}
        onSetup={() => setInitializing(true)} /> : <p>Checking encrypted account backup…</p>}
      {ready && <button onClick={() => setInitializing(false)}>Continue to IOU</button>}
      <button className="secondary" onClick={() => void signOut()}>Sign out</button>
    </section>
  </main>;
}

export function AccountVaultSettings() {
  const { state } = useAuth(), { actor } = useActor();
  if (!isProdVetkd() || state.kind !== "authenticated" || !actor) return null;
  return <section className="card" aria-label="Encryption recovery">
    <h2>Encryption recovery</h2>
    <p>Add an IOU encryption passkey or save a recovery code to unlock another device without another key-recovery charge. This passkey is separate from Internet Identity.</p>
    <VaultActions actor={actor} principal={state.principal} ready existing />
    <LegacyMigration actor={actor} principal={state.principal} />
  </section>;
}

function VaultActions({ actor, principal, ready, existing, onSetup }: {
  actor: any; principal: string; ready: boolean; existing: boolean; onSetup?: () => void;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const [code, setCode] = useState(""), [newCode, setNewCode] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const scope = accountVaultScope(principal);
  async function run(operation: () => Promise<unknown>, success: string) {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      await operation();
      if (!mounted.current) return;
      setCode(""); setMessage(success);
      // Adding a backup does not lock the vault. Remounting the app here would
      // erase the newly displayed recovery code before the user can save it.
      if (!ready) notifyVaultChanged();
    } catch (cause) {
      if (mounted.current) setMessage(cause instanceof Error ? cause.message : "Encryption operation failed. Nothing was reset.");
    } finally { if (mounted.current) setBusy(false); }
  }
  return <div>
    {ready ? <>
      <div className="cta">
        <button disabled={busy} onClick={() => void run(() => addPasskeyBackup(actor, scope, "IOU encryption"), "Encryption passkey saved. Use the same passkey wherever your provider makes it available; keep a recovery code too.")}>Add encryption passkey</button>
        <button className="secondary" disabled={busy} onClick={() => void run(async () => {
          try {
            const backup = await addRecoveryCodeBackup(actor, scope, (preparedCode) => {
              if (mounted.current) setNewCode(preparedCode);
            });
            if (mounted.current) setNewCode(backup.recoveryCode);
          } catch (cause) {
            // An uncertain network outcome may have activated the shown code;
            // a definitive CAS refusal did not, so never offer that candidate.
            if (cause instanceof VaultConflictError && mounted.current) setNewCode("");
            throw cause;
          }
        }, "Save the recovery code privately. Anyone with it and access to the encrypted backup can unlock your keys.")}>Create recovery code</button>
      </div>
      <p className="muted small">Creating another recovery code replaces the previous code. Keep the newly displayed code before leaving this page.</p>
      {newCode && <div><label>Recovery code — save privately<input readOnly value={newCode} autoComplete="off" spellCheck={false} /></label>
        <button className="secondary" onClick={() => setNewCode("")}>I saved the code; hide it</button></div>}
      <p className="muted small">If these methods are lost, the same Internet Identity can request paid emergency recovery. Ordinary reloads and reconnects do not call VetKD.</p>
    </> : existing ? <>
      <button disabled={busy} onClick={() => void run(() => unlockAccountVaultWithPasskey(actor, scope), "Account encryption unlocked.")}>Unlock with encryption passkey</button>
      <label>Recovery code<input type="password" autoComplete="off" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} /></label>
      <button className="secondary" disabled={busy || !code.trim()} onClick={() => void run(() => unlockAccountVaultWithRecoveryCode(actor, scope, code.trim()), "Account encryption unlocked.")}>Unlock with recovery code</button>
      <details><summary>Lost your encryption recovery methods?</summary>
        <p>Recover through your current Internet Identity. One account-key derivation costs approximately 26.15 billion cycles (about $0.036), paid by IOU, plus ordinary execution. This does not charge once per sheet.</p>
        <button disabled={busy} onClick={() => void run(() => recoverAccountVaultPaid(actor, principal, true), "Account encryption recovered. Add a replacement recovery method in Settings.")}>Recover encryption access (paid VetKD)</button>
        <details><summary>A previous recovery failed or has an unknown outcome?</summary>
          <p>Retrying above reuses its protected request. A new attempt may pay again even if the earlier request was already charged. IOU enforces a 24-hour emergency cooldown.</p>
          <button disabled={busy} onClick={() => void run(() => recoverAccountVaultPaid(actor, principal, true, true), "Account encryption recovered.")}>Start a new emergency attempt (may pay again)</button>
        </details>
      </details>
    </> : <>
      <p>Set up encryption once for this IOU user. This makes one paid account-key derivation (about $0.036 in cycles); new sheets generate their keys locally.</p>
      <button disabled={busy} onClick={() => { onSetup?.(); void run(() => recoverAccountVaultPaid(actor, principal, false), "Account encryption is ready. Add a recovery method below."); }}>Set up account encryption</button>
      <details><summary>Previous setup was interrupted?</summary>
        <p>Retrying setup reuses its protected request. If that cannot finish, a new explicit emergency attempt may pay again, even if the earlier request was charged. A 24-hour cooldown can apply.</p>
        <button disabled={busy} onClick={() => { onSetup?.(); void run(() => recoverAccountVaultPaid(actor, principal, true, true), "Encryption recovered."); }}>Recover interrupted setup (new paid VetKD attempt)</button>
      </details>
    </>}
    {busy && <p role="status">Working…</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}

function LegacyMigration({ actor, principal }: { actor: any; principal: string }) {
  const [sheets, setSheets] = useState<string[]>();
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function inspect() {
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const pending = await findLegacySheetsToMigrate(actor, principal);
      if (mounted.current) { setSheets(pending); setMessage(pending.length ? "" : "No older sheet keys need migration."); }
    } catch (cause) { if (mounted.current) setMessage(cause instanceof Error ? cause.message : "Could not inspect older sheets."); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function migrate() {
    if (busy || !sheets?.length) return;
    setBusy(true); setMessage("");
    let remaining = [...sheets];
    try {
      for (const sheetId of sheets) {
        if (!mounted.current) return;
        await migrateLegacySheetKey(actor, principal, sheetId);
        remaining = remaining.filter((id) => id !== sheetId);
        if (mounted.current) setSheets([...remaining]);
      }
      if (mounted.current) setMessage("Older sheet keys are backed up. Future reads use their encrypted copies without VetKD.");
    } catch (cause) {
      if (mounted.current) setMessage((cause instanceof Error ? cause.message : "Migration could not finish.") +
        " Stopped without automatically retrying. Successfully migrated keys are retained; inspect again before another paid attempt.");
    } finally { if (mounted.current) setBusy(false); }
  }
  return <details><summary>Migrate older sheet keys</summary>
    <p>Older sheets keep their existing encryption. A one-time derivation for each unmigrated sheet saves an encrypted copy; no entries or keys are replaced.</p>
    <button className="secondary" disabled={busy} onClick={() => void inspect()}>Check older sheets (no VetKD charge)</button>
    {!!sheets?.length && <div><p>{sheets.length} older sheet(s) need migration. Estimated derivation cost: about { (sheets.length * 0.036).toFixed(3) } USD in cycles, plus ordinary execution, paid by IOU.</p>
      <button disabled={busy} onClick={() => void migrate()}>Migrate {sheets.length} older sheet key(s) (paid VetKD)</button></div>}
    {busy && <p role="status">Working…</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}
