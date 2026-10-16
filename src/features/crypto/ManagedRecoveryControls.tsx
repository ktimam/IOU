import { useEffect, useRef, useState, type FormEvent } from "react";
import { confirmManagedRecovery, prepareManagedRecovery,
  readAccountVaultSessionGeneration, assertAccountVaultSessionGeneration, registerAccountVaultCleanup } from "./accountVault";
import { accountVaultScope } from "./vaultAccess";
import { loadManagedRecoveryView } from "./managedRecoveryView";
import { managerRecoveryAvailable, saveManagedRecoveryCredential, readManagedRecoveryCredential,
  ManagedRecoveryError } from "./accountVaultPasswordManager";

/** Recovery is prepared automatically; saving and verification stay explicit.
 * Plaintext secrets exist only in this view, never in URLs or app storage. */
export function ManagedRecoveryControls({ actor, principal, ready, disabled, onBusy, onVerified }: {
  actor: any; principal: string; ready: boolean; disabled: boolean;
  onBusy: (busy: boolean) => void; onVerified: () => void;
}) {
  const [phase, setPhase] = useState<"idle" | "save" | "verify">("idle");
  const [credentialId, setCredentialId] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState("");
  const secret = useRef("");
  const passwordField = useRef<HTMLInputElement>(null);
  const saveField = useRef<HTMLInputElement>(null);
  const live = useRef(false), working = useRef(false);
  const epoch = useRef(0);
  const scope = accountVaultScope(principal);
  const origin = typeof location === "undefined" ? "" : location.origin;
  const manager = managerRecoveryAvailable();
  function clearSecret() {
    secret.current = "";
    for (const input of [passwordField.current, saveField.current]) {
      if (input) { input.value = ""; input.defaultValue = ""; input.removeAttribute("value"); }
    }
  }
  useEffect(() => {
    live.current = true;
    epoch.current++; working.current = true; clearSecret();
    setPhase("idle"); setCredentialId(""); setLoaded(false); setMessage(""); onBusy(true);
    let cancelled = false;
    const started = epoch.current;
    const generation = readAccountVaultSessionGeneration();
    const current = () => {
      assertAccountVaultSessionGeneration(generation);
      if (cancelled || !live.current || epoch.current !== started) throw new Error("Account session changed");
    };
    const unsubscribe = registerAccountVaultCleanup(() => {
      epoch.current++; working.current = false; clearSecret();
      if (live.current) { setPhase("idle"); setCredentialId(""); setLoaded(false); setMessage(""); onBusy(false); }
    });
    void loadManagedRecoveryView(actor, accountVaultScope(principal), origin, ready, current,
      () => setMessage("Preparing your recovery entry. No password-manager prompt or paid recovery will start automatically.")).then(({ descriptor, prepared }) => {
      current(); setCredentialId(descriptor?.credentialId ?? ""); setLoaded(true);
      if (prepared) {
        clearSecret(); secret.current = prepared.secret; setPhase("save");
        setMessage("Your recovery entry is ready. Save it in your password manager, then verify it separately.");
      } else setMessage("");
    }).catch(() => {
      if (!cancelled && epoch.current === started) {
        setLoaded(true);
        setMessage("The recovery entry could not be prepared or checked. Retry to reuse any saved entry; no paid recovery was started.");
      }
    }).finally(() => {
      if (!cancelled && epoch.current === started) { working.current = false; onBusy(false); }
    });
    return () => { cancelled = true; live.current = false; epoch.current++; clearSecret(); unsubscribe(); };
  }, [actor, principal, origin, ready]);

  async function run(operation: (current: () => void) => Promise<void>) {
    if (working.current || disabled) return;
    const generation = readAccountVaultSessionGeneration();
    const started = epoch.current;
    const current = () => {
      assertAccountVaultSessionGeneration(generation);
      if (!live.current || epoch.current !== started) throw new Error("Account session changed");
    };
    working.current = true; onBusy(true); setMessage("");
    try { await operation(current); }
    catch (error) {
      if (live.current && epoch.current === started) setMessage(error instanceof ManagedRecoveryError ? error.message
        : "Recovery could not finish. Keep your saved entry and this browser's data, then retry. No paid recovery was started.");
    } finally { if (epoch.current === started) { working.current = false; if (live.current) onBusy(false); } }
  }
  function prepare() {
    void run(async (current) => {
      const candidate = await prepareManagedRecovery(actor, scope, origin);
      current(); clearSecret(); secret.current = candidate.secret;
      setCredentialId(candidate.credentialId); setPhase("save");
      setMessage("The encrypted backup is ready. Save this entry in your password manager, then verify it separately.");
    });
  }
  function save() {
    void run(async (current) => {
      // Called directly from the click; do not put a network await before the provider prompt.
      await saveManagedRecoveryCredential(credentialId, secret.current);
      current(); clearSecret(); setPhase("verify");
      setMessage("Save request finished. Now retrieve the entry to verify it. This does not confirm cloud sync.");
    });
  }
  function verify(useManager: boolean) {
    const started = epoch.current;
    void run(async (current) => {
      let supplied = "";
      try {
        supplied = useManager ? await readManagedRecoveryCredential(credentialId) : passwordField.current?.value ?? "";
        current(); clearSecret();
        await confirmManagedRecovery(actor, scope, origin, credentialId, supplied);
        current(); setPhase("idle");
        setMessage("Recovery entry verified and account encryption unlocked. Cloud sync must be enabled in your password manager to use it on another device.");
        onVerified();
      } finally { supplied = ""; if (epoch.current === started) clearSecret(); }
    });
  }
  function fallbackSaved(event: FormEvent) {
    event.preventDefault();
    if (disabled || working.current) return;
    // No native form submission: no recovery secret may enter a URL or request body.
    clearSecret(); setPhase("verify");
    setMessage("Use your password manager to fill the blank recovery field. Continuing alone does not confirm that an entry was saved.");
  }
  const verifyVisible = !!credentialId && (phase === "verify" || (!ready && loaded) || (ready && phase === "idle"));
  return <section aria-label="Password-manager recovery">
    <p>Sign in with Internet Identity as usual. IOU prepares your recovery entry automatically when needed. Save it in your password manager and verify it to unlock the same keys on another device without another VetKD charge.</p>
    {!loaded && <p role="status">Checking your saved recovery entry…</p>}
    {ready && loaded && phase !== "save" && <button type="button" disabled={disabled} onClick={prepare}>
      {credentialId ? "Prepare the same recovery entry again" : "Prepare recovery entry"}
    </button>}
    {!!credentialId && <p className="muted small">Recovery username: <span style={{ overflowWrap: "anywhere" }}>{credentialId}</span></p>}
    {phase === "save" && <>
      {manager && <button type="button" disabled={disabled} onClick={save}>Save in password manager</button>}
      <details open={!manager}><summary>Save using the password form</summary>
        <p>Save this generated password in your manager for this site. Do not replace it with your own password. After saving, continue to a separate blank autofill check.</p>
        <form onSubmit={fallbackSaved} autoComplete="on">
          <label>Recovery username<input autoComplete="username" value={credentialId} readOnly /></label>
          <label>Generated recovery password<input ref={saveField} type="password" autoComplete="new-password" defaultValue={secret.current} readOnly /></label>
          <button type="submit" disabled={disabled}>I saved the entry; verify it</button>
        </form>
      </details>
      <button type="button" className="secondary" disabled={disabled} onClick={() => { clearSecret(); setPhase("idle"); }}>Cancel saving</button>
    </>}
    {verifyVisible && <>
      {manager && <button type="button" disabled={disabled} onClick={() => verify(true)}>
        {ready ? "Verify saved recovery entry" : "Unlock with password manager"}
      </button>}
      <form autoComplete="on" onSubmit={(event) => { event.preventDefault(); verify(false); }}>
        <label>Recovery username<input autoComplete="username" value={credentialId} readOnly /></label>
        <label>Recovery password<input ref={passwordField} type="password" autoComplete="current-password" spellCheck={false} /></label>
        <p className="muted small">Use your manager's saved entry for this site and username. No new password is needed.</p>
        <button type="submit" disabled={disabled}>{ready ? "Verify autofilled entry" : "Unlock with autofilled entry"}</button>
      </form>
    </>}
    {!ready && loaded && !credentialId && <p>No password-manager recovery backup exists yet. On an already-unlocked device, open Settings → Encryption recovery and save one first. Existing keys are never replaced.</p>}
    <p className="muted small">Keep password sync enabled. Local verification proves the entry decrypts your backup, not that your password manager has synced it. Use only your trusted IOU address; anyone with this recovery password can decrypt your account backup.</p>
    {message && <p role="status">{message}</p>}
  </section>;
}
