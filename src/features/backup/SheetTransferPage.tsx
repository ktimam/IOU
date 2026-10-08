import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { canisterId } from "../auth/config";
import { useActor } from "../flows/useActor";
import { useSheetKey } from "../flows/SheetKeyContext";
import { parseSheetBackup, serializeSheetBackup, SHEET_BACKUP_LIMITS, type SheetBackup } from "./backupFormat";
import { DIRECTION_LABELS } from "../entries/directionLabels";
import { orientDirection } from "../entries/balance";
import { exportSheetBackup, importSheetBackup, previewSheetBackupImport } from "./backupService";

type Preview = Awaited<ReturnType<typeof previewSheetBackupImport>>;

/** Normal sheet tools, deliberately separate from the OpenChat card/delivery UI. */
export function SheetTransferPage() {
  const { sheetId = "" } = useParams();
  const { state } = useAuth();
  const { actor, err } = useActor();
  const { get, unwrapFor } = useSheetKey();
  const principal = state.kind === "authenticated" ? state.principal : null;
  const identity = state.kind === "authenticated" ? state.identity : null;
  const current = useRef({ actor, principal, sheetId, identity });
  current.current = { actor, principal, sheetId, identity };
  const mounted = useRef(true);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [backup, setBackup] = useState<SheetBackup | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    setBackup(null);
    setPreview(null);
    setConfirmed(false);
    setStatus("");
    setError("");
  }, [principal, sheetId, identity]);

  async function run(work: (context: {
    actor: NonNullable<typeof actor>;
    principal: string;
    sheetId: string;
    sheetKey: Uint8Array;
    assertCurrent: () => void;
  }) => Promise<void>) {
    if (!actor || !principal || running.current) return;
    const captured = { actor, principal, sheetId, identity };
    const assertCurrent = () => {
      if (!mounted.current || current.current.actor !== captured.actor ||
          current.current.principal !== captured.principal || current.current.sheetId !== captured.sheetId ||
          current.current.identity !== captured.identity) {
        throw new Error("The account or sheet changed. Return to the intended sheet before continuing.");
      }
    };
    running.current = true;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      assertCurrent();
      const sheetKey = get(sheetId) ?? await unwrapFor(sheetId);
      assertCurrent();
      await work({ ...captured, sheetKey, assertCurrent });
    } catch (cause) {
      if (mounted.current && current.current.principal === captured.principal && current.current.sheetId === captured.sheetId && current.current.identity === captured.identity) {
        setError(cause instanceof Error ? cause.message : "The transfer could not finish.");
      }
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function download() {
    await run(async (context) => {
      const snapshot = await exportSheetBackup({ ...context, backendCanisterId: canisterId });
      context.assertCurrent();
      const blob = new Blob([serializeSheetBackup(snapshot)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `iou-sheet-${sheetId}-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setStatus("Export prepared. Keep the downloaded file private: it is not encrypted.");
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1_000);
      }
    });
  }

  async function selectFile(file: File | undefined) {
    setBackup(null);
    setPreview(null);
    setConfirmed(false);
    if (!file) return;
    await run(async (context) => {
      if (file.size > SHEET_BACKUP_LIMITS.bytes) throw new Error("Choose an IOU JSON backup no larger than 16 MiB.");
      const parsed = parseSheetBackup(await file.text());
      context.assertCurrent();
      const checked = await previewSheetBackupImport({ ...context, backup: parsed });
      context.assertCurrent();
      setBackup(parsed);
      setPreview(checked);
    });
  }

  async function importFile() {
    if (!backup || !preview || !confirmed) return;
    const selected = backup;
    await run(async (context) => {
      const execute = async () => {
        context.assertCurrent();
        const result = await importSheetBackup({ ...context, backup: selected });
        context.assertCurrent();
        setStatus(`Import verified: ${result.totalActiveEntries} current entries and ${result.typeCount} Types. The source sheet is unchanged.`);
        setConfirmed(false);
        setPreview(null);
        setBackup(null);
      };
      // Same-origin tabs share this lock. Backend receipts also protect retries of this file.
      if (navigator.locks) {
        await navigator.locks.request(`iou-sheet-backup:${canisterId}:${sheetId}`, { ifAvailable: true }, async (lock) => {
          if (!lock) throw new Error("An import is already running for this sheet in another tab.");
          await execute();
        });
      } else {
        await execute();
      }
    });
  }

  if (state.kind === "anonymous") return <p><Link to="/sign-in">Sign in</Link> to import or export a sheet.</p>;
  if (state.kind !== "authenticated") return <p role="status">Loading your account…</p>;
  return (
    <div>
      <h1>Import / export sheet</h1>
      <p><Link to={`/sheet/${sheetId}`}>Back to sheet</Link></p>
      <p className="muted">This tool copies data between sheets; it does not move an identity, transfer membership, or delete the original.</p>
      <section className="card">
        <h2>Export JSON</h2>
        <p>The file contains readable entries, notes, names, Types, deleted records and available edit history. Anyone with the file can read them. It contains no sign-in credentials or encryption keys.</p>
        <button disabled={busy || !actor} onClick={() => void download()}>Download unencrypted JSON</button>
      </section>
      <section className="card">
        <h2>Import JSON into this sheet</h2>
        <p>Use a new, empty sheet in the destination account. An interrupted import can be resumed using exactly the same file and destination. Existing unrelated data will not be merged or overwritten.</p>
        <p>Do not edit the destination from another tab or device while importing. The whole import is not a single transaction; a network error may leave completed batches that the same file can resume.</p>
        <p><Link to="/pair/new">Create a new account and sheet</Link> first if needed, then open Import / export JSON there.</p>
        <label htmlFor="sheet-backup-file">IOU sheet backup (JSON, up to 16 MiB)</label>
        <input id="sheet-backup-file" type="file" accept="application/json,.json" disabled={busy || !actor}
          onChange={(event) => { void selectFile(event.target.files?.[0]); event.target.value = ""; }} />
        {preview && backup && <>
          <h3>Review import</h3>
          <dl>
            <dt>Source account</dt><dd>{preview.accountName || "Unnamed account"}</dd>
            <dt>Source sheet</dt><dd>{preview.sheetName || "Unnamed sheet"}</dd>
            <dt>Destination sheet</dt><dd style={{ overflowWrap: "anywhere" }}>{sheetId}</dd>
            <dt>Current entries</dt><dd>{preview.activeEntryCount} ({preview.resumedEntryCount} already imported)</dd>
            <dt>Types</dt><dd>{preview.typeCount}</dd>
            <dt>Archive only</dt><dd>{preview.skippedDeletedCount} deleted entries; {preview.auditHistoryCount} history versions</dd>
          </dl>
          <p>Current entries are re-encrypted for this sheet. Original entry dates, notes and financial fields are retained; authors, entry IDs and server timestamps are new. Account/sheet names and partner membership are not changed.</p>
          <ul>{preview.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
          <details>
            <summary>Preview entries and Types</summary>
            <p>Directions below are from the exporting user's perspective. Showing up to 100 current entries; the JSON file contains the complete archive.</p>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Date</th><th>Amount</th><th>Direction</th><th>Note</th></tr></thead>
                <tbody>{backup.entries.filter((entry) => entry.deletedAtNs === null).slice(0, 100).map((entry) => <tr key={entry.id}>
                  <td>{new Date(entry.payload.ts).toLocaleString()}</td>
                  <td>{(entry.payload.amount_minor / 100).toFixed(2)} {entry.payload.currency}</td>
                  <td>{DIRECTION_LABELS[orientDirection(entry.payload.direction, entry.authorPrincipal === backup.source.exporterPrincipal)]}</td>
                  <td style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.payload.note}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p>Types: {backup.types.map((type) => type.name).join(", ") || "None"}</p>
          </details>
          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.65rem", margin: "1rem 0" }}>
            <input type="checkbox" checked={confirmed} disabled={busy} style={{ width: "auto", marginTop: "0.25rem" }} onChange={(event) => setConfirmed(event.target.checked)} />
            <span>I reviewed this backup and destination. Import its current entries and Types into this sheet.</span>
          </label>
          <button disabled={busy || !confirmed || !actor} onClick={() => void importFile()}>Import into this sheet</button>
        </>}
      </section>
      {busy && <p role="status">Processing sheet data… Keep this page open.</p>}
      {(error || err) && <p role="alert" style={{ color: "var(--debt)" }}>{error || err}</p>}
      {status && <p role="status">{status}</p>}
    </div>
  );
}
