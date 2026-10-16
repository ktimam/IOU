import { useEffect, useRef, useState } from "react";

/** Sheet-local consent. Rendering, cancelling and retrying reads never authorize VetKD. */
export function LegacySheetRecovery({ backupPending, recover, retryRead }: {
  backupPending: boolean;
  recover: () => Promise<void>;
  retryRead: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const running = useRef(false);
  const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function run(paid: boolean) {
    if (!active.current || running.current || (paid && !confirm)) return;
    running.current = true;
    setBusy(true);
    setConfirm(false);
    setFailure("");
    try { await (paid ? recover() : retryRead()); }
    catch {
      if (active.current) setFailure(paid
        ? "Recovery did not finish. The request may already have incurred a VetKD charge. No automatic paid retry was made. Check for an available key before authorizing another attempt."
        : "The existing key could not be secured yet. No paid recovery was started. Try again when the connection is available.");
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  }

  return <section className="card" aria-labelledby="legacy-sheet-recovery-title" aria-busy={busy}>
    <h2 id="legacy-sheet-recovery-title">{backupPending ? "Finish securing this sheet" : "Unlock this older sheet"}</h2>
    <p>{backupPending
      ? "The original key is available in this session, but its encrypted backup has not been verified. Retry securing it without another VetKD recovery."
      : "This device could not find the original sheet key. Opening this sheet on a device that still has its key migrates it automatically, without a VetKD charge."}</p>
    {!backupPending && <p>Recovering a missing legacy key uses one paid VetKD request for this sheet. After its encrypted backup is saved, future recovery uses your account vault. No paid recovery starts without your confirmation.</p>}
    {failure && <p role="alert">{failure}</p>}
    {confirm && !backupPending ? <div>
      <p>Authorize one paid recovery attempt for this sheet? It consumes canister cycles, even if a later step fails. It does not change your entries or create a replacement sheet key.</p>
      <button type="button" disabled={busy} onClick={() => void run(true)}>Confirm paid recovery for this sheet</button>{" "}
      <button type="button" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
    </div> : <div>
      <button type="button" disabled={busy} onClick={() => void run(false)}>{backupPending ? "Retry securing this sheet (no VetKD)" : "Check for an available key (no VetKD)"}</button>{" "}
      {!backupPending && <button type="button" disabled={busy} onClick={() => setConfirm(true)}>Recover this sheet (paid VetKD)</button>}
    </div>}
    {busy && <p role="status">{backupPending ? "Securing the existing key…" : "Checking and recovering this sheet…"}</p>}
  </section>;
}
