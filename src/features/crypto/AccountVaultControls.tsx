import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "../auth/AuthProvider";
import { useActor } from "../flows/useActor";
import { isProdVetkd } from "./prodVetkd";
import { recoverAccountVaultPaid, notifyVaultChanged, VAULT_CHANGED_EVENT } from "./vaultAccess";
import { findLegacySheetsToMigrate, migrateLegacySheetKey } from "./vaultSheets";
import { prepareVaultOnboarding, type VaultOnboardingState } from "./vaultOnboarding";
import { ManagedRecoveryControls } from "./ManagedRecoveryControls";

/** Only encrypted features wait here; existing sign-in and navigation are unchanged. */
export function AccountVaultGate({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  if (!isProdVetkd() || state.kind !== "authenticated") return <>{children}</>;
  return <VaultSession key={state.principal} principal={state.principal}>{children}</VaultSession>;
}

function VaultSession({ principal, children }: { principal: string; children: ReactNode }) {
  const { signOut } = useAuth();
  const { actor, err } = useActor();
  const [step, setStep] = useState<VaultOnboardingState | "checking" | "error">("checking");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const automaticSetup = useRef(true);
  useEffect(() => {
    const update = () => setRevision((value) => value + 1);
    window.addEventListener(VAULT_CHANGED_EVENT, update);
    return () => window.removeEventListener(VAULT_CHANGED_EVENT, update);
  }, []);
  useEffect(() => {
    if (!actor) return;
    let cancelled = false;
    setStep("checking"); setError("");
    void prepareVaultOnboarding(actor, principal, location.origin, automaticSetup.current,
      () => !cancelled, () => { automaticSetup.current = false; }).then((next) => {
      if (!cancelled) setStep(next);
    }).catch((cause) => {
      if (!cancelled) {
        setStep("error");
        setError(cause instanceof Error ? cause.message : "Account encryption could not be loaded.");
      }
    });
    return () => { cancelled = true; };
  }, [actor, principal, revision]);
  if (step === "ready") return <>{children}</>;
  return <main style={{ maxWidth: 680, margin: "24px auto", padding: 16 }}>
    <section className="card" aria-label="Account encryption">
      <h1>{step === "recovery" ? "Save your recovery entry" : step === "unlock" ? "Unlock account encryption" : "Account encryption"}</h1>
      <p>Your sign-in is kept across reloads and browser restarts. Encryption keys are protected on this device; they are never shared with OpenChat.</p>
      {(err || error) && <p role="status">{err || error}</p>}
      {step === "checking" && <p role="status">Preparing account encryption. First-time setup is automatic; your saved keys are reused on later visits.</p>}
      {actor && (step === "setup" || step === "error") && <>
        <p>Setup could not finish. Retry checks the saved account and resumes the same setup request; it does not start a new paid emergency attempt.</p>
        <button onClick={() => { automaticSetup.current = true; setRevision((value) => value + 1); }}>Retry encryption setup</button>
        <details><summary>Previous setup was interrupted?</summary>
          <p>If retry cannot resolve an earlier paid request, a separate emergency attempt may be needed. It may incur another derivation charge and is never started automatically.</p>
          <VaultEmergencyRecovery actor={actor} principal={principal} />
        </details>
      </>}
      {actor && (step === "recovery" || step === "unlock") && <VaultActions actor={actor} principal={principal}
        ready={step === "recovery"} required />}
      <button className="secondary" onClick={() => void signOut()}>Sign out</button>
    </section>
  </main>;
}

export function AccountVaultSettings() {
  const { state } = useAuth(), { actor } = useActor();
  if (!isProdVetkd() || state.kind !== "authenticated" || !actor) return null;
  return <section className="card" aria-label="Encryption recovery">
    <h2>Encryption recovery</h2>
    <p>Save an IOU encryption recovery entry in your password manager to unlock another device without another key-recovery charge. Internet Identity remains your sign-in.</p>
    <VaultActions key={state.principal} actor={actor} principal={state.principal} ready />
    <LegacyMigration actor={actor} principal={state.principal} />
  </section>;
}

export function VaultActions({ actor, principal, ready, required = false }: {
  actor: any; principal: string; ready: boolean; required?: boolean;
}) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(operation: () => Promise<unknown>, success: string) {
    if (working.current || busy) return;
    working.current = true;
    setBusy(true); setMessage("");
    try {
      await operation();
      if (!mounted.current) return;
      setMessage(success);
      if (required) notifyVaultChanged();
    } catch (cause) {
      if (mounted.current) setMessage(cause instanceof Error ? cause.message : "Encryption operation failed. Nothing was reset.");
    } finally { working.current = false; if (mounted.current) setBusy(false); }
  }
  return <div>
    <ManagedRecoveryControls key={principal} actor={actor} principal={principal} ready={ready} disabled={busy}
      onBusy={setBusy} onVerified={() => { if (required) notifyVaultChanged(); }} />
    {ready ? <>
      {required && <p>Your initialized keys are kept in this browser if saving fails or is cancelled. Retry saving your recovery entry without another setup charge. Do not clear site data.</p>}
      <p className="muted small">If your recovery entry and remembered device keys are lost, the same Internet Identity can request paid emergency recovery. Ordinary reloads and reconnects do not call VetKD.</p>
    </> : <details><summary>Lost your recovery entry and remembered device keys?</summary>
        <p>Recover through your current Internet Identity. One account-key derivation costs approximately 26.15 billion cycles (about $0.036), paid by IOU, plus ordinary execution. This does not charge once per sheet.</p>
        <button disabled={busy} onClick={() => void run(() => recoverAccountVaultPaid(actor, principal, true), "Account encryption recovered.")}>Recover encryption access (paid VetKD)</button>
        <details><summary>A previous recovery failed or has an unknown outcome?</summary>
          <p>Retrying above reuses its protected request. A new attempt may pay again even if the earlier request was already charged. IOU enforces a 24-hour emergency cooldown.</p>
          <button disabled={busy} onClick={() => void run(() => recoverAccountVaultPaid(actor, principal, true, true), "Account encryption recovered.")}>Start a new emergency attempt (may pay again)</button>
        </details>
      </details>}
    {busy && <p role="status">Working…</p>}
    {message && <p role="status">{message}</p>}
  </div>;
}

function VaultEmergencyRecovery({ actor, principal }: { actor: any; principal: string }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  return <div>
    <button disabled={busy} onClick={() => {
      setBusy(true); setMessage("");
      void recoverAccountVaultPaid(actor, principal, true, true)
        .catch((cause) => setMessage(cause instanceof Error ? cause.message : "Emergency recovery could not finish."))
        .finally(() => setBusy(false));
    }}>Recover interrupted setup (new paid VetKD attempt)</button>
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
    <p>Older sheets keep their existing encryption. Available original keys are backed up automatically without VetKD when you open a sheet or check here. Only missing keys need explicit paid recovery; no entries or encryption keys are replaced.</p>
    <button className="secondary" disabled={busy} onClick={() => void inspect()}>Check older sheets (no VetKD charge)</button>
    {!!sheets?.length && <div><p>{sheets.length} older sheet(s) need migration. Estimated derivation cost: about { (sheets.length * 0.036).toFixed(3) } USD in cycles, plus ordinary execution, paid by IOU.</p>
      <button disabled={busy} onClick={() => void migrate()}>Migrate {sheets.length} older sheet key(s) (paid VetKD)</button></div>}
    {busy && <p role="status">Working…</p>}
    {message && <p role="status">{message}</p>}
  </details>;
}
