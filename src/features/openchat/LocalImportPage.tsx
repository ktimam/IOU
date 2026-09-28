import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { SheetKeyProvider, useSheetKey } from "../flows/SheetKeyContext";
import { useActor, unwrap } from "../flows/useActor";
import { usePairTemplates } from "../templates/PairTemplatesContext";
import { addEntryBatch, batchImportContextMatches } from "../entries/batchImport";
import type { EntryPayload } from "../entries/types";
import { buildLocalImportCommittedReceipt, createLocalImportReceiver, type LocalImportDraft, type PendingLocalImport } from "./localImportHandoff";
import { localImportNativeBootstrap, localImportSenderOrigin, localImportSessionNonce } from "./localImportLaunch";
import { createLocalImportConsent, type LocalImportConsentState } from "./localImportConsent";
import { applyLocalImportType, prepareLocalImportReview } from "./localImportReview";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext } from "./localProcessorContext";
import { createLocalSetupDownloadFiles, createLocalSetupDownloadOwner, localSetupContextMatches, LocalSetupDownloads, verifiedLocalSetupProcessor } from "./LocalSetupDownloads";
import { currencyFromUserRecord } from "../settings/defaultCurrency";

type Binding = { senderOrigin: string; senderWindow: Window; sessionNonce: string; isCurrent?: () => boolean };
type ImportTransport = {
  binding?: Binding;
  receiver?: ReturnType<typeof createLocalImportReceiver>;
  consent?: ReturnType<typeof createLocalImportConsent>;
  closed: boolean;
};
type SheetChoice = { pairId: string; sheetId: string; otherPrincipal: string };
type Review = { payloads: readonly EntryPayload[]; sheet: SheetChoice; importId: string };

/** Deliberately outside IOU's legacy manifest/key/inbox providers. No OC canister is called here. */
export function LocalImportPage() {
  if (window.parent !== window) return <main><h1>Open IOU in its own window</h1><p>Private imports do not run inside an embedded frame. Use the client’s reviewed handoff to open IOU.</p></main>;
  return <AuthProvider><LocalImportSession /></AuthProvider>;
}

function LocalImportSession() {
  const { state, signIn, signOut } = useAuth();
  const [launch] = useState(() => {
    const senderOrigin = localImportSenderOrigin(import.meta.env.VITE_LOCAL_IMPORT_SENDER_ORIGIN);
    const sessionNonce = localImportSessionNonce();
    // The isolated model page uses a separate non-isolated relay. Frames are intentionally refused:
    // credentialless storage cannot inherit IOU auth and real browser tests severed auth popups.
    const senderWindow = window.parent === window && window.opener ? window.opener as Window : undefined;
    return { senderWindow, native: localImportNativeBootstrap(),
      configured: senderOrigin && sessionNonce && senderWindow ? { senderOrigin, sessionNonce, senderWindow } : undefined };
  });
  const [binding, setBinding] = useState<Binding | undefined>(launch.configured);
  const [consentState, setConsentState] = useState<LocalImportConsentState>();
  const [drafts, setDrafts] = useState<readonly PendingLocalImport[]>([]);
  const [notice, setNotice] = useState("");
  const [connectionClosed, setConnectionClosed] = useState(false);
  const transport = useRef<ImportTransport>({ closed: false });
  const previousPrincipal = useRef<string>();
  const principal = state.kind === "authenticated" ? state.principal : undefined;
  const livePrincipal = useRef(principal);
  livePrincipal.current = principal;
  const accountUnchanged = () => previousPrincipal.current === undefined || previousPrincipal.current === livePrincipal.current;

  function closeConnection(message: string) {
    const active = transport.current;
    active.closed = true; active.consent?.close(); active.receiver?.close(); active.binding = undefined;
    setBinding(undefined); setConnectionClosed(true); setConsentState({ kind: "closed" });
    // Reset native review state too; an accepted draft is not authority to save after cancellation.
    if (launch.native) setDrafts([]);
    setNotice(message);
  }

  function allowNativeConnection() {
    const active = transport.current;
    if (active.closed || !active.consent || !accountUnchanged()) return;
    try {
      if (launch.senderWindow?.closed) throw new Error("Sender closed");
      const approved = active.consent.approve();
      if (!approved) { closeConnection("This connection request expired. Start a fresh handoff from the client."); return; }
      const accepted: Binding = { ...approved.binding, senderWindow: approved.binding.senderWindow as Window,
        isCurrent: () => transport.current === active && !active.closed && active.consent?.isConnected() === true &&
          !launch.senderWindow?.closed && accountUnchanged() };
      // Install before replying: a prompt sender's hello cannot race receiver creation.
      active.binding = accepted; active.receiver = createLocalImportReceiver(accepted);
      setBinding(accepted); setConsentState(active.consent.state());
      accepted.senderWindow.postMessage(approved.reply, accepted.senderOrigin);
      setNotice("This exact local connection is allowed once. Receiving a draft will not save it.");
    } catch { closeConnection("The local connection could not be accepted. Nothing was saved; start a fresh handoff."); }
  }

  useEffect(() => {
    if (previousPrincipal.current && previousPrincipal.current !== principal) {
      closeConnection("The IOU account changed. Return to the client and explicitly reconnect before sharing another draft.");
      setDrafts([]);
    }
    if (principal) previousPrincipal.current = principal;
  }, [principal]);
  useEffect(() => {
    const active: ImportTransport = { closed: false, binding: launch.configured,
      receiver: launch.configured ? createLocalImportReceiver(launch.configured) : undefined,
      consent: launch.native && launch.senderWindow ? createLocalImportConsent({ senderWindow: launch.senderWindow }) : undefined };
    transport.current = active;
    setBinding(active.binding); setConsentState(active.consent?.state()); setConnectionClosed(false);
    const receive = (event: MessageEvent) => {
      if (active.closed || transport.current !== active || !accountUnchanged()) return;
      const receiver = active.receiver;
      const binding = active.binding;
      if (!receiver || !binding) {
        const pending = active.consent?.receive(event);
        if (pending?.kind === "closed") closeConnection("This local request changed or expired. Start a fresh handoff; nothing was saved.");
        else if (pending) setConsentState(pending);
        return;
      }
      if (binding.isCurrent && !binding.isCurrent()) { closeConnection("This local connection expired or closed. Nothing further will be accepted."); return; }
      const result = receiver.receive(event);
      if (result.kind === "ignored") return;
      try { binding.senderWindow.postMessage(result.reply, binding.senderOrigin); }
      catch { closeConnection("The sender is unavailable. Check the receiving app before another handoff."); return; }
      if (result.kind === "queued") setDrafts(receiver.pending());
      if (result.kind === "rejected") setNotice("The sender offered an invalid or changed draft. Nothing was saved.");
    };
    window.addEventListener("message", receive);
    const timeout = active.consent
      ? window.setInterval(() => {
        if (!active.closed && (launch.senderWindow?.closed || active.consent?.state().kind === "closed")) {
          closeConnection("This local connection expired or closed. Return to the client to explicitly reconnect.");
        }
      }, 1000)
      : window.setTimeout(() => { if (active.binding) closeConnection("This handoff expired. Return to the client to explicitly reconnect."); }, 30 * 60_000);
    const pageClosed = () => { active.closed = true; active.consent?.close(); active.receiver?.close(); };
    const navigationClosed = () => {
      pageClosed();
      if (active.consent && transport.current === active) closeConnection("This page’s local connection closed. A save already submitted may still complete; check IOU before retrying.");
    };
    window.addEventListener("pagehide", navigationClosed);
    return () => { clearTimeout(timeout); clearInterval(timeout); pageClosed(); window.removeEventListener("message", receive); window.removeEventListener("pagehide", navigationClosed); };
  }, [launch]);

  return <main style={{ maxWidth: 880, margin: "24px auto", padding: 16, overflowWrap: "anywhere" }}>
    <h1>IOU — private import</h1>
    <p>The client shares only the draft you reviewed. Receiving it does not save an entry. Review the IOU account, sheet and complete entry below before choosing Save in IOU.</p>
    {binding && <p>Sender: <strong>{binding.senderOrigin}</strong>{connectionClosed ? " (closed)" : ""}</p>}
    {!binding && <p>No active handoff. You can export a private local app package below, then use the client’s reviewed handoff. A new native local sender needs your permission for this connection only.</p>}
    {consentState?.kind === "waiting" && <p>Waiting for a local connection request. No draft has been accepted.</p>}
    {consentState?.kind === "pending" && <section aria-label="Local connection consent">
      <h2>Allow this local connection once?</h2>
      <p>Unverified local sender: <strong>{consentState.candidate.senderOrigin}</strong></p>
      <p>This address does not prove which app opened it. Allow only if you just started this handoff yourself and the address matches the relay you opened. Permission covers this exact window and address, not other localhost ports.</p>
      <p>Nothing has been accepted or saved. You will still review the receiving account, sheet and every entry before Save in IOU. This request expires after two minutes.</p>
      <button onClick={allowNativeConnection}>Allow this connection once</button>
      <button className="secondary" onClick={() => closeConnection("Local connection rejected. No draft was accepted or saved.")}>Reject connection</button>
    </section>}
    {binding?.isCurrent && !connectionClosed && <button className="secondary" onClick={() => closeConnection("Local connection closed. Local drafts were discarded. A save already submitted may still complete; check IOU before retrying.")}>Close local connection</button>}
    {notice && <p role="status">{notice}</p>}
    {state.kind === "loading" && <p>Restoring your IOU sign-in…</p>}
    {state.kind === "anonymous" && <button onClick={() => void signIn().catch(() => setNotice("IOU sign-in did not finish. Nothing was saved; try again explicitly."))}>Sign in to IOU</button>}
    {state.kind === "authenticated" && <>
      <p>Signed-in IOU principal: <strong>{state.principal}</strong></p>
      <button className="secondary" onClick={() => { closeConnection("Signed out of this handoff. Reconnect explicitly before sharing another draft."); void signOut(); }}>Sign out</button>
      <SheetKeyProvider key={state.principal}>
        <ImportAccount key={`${state.principal}:${launch.native && connectionClosed ? "closed" : "open"}`} principal={state.principal} drafts={drafts} binding={connectionClosed ? undefined : binding} />
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
  const setupContext = useRef({ ...current.current, pairId: sheet.pairId, shared, defaultCurrency });
  setupContext.current = { ...current.current, pairId: sheet.pairId, shared, defaultCurrency };
  const [setup, setSetup] = useState<ReturnType<typeof createLocalSetupDownloadFiles> & { context: typeof setupContext.current }>();
  const [preparingSetup, setPreparingSetup] = useState(false);
  const setupPending = useRef(false);
  const setupOwner = useRef(createLocalSetupDownloadOwner());
  const setupCurrent = !!setup && localSetupContextMatches(setup.context, setupContext.current);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; setupOwner.current.clear(); }; }, []);
  useEffect(() => { if (setup && !setupCurrent) clearSetup(); }, [setup, setupCurrent]);

  function clearSetup() { setupOwner.current.clear(); setSetup(undefined); }

  function assertCurrent(captured: typeof current.current) {
    const live = current.current;
    if (!mounted.current || !captured.actor || !captured.identity || !captured.readyGeneration ||
      (captured.binding?.isCurrent && !captured.binding.isCurrent()) ||
      !live.ready || live.actor !== captured.actor || live.identity !== captured.identity ||
      live.readyGeneration !== captured.readyGeneration ||
      !batchImportContextMatches(captured, live.sheetId, live.principal)) {
      throw new Error("The IOU session or private Type context changed; this draft was not submitted.");
    }
  }

  function assertSetupCurrent(captured: typeof setupContext.current) {
    assertCurrent(captured);
    if (!localSetupContextMatches(captured, setupContext.current)) throw new Error("The private setup context changed");
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
  async function prepareSetupFiles() {
    if (!ready || setupPending.current) return;
    const captured = { ...setupContext.current };
    setupPending.current = true;
    setPreparingSetup(true); clearSetup(); setNotice("");
    try {
      const context = createLocalProcessorContext(shared, defaultCurrency);
      // Explicit setup download only; no message/source data exists in these requests. Never fetch
      // an app processor during inference or include this private vocabulary in public build files.
      const { metadata, source } = await verifiedLocalSetupProcessor();
      assertSetupCurrent(captured);
      const catalog = createIouLocalAppPackage(`${location.origin}/openchat/import`, metadata, {
        processorContext: context,
        recipientLabel: `IOU account ${sheet.pairId}; sheet ${sheet.sheetId}. Review-only label: choose the receiving IOU account and sheet again before saving.`,
      });
      const prepared = { ...createLocalSetupDownloadFiles(catalog, source), context: captured };
      setupOwner.current.replace(prepared);
      setSetup(prepared);
      setNotice("Setup files verified and ready. Nothing has been downloaded yet. Use each download button below.");
    } catch { if (mounted.current) setNotice("The app package could not be verified/prepared. No entry or source message was sent."); }
    finally { setupPending.current = false; if (mounted.current) setPreparingSetup(false); }
  }

  return <section>
    <h2>Sheet {sheet.sheetId}</h2>
    <p>Account {sheet.pairId}; other member {sheet.otherPrincipal}. Your entries are encrypted locally for this sheet before saving.</p>
    {(loading || (!ready && !error)) && <p>Loading this sheet’s Types…</p>}{error && <p role="alert">Could not load this sheet’s Types. Saving is disabled.</p>}
    <details><summary>Private local-client setup</summary>
      <p>Exporting shares no chat or image. The downloaded catalog contains this account’s private Type names, trigger words, directions and default currency ({defaultCurrency || "unset"}); model prompt profiles are authored by IOU. The recipient label is a reminder, not an automatic destination binding.</p>
      <ul>{shared.map((type) => <li key={type.id}>{type.name}: {type.direction === "credit" ? "Owed to you" : "You owe"}; {type.txn_type}; keywords: {(type.keywords ?? []).join(", ") || "name only"}</li>)}</ul>
      <button disabled={!ready || loading || !!error || preparingSetup} onClick={() => void prepareSetupFiles()}>{preparingSetup ? "Verifying setup files…" : "Prepare setup files"}</button>
      {setup && <LocalSetupDownloads files={setup.files} disabled={!setupCurrent || loading || !!error}
        assertCurrent={() => assertSetupCurrent(setup.context)}
        onRequest={(file) => setNotice(`Download requested: ${file.name}. Check your browser’s Downloads list to confirm it was saved.`)}
        onError={() => {
          clearSetup();
          setNotice("The setup file could not be requested, or the IOU session changed. Prepare fresh setup files before downloading.");
        }} />}
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
