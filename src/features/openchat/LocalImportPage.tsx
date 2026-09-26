import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { SheetKeyProvider, useSheetKey } from "../flows/SheetKeyContext";
import { useActor, unwrap } from "../flows/useActor";
import { usePairTemplates } from "../templates/PairTemplatesContext";
import { addEntryBatch, batchImportContextMatches } from "../entries/batchImport";
import type { EntryPayload } from "../entries/types";
import { buildLocalImportCommittedReceipt, createLocalImportReceiver, type LocalImportDraft, type PendingLocalImport } from "./localImportHandoff";
import { localImportSenderOrigin, localImportSessionNonce } from "./localImportLaunch";
import { applyLocalImportType, prepareLocalImportReview } from "./localImportReview";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext } from "./localProcessorContext";
import { currencyFromUserRecord } from "../settings/defaultCurrency";

type Binding = { senderOrigin: string; senderWindow: Window; sessionNonce: string };
type SheetChoice = { pairId: string; sheetId: string; otherPrincipal: string };
type Review = { payloads: readonly EntryPayload[]; sheet: SheetChoice; importId: string };

/** Deliberately outside IOU's legacy manifest/key/inbox providers. No OC canister is called here. */
export function LocalImportPage() {
  if (window.parent !== window) return <main><h1>Open IOU in its own window</h1><p>Private imports do not run inside an embedded frame. Use the client’s reviewed handoff to open IOU.</p></main>;
  return <AuthProvider><LocalImportSession /></AuthProvider>;
}

function LocalImportSession() {
  const { state, signIn, signOut } = useAuth();
  const [binding] = useState<Binding | undefined>(() => {
    const senderOrigin = localImportSenderOrigin(import.meta.env.VITE_LOCAL_IMPORT_SENDER_ORIGIN);
    const sessionNonce = localImportSessionNonce();
    // The isolated model page uses a separate non-isolated relay. Frames are intentionally refused:
    // credentialless storage cannot inherit IOU auth and real browser tests severed auth popups.
    return senderOrigin && sessionNonce && window.parent === window && window.opener
      ? { senderOrigin, sessionNonce, senderWindow: window.opener as Window } : undefined;
  });
  const [drafts, setDrafts] = useState<readonly PendingLocalImport[]>([]);
  const [notice, setNotice] = useState("");
  const [connectionClosed, setConnectionClosed] = useState(false);
  const previousPrincipal = useRef<string>();
  const principal = state.kind === "authenticated" ? state.principal : undefined;
  useEffect(() => {
    if (previousPrincipal.current && previousPrincipal.current !== principal) {
      setConnectionClosed(true); setDrafts([]);
      setNotice("The IOU account changed. Return to the client and explicitly reconnect before sharing another draft.");
    }
    if (principal) previousPrincipal.current = principal;
  }, [principal]);
  useEffect(() => {
    if (!binding || connectionClosed) return;
    const receiver = createLocalImportReceiver(binding);
    const receive = (event: MessageEvent) => {
      const result = receiver.receive(event);
      if (result.kind === "ignored") return;
      binding.senderWindow.postMessage(result.reply, binding.senderOrigin);
      if (result.kind === "queued") setDrafts(receiver.pending());
      if (result.kind === "rejected") setNotice("The sender offered an invalid or changed draft. Nothing was saved.");
    };
    window.addEventListener("message", receive);
    const timeout = window.setTimeout(() => { receiver.close(); setConnectionClosed(true); setNotice("This handoff expired. Return to the client to explicitly reconnect."); }, 30 * 60_000);
    return () => { clearTimeout(timeout); receiver.close(); window.removeEventListener("message", receive); };
  }, [binding, connectionClosed]);

  return <main style={{ maxWidth: 880, margin: "24px auto", padding: 16, overflowWrap: "anywhere" }}>
    <h1>IOU — private import</h1>
    <p>The client shares only the draft you reviewed. Receiving it does not save an entry. Review the IOU account, sheet and complete entry below before choosing Save in IOU.</p>
    {binding && <p>Sender: <strong>{binding.senderOrigin}</strong>{connectionClosed ? " (closed)" : ""}</p>}
    {!binding && <p>No active handoff. You can export a private local app package below, then use the client’s Review in IOU button. Only a configured local client can send drafts.</p>}
    {notice && <p role="status">{notice}</p>}
    {state.kind === "loading" && <p>Restoring your IOU sign-in…</p>}
    {state.kind === "anonymous" && <button onClick={() => void signIn().catch(() => setNotice("IOU sign-in did not finish. Nothing was saved; try again explicitly."))}>Sign in to IOU</button>}
    {state.kind === "authenticated" && <>
      <p>Signed-in IOU principal: <strong>{state.principal}</strong></p>
      <button className="secondary" onClick={() => void signOut()}>Sign out</button>
      <SheetKeyProvider key={state.principal}>
        <ImportAccount key={state.principal} principal={state.principal} drafts={drafts} binding={connectionClosed ? undefined : binding} />
      </SheetKeyProvider>
    </>}
  </main>;
}

function ImportAccount({ principal, drafts, binding }: { principal: string; drafts: readonly PendingLocalImport[]; binding?: Binding }) {
  const { actor, err } = useActor();
  const [sheets, setSheets] = useState<SheetChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState<SheetChoice>();
  const [defaultCurrency, setDefaultCurrency] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    if (!actor) return;
    void Promise.all([actor.get_my_pairs(), actor.get_my_user()]).then(([pairs, user]) => {
      if (cancelled) return;
      const choices: SheetChoice[] = [];
      for (const pair of pairs as { id: string; active_sheet_id: [] | [string]; archived_at?: [] | [bigint]; other_principal: { toText(): string } }[]) {
        const sheetId = unwrap(pair.active_sheet_id);
        if (typeof sheetId === "string" && /^[a-f0-9]{16}$/.test(sheetId) && unwrap(pair.archived_at) == null) {
          choices.push({ pairId: pair.id, sheetId, otherPrincipal: pair.other_principal.toText() });
        }
      }
      setSheets(choices);
      setDefaultCurrency(currencyFromUserRecord(unwrap(user)) ?? "");
    }).catch(() => { if (!cancelled) setError("IOU could not load your existing sheets. No entry was saved."); });
    return () => { cancelled = true; };
  }, [actor]);
  return <section>
    <h2>Choose the IOU destination</h2>
    <p>This is a fresh, explicit destination choice. The client’s exported recipient label does not bind or switch your IOU account.</p>
    {(error || err) && <p role="alert">{error || err}</p>}
    <label>Existing active sheet <select value={selected} disabled={!!loaded} onChange={(event) => setSelected(event.target.value)}>
      <option value="">Choose a sheet…</option>
      {sheets.map((sheet) => <option key={sheet.sheetId} value={sheet.sheetId}>Account {sheet.pairId} — sheet {sheet.sheetId} — other member {sheet.otherPrincipal}</option>)}
    </select></label>
    {!loaded && <button disabled={!selected} onClick={() => setLoaded(sheets.find((sheet) => sheet.sheetId === selected))}>Load this sheet’s private Types</button>}
    {loaded && <PrivateSheet key={loaded.sheetId} principal={principal} sheet={loaded} defaultCurrency={defaultCurrency}
      drafts={drafts} binding={binding} />}
  </section>;
}

function PrivateSheet({ principal, sheet, defaultCurrency, drafts, binding }: {
  principal: string; sheet: SheetChoice; defaultCurrency: string; drafts: readonly PendingLocalImport[]; binding?: Binding;
}) {
  const { actor } = useActor();
  const { identity } = useAuth();
  const { unwrapFor } = useSheetKey();
  const { shared, loading, ready, readyGeneration, error } = usePairTemplates(sheet.pairId, sheet.sheetId, { requireReadableSlots: true });
  const [activeId, setActiveId] = useState("");
  const [rows, setRows] = useState<LocalImportDraft[]>([]);
  const [typeIds, setTypeIds] = useState<(string | null)[]>([]);
  const [review, setReview] = useState<Review>();
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const current = useRef({ principal, sheetId: sheet.sheetId, binding, actor, identity, ready, readyGeneration });
  current.current = { principal, sheetId: sheet.sheetId, binding, actor, identity, ready, readyGeneration };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  function assertCurrent(captured: typeof current.current) {
    const live = current.current;
    if (!mounted.current || !captured.actor || !captured.identity || !captured.readyGeneration ||
      !live.ready || live.actor !== captured.actor || live.identity !== captured.identity ||
      live.readyGeneration !== captured.readyGeneration ||
      !batchImportContextMatches(captured, live.sheetId, live.principal)) {
      throw new Error("The IOU session or private Type context changed; this draft was not submitted.");
    }
  }

  function chooseDraft(importId: string) {
    const draft = drafts.find((item) => item.importId === importId);
    if (!draft || locked || !ready) return;
    setActiveId(importId); setRows(draft.payload.entries.map((row) => ({ ...row })));
    setTypeIds(draft.payload.entries.map((row) => row.typeId
      ? shared.some((type) => type.id === row.typeId && type.name === row.typeName) ? row.typeId : null
      : ""));
    setReview(undefined); setSaved(false);
    setNotice(draft.payload.entries.some((row) => row.typeId && !shared.some((type) => type.id === row.typeId && type.name === row.typeName))
      ? "A proposed Type is not available in this sheet. Select a current Type or explicitly use none; no foreign defaults are applied." : "");
  }
  function updateRow(index: number, patch: Partial<LocalImportDraft>) {
    setRows(rows.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row)); setReview(undefined);
  }
  function prepare() {
    if (!ready) return;
    try { setReview({ payloads: prepareLocalImportReview({ rows, selectedTypeIds: typeIds, templates: shared, importId: activeId }), sheet, importId: activeId }); setNotice(""); }
    catch (cause) { setNotice((cause as Error).message); setReview(undefined); }
  }
  async function save() {
    if (!review || busy || saved || !actor || !identity || !ready || !readyGeneration) return;
    const captured = { ...current.current, sheetId: review.sheet.sheetId };
    const stillCurrent = () => assertCurrent(captured);
    setLocked(true); setBusy(true); setNotice("");
    try {
      const key = await unwrapFor(review.sheet.sheetId);
      stillCurrent();
      const acknowledgement = await addEntryBatch({ actor: captured.actor, sheetId: review.sheet.sheetId, payloads: [...review.payloads],
        // The same canonical 32-byte id is reused on every explicit outcome-unknown retry. This
        // is an import identity only, NOT a claim that OpenChat verified a message or membership.
        messageHandle: review.importId, relayId: "", sheetKey: key, beforeMutate: stillCurrent });
      stillCurrent();
      setSaved(true); setNotice(`Saved ${acknowledgement.accepted_count} entries in the reviewed IOU sheet${acknowledgement.replayed ? " (the earlier save was already accepted)" : ""}.`);
      // A receipt failure cannot turn an already-confirmed ledger save into an unknown result.
      // Also do not revive a relay connection that expired while encryption/network I/O awaited.
      if (binding && current.current.binding === binding) {
        try { binding.senderWindow.postMessage(buildLocalImportCommittedReceipt(binding.sessionNonce, review.importId, acknowledgement), binding.senderOrigin); }
        catch { setNotice("Saved in the reviewed IOU sheet. The client could not be notified; do not submit a new proposal to retry this save."); }
      }
    } catch {
      if (mounted.current) setNotice("The save did not return a confirmed result. The exact reviewed data, account, sheet and import ID are locked. Check IOU, or explicitly retry this same save; do not create a new proposal to retry it.");
    } finally { if (mounted.current) setBusy(false); }
  }
  async function exportPackage() {
    if (!ready) return;
    const captured = { ...current.current };
    try {
      const context = createLocalProcessorContext(shared, defaultCurrency);
      // Explicit setup download only; no message/source data exists in these requests. Never fetch
      // an app processor during inference or include this private vocabulary in public build files.
      const [metadataResponse, sourceResponse] = await Promise.all([
        fetch("/openchat/local-processor-v1.sha256.json", { credentials: "omit", cache: "no-store" }),
        fetch("/openchat/local-processor-v1.js", { credentials: "omit", cache: "no-store" }),
      ]);
      if (!metadataResponse.ok || !sourceResponse.ok) throw new Error();
      const metadata = await metadataResponse.json() as { sha256: string; byteLength: number };
      if (!/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1 || metadata.byteLength > 512 * 1024) throw new Error();
      const source = await sourceResponse.arrayBuffer();
      const actual = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", source)), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (actual !== metadata.sha256 || source.byteLength !== metadata.byteLength) throw new Error();
      assertCurrent(captured);
      const catalog = createIouLocalAppPackage(`${location.origin}/openchat/import`, metadata, {
        processorContext: context,
        recipientLabel: `IOU account ${sheet.pairId}; sheet ${sheet.sheetId}. Review-only label: choose the receiving IOU account and sheet again before saving.`,
      });
      const download = (name: string, value: Blob) => { const url = URL.createObjectURL(value); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
      download("iou-private-local-app.json", new Blob([JSON.stringify(catalog, null, 2)], { type: "application/json" }));
      download("iou-local-processor.js", new Blob([source], { type: "text/javascript" }));
      setNotice("Downloaded the private setup catalog and public processor. Import both locally in the client. The catalog includes this account’s Type names/keywords and currency; keep it private.");
    } catch { setNotice("The app package could not be verified/exported. No entry or source message was sent."); }
  }

  return <section>
    <h2>Sheet {sheet.sheetId}</h2>
    <p>Account {sheet.pairId}; other member {sheet.otherPrincipal}. Your entries are encrypted locally for this sheet before saving.</p>
    {(loading || (!ready && !error)) && <p>Loading this sheet’s Types…</p>}{error && <p role="alert">Could not load this sheet’s Types. Saving is disabled.</p>}
    <details><summary>Private local-client setup</summary>
      <p>Exporting shares no chat or image. The downloaded catalog contains this account’s private Type names, trigger words, directions and default currency ({defaultCurrency || "unset"}); model prompt profiles are authored by IOU. The recipient label is a reminder, not an automatic destination binding.</p>
      <ul>{shared.map((type) => <li key={type.id}>{type.name}: {type.direction === "credit" ? "Owed to you" : "You owe"}; {type.txn_type}; keywords: {(type.keywords ?? []).join(", ") || "name only"}</li>)}</ul>
      <button disabled={!ready || loading || !!error} onClick={() => void exportPackage()}>Download private setup catalog and processor</button>
    </details>
    <h2>Review a received draft</h2>
    {!drafts.length && <p>No draft has been received. Nothing is saved automatically.</p>}
    <select aria-label="Received draft" value={activeId} disabled={locked || !ready || loading || !!error} onChange={(event) => chooseDraft(event.target.value)}>
      <option value="">Choose a received draft…</option>{drafts.map((draft, index) => <option key={draft.importId} value={draft.importId}>Draft {index + 1} — {draft.payload.entries.length} entries — {draft.importId}</option>)}
    </select>
    {rows.map((row, index) => <fieldset key={index} disabled={locked} style={{ margin: "16px 0", display: "grid", gap: 10 }}>
      <legend>Entry {index + 1}</legend>
      {row.typeName && <p>Proposed Type: {row.typeName} ({row.typeId})</p>}
      <label>Type <select value={typeIds[index] === null ? "" : typeIds[index] ? `type:${typeIds[index]}` : "none"} onChange={(event) => {
        const id = event.target.value === "none" ? "" : event.target.value.slice(5); setTypeIds(typeIds.map((value, i) => i === index ? id : value));
        updateRow(index, applyLocalImportType(row, id, shared));
      }}><option value="" disabled>Choose a current Type or None…</option><option value="none">None — use reviewed fields only</option>{shared.map((type) => <option value={`type:${type.id}`} key={type.id}>{type.name}</option>)}</select></label>
      <label>Kind <select value={row.kind} onChange={(event) => updateRow(index, { kind: event.target.value as LocalImportDraft["kind"] })}><option value="iou">IOU</option><option value="settlement">Settlement</option></select></label>
      <label>Amount <input type="number" min="0.01" step="0.01" value={Number.isFinite(row.amount) ? row.amount : ""} onChange={(event) => updateRow(index, { amount: Number(event.target.value) })} /></label>
      <label>Currency <input maxLength={3} value={row.currency} onChange={(event) => updateRow(index, { currency: event.target.value.toUpperCase() })} /></label>
      <label>Direction <select value={row.direction} onChange={(event) => updateRow(index, { direction: event.target.value as LocalImportDraft["direction"] })}><option value="credit">Owed to you</option><option value="debt">You owe</option></select></label>
      <label>Date <input type="date" value={row.date ?? ""} onChange={(event) => updateRow(index, { date: event.target.value })} /></label>
      <label>Note <textarea rows={3} maxLength={4096} value={row.note ?? ""} onChange={(event) => updateRow(index, { note: event.target.value })} /></label>
    </fieldset>)}
    {!!rows.length && !locked && <button onClick={prepare} disabled={!ready || loading || !!error}>Review exact encrypted entry contents</button>}
    {review && <section><h3>Final save review</h3><p>IOU principal {principal}; account {review.sheet.pairId}; sheet {review.sheet.sheetId}.</p>
      <p>All stored fields are below, including any selected Type fees and due schedule. No raw message or image is included. Dates marked ts/due_ts are UTC milliseconds.</p>
      <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(review.payloads, null, 2)}</pre>
      <button disabled={busy || saved || !actor || !ready || loading || !!error} onClick={() => void save()}>{saved ? "Saved in IOU" : busy ? "Saving encrypted entries…" : locked ? "Retry the same save in IOU" : "Save in IOU"}</button>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
