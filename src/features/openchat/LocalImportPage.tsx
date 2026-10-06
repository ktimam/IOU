import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { SignInButtons } from "../auth/SignInButtons";
import { SheetKeyProvider, useSheetKey } from "../flows/SheetKeyContext";
import { useActor, unwrap } from "../flows/useActor";
import { usePairTemplates } from "../templates/PairTemplatesContext";
import { TemplatesProvider } from "../templates/TemplatesContext";
import { PreferencesProvider } from "../settings/usePreferences";
import { ToastProvider } from "../ui/Toasts";
import { Layout } from "../../app/Layout";
import { SheetPage } from "../entries/SheetPage";
import { addEntryBatch } from "../entries/batchImport";
import type { EntryPayload } from "../entries/types";
import { buildLocalImportCommittedReceipt, createLocalImportReceiver, decryptPendingLocalImport, type PendingLocalImport } from "./localImportHandoff";
import { localImportNativeBootstrap, localImportSenderOrigin, localImportSessionNonce } from "./localImportLaunch";
import { createLocalImportConsent, type LocalImportConsentState } from "./localImportConsent";
import { LocalDeliveryKeyProvider, useLocalDeliveryKey } from "./LocalDeliveryKeyProvider";
import { createLocalDeliveryEncryption, type IouDeliveryContext } from "./localImportEncryption";
import { createLocalImportSaveLock, LocalImportReviewError, localImportRecipient, localImportSheetDrafts, type LocalSheetImport } from "./localImportSheet";
import { localAppSenderWindow } from "./localAppSender";
import { LocalImportNavigationProvider } from "./LocalImportNavigation";
import { host as backendHost, canisterId as backendCanisterId } from "../auth/config";

type Binding = { senderOrigin: string; senderWindow: Window; sessionNonce: string; isCurrent?: () => boolean };
type ImportTransport = {
  binding?: Binding;
  receiver?: ReturnType<typeof createLocalImportReceiver>;
  consent?: ReturnType<typeof createLocalImportConsent>;
  closed: boolean;
};

/** Reuse normal sheet/review UI without mounting legacy registration/inbox providers. */
export function LocalImportPage() {
  return <AuthProvider><LocalImportSession /></AuthProvider>;
}

function LocalImportSession() {
  const { state } = useAuth();
  const [launch] = useState(() => {
    const senderOrigin = localImportSenderOrigin(import.meta.env.VITE_LOCAL_IMPORT_SENDER_ORIGIN);
    const sessionNonce = localImportSessionNonce();
    const senderWindow = localAppSenderWindow(window);
    return { senderWindow, framed: window.parent !== window, native: localImportNativeBootstrap(),
      configured: senderOrigin && sessionNonce && senderWindow ? { senderOrigin, sessionNonce, senderWindow } : undefined };
  });
  const [binding, setBinding] = useState<Binding | undefined>(launch.configured);
  const [consentState, setConsentState] = useState<LocalImportConsentState>();
  const [drafts, setDrafts] = useState<readonly PendingLocalImport[]>([]);
  const [notice, setNotice] = useState("");
  const transport = useRef<ImportTransport>({ closed: false });
  const previousPrincipal = useRef<string>();
  const principal = state.kind === "authenticated" ? state.principal : undefined;
  const livePrincipal = useRef(principal);
  livePrincipal.current = principal;
  const accountUnchanged = () => previousPrincipal.current === undefined || previousPrincipal.current === livePrincipal.current;

  function closeConnection(message: string) {
    const active = transport.current;
    active.closed = true; active.consent?.close(); active.receiver?.close(); active.binding = undefined;
    setBinding(undefined); setConsentState({ kind: "closed" }); setDrafts([]); setNotice(message);
  }
  function allowNativeConnection() {
    const active = transport.current;
    if (active.closed || !active.consent || !accountUnchanged()) return;
    try {
      if (launch.senderWindow?.closed) throw new Error("Sender closed");
      const approved = active.consent.approve();
      if (!approved) { closeConnection("This request expired. Return to OpenChat to reopen the same card."); return; }
      const accepted: Binding = { ...approved.binding, senderWindow: approved.binding.senderWindow as Window,
        isCurrent: () => transport.current === active && !active.closed && active.consent?.isConnected() === true &&
          !launch.senderWindow?.closed && accountUnchanged() };
      active.binding = accepted; active.receiver = createLocalImportReceiver({ ...accepted, destination: `${location.origin}/openchat/import` });
      setBinding(accepted); setConsentState(active.consent.state());
      accepted.senderWindow.postMessage(approved.reply, accepted.senderOrigin);
      setNotice("");
    } catch { closeConnection("The connection could not be accepted. Nothing was saved. Return to OpenChat to reopen the same card."); }
  }
  useEffect(() => {
    if (previousPrincipal.current && previousPrincipal.current !== principal) {
      closeConnection("The IOU account changed. Return to OpenChat to reconnect before sending another draft.");
    }
    if (principal) previousPrincipal.current = principal;
  }, [principal]);
  useEffect(() => {
    const active: ImportTransport = { closed: false, binding: launch.configured,
      receiver: launch.configured ? createLocalImportReceiver({ ...launch.configured, destination: `${location.origin}/openchat/import` }) : undefined,
      consent: launch.native && launch.senderWindow ? createLocalImportConsent({ senderWindow: launch.senderWindow }) : undefined };
    transport.current = active; setBinding(active.binding); setConsentState(active.consent?.state());
    const receive = (event: MessageEvent) => {
      if (active.closed || transport.current !== active || !accountUnchanged()) return;
      const receiver = active.receiver, binding = active.binding;
      if (!receiver || !binding) {
        const pending = active.consent?.receive(event);
        if (pending?.kind === "closed") closeConnection("This request changed or expired. Return to OpenChat; nothing was saved.");
        else if (pending) {
          setConsentState(pending);
          // Receiving only ciphertext needs no second transport prompt. The exact parent,
          // loopback origin and nonce were checked by consent.receive(); saving still requires
          // authenticated recipient decryption and the normal sheet's explicit Review & add.
          if (pending.kind === "pending" && window.parent !== window && launch.senderWindow === window.parent) allowNativeConnection();
        }
        return;
      }
      if (binding.isCurrent && !binding.isCurrent()) { closeConnection("This request expired or closed. Nothing further will be accepted."); return; }
      const result = receiver.receive(event);
      if (result.kind === "ignored") return;
      try { binding.senderWindow.postMessage(result.reply, binding.senderOrigin); }
      catch { closeConnection("The sender is unavailable. Check IOU before retrying the same card."); return; }
      if (result.kind === "queued") setDrafts(receiver.pending());
      if (result.kind === "rejected") setNotice("The draft is invalid or changed. Nothing was saved.");
    };
    window.addEventListener("message", receive);
    const timeout = active.consent ? window.setInterval(() => {
      if (!active.closed && (launch.senderWindow?.closed || active.consent?.state().kind === "closed")) {
        closeConnection("This connection expired or closed. Return to OpenChat to reopen the same card.");
      }
    }, 1000) : window.setTimeout(() => { if (active.binding) closeConnection("This handoff expired. Return to OpenChat to reopen the same card."); }, 30 * 60_000);
    const pageClosed = () => { active.closed = true; active.consent?.close(); active.receiver?.close(); };
    const navigationClosed = () => {
      pageClosed();
      if (transport.current === active) closeConnection("The connection closed. A submitted save may still complete; check IOU before retrying.");
    };
    window.addEventListener("pagehide", navigationClosed);
    return () => { clearTimeout(timeout); clearInterval(timeout); pageClosed(); window.removeEventListener("message", receive); window.removeEventListener("pagehide", navigationClosed); };
  }, [launch]);

  return <PreferencesProvider key={principal ?? state.kind}><TemplatesProvider><SheetKeyProvider><ToastProvider>
    <LocalDeliveryKeyProvider><LocalImportNavigationProvider enabled={launch.framed}><Layout>
    {state.kind === "loading" && <p className="muted">Restoring your IOU sign-in…</p>}
    {state.kind === "anonymous" && <div className="card"><h1>Sign in to IOU</h1><p>Sign in to the account connected in OpenChat to review this draft.</p><SignInButtons /></div>}
    {consentState?.kind === "pending" && <section className="card" aria-label="Local connection consent">
      <h2>Open this draft from OpenChat?</h2>
      <p>Allow this connection only if you just chose Add to IOU. Nothing is saved until you review and confirm it in your sheet.</p>
      <p className="muted small">Requesting address: {consentState.candidate.senderOrigin}. This address alone does not identify an app.</p>
      <button onClick={allowNativeConnection}>Continue</button>{" "}
      <button className="secondary" onClick={() => closeConnection("Connection cancelled. Nothing was saved.")}>Cancel</button>
    </section>}
    {notice && <p role="status">{notice}</p>}
    {principal && binding && drafts.length === 1 && <ImportAccount key={principal} principal={principal} draft={drafts[0]} binding={binding}
      isCurrent={() => !transport.current.closed && transport.current.binding === binding && accountUnchanged()} />}
    {principal && binding && drafts.length === 0 && <p className="muted">Opening your draft…</p>}
    {drafts.length > 1 && <p role="alert">More than one handoff arrived. Return to OpenChat and reopen one card at a time; nothing was saved.</p>}
    {!binding && !notice && consentState?.kind !== "pending" && <p className="muted">Open the card with Add to IOU in OpenChat.</p>}
    </Layout></LocalImportNavigationProvider></LocalDeliveryKeyProvider>
  </ToastProvider></SheetKeyProvider></TemplatesProvider></PreferencesProvider>;
}

function ImportAccount({ principal, draft, binding, isCurrent }: {
  principal: string; draft: PendingLocalImport; binding: Binding; isCurrent: () => boolean;
}) {
  const { actor, err } = useActor();
  const [loaded, setLoaded] = useState<{ actor: unknown; context: IouDeliveryContext }>();
  const [error, setError] = useState("");
  const current = useRef({ principal, draft, binding, isCurrent });
  current.current = { principal, draft, binding, isCurrent };
  useEffect(() => {
    let cancelled = false; setLoaded(undefined); setError("");
    if (!actor) return;
    void (async () => {
      const context = localImportRecipient(draft.envelope.recipientContext, { principal, backendHost, backendCanisterId });
      const pairs = await actor.get_my_pairs();
      const pair = pairs.find((item: { id: string; active_sheet_id: [] | [string]; archived_at?: [] | [bigint] }) => item.id === context.pairId && unwrap(item.active_sheet_id) === context.sheetId && unwrap(item.archived_at) == null);
      if (!pair) throw new Error("The linked sheet is no longer active in this IOU account. Reconnect IOU in OpenChat.");
      if (!cancelled && current.current.draft === draft && current.current.isCurrent()) setLoaded({ actor, context });
    })().catch(() => { if (!cancelled) setError("This draft could not be opened in the connected IOU account and active sheet. Check your sign-in, or reconnect IOU in OpenChat."); });
    return () => { cancelled = true; };
  }, [actor, principal, draft, binding]);
  if (error || err) return <p role="alert">{error || "IOU could not load the connected account. Try again when it is available."}</p>;
  if (!loaded || loaded.actor !== actor) return <p className="muted">Opening the connected sheet…</p>;
  return <ImportedSheet key={`${principal}:${draft.importId}:${loaded.context.sheetId}`} context={loaded.context} draft={draft} binding={binding} isCurrent={isCurrent} />;
}

function ImportedSheet({ context, draft, binding, isCurrent }: {
  context: IouDeliveryContext; draft: PendingLocalImport; binding: Binding; isCurrent: () => boolean;
}) {
  const { actor } = useActor();
  const { identity } = useAuth();
  const { unwrapFor } = useSheetKey();
  const deliveryKeys = useLocalDeliveryKey();
  const types = usePairTemplates(context.pairId, context.sheetId, { requireReadableSlots: true });
  const [drafts, setDrafts] = useState<LocalSheetImport["drafts"]>([]);
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const mounted = useRef(true), pending = useRef(false), completed = useRef(false);
  const saveLock = useRef<ReturnType<typeof createLocalImportSaveLock>>();
  const current = useRef({ actor, identity, draft, binding, context, ready: types.ready, generation: types.readyGeneration, isCurrent });
  current.current = { actor, identity, draft, binding, context, ready: types.ready, generation: types.readyGeneration, isCurrent };
  const readyContext = useRef<typeof current.current>();
  function assertCurrent(captured = readyContext.current) {
    const live = current.current;
    if (!mounted.current || !captured || !captured.actor || !captured.identity || !live.ready ||
        !live.isCurrent() || (live.binding.isCurrent && !live.binding.isCurrent()) ||
        live.actor !== captured.actor || live.identity !== captured.identity || live.draft !== captured.draft ||
        live.context !== captured.context || live.binding !== captured.binding || live.generation !== captured.generation) {
      throw new Error("The IOU account, sheet, Types or connection changed. Nothing further was submitted.");
    }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    setDrafts([]); readyContext.current = undefined; setNotice("");
    if (!types.ready || !types.readyGeneration || !deliveryKeys.ready || !actor || !identity) return;
    const captured = { ...current.current };
    const stillCurrent = () => { if (cancelled) throw new Error("Draft review changed"); assertCurrent(captured); };
    void (async () => {
      const key = await deliveryKeys.load(false); stillCurrent();
      const recipient = await createLocalDeliveryEncryption(key.publicKey, context);
      const payload = await decryptPendingLocalImport(draft, key.privateKey, recipient, `${location.origin}/openchat/import`, stillCurrent);
      stillCurrent();
      const prepared = localImportSheetDrafts(payload.entries, types.shared, draft.importId);
      readyContext.current = captured;
      saveLock.current ??= createLocalImportSaveLock(draft.importId, prepared.length);
      setDrafts(prepared);
    })().catch(error => { if (!cancelled) setNotice(error instanceof LocalImportReviewError ? error.message : "This draft could not be opened for the connected account, sheet and current Types. Review the card in OpenChat or reconnect IOU; nothing was saved."); });
    return () => { cancelled = true; };
  }, [actor, identity, draft, binding, context, types.ready, types.readyGeneration, deliveryKeys.ready]);

  async function save(payloads: readonly EntryPayload[]) {
    assertCurrent();
    if (pending.current || completed.current || dismissed || !saveLock.current) throw new Error("This draft is already being handled.");
    const captured = readyContext.current!;
    const exact = saveLock.current(payloads);
    pending.current = true;
    try {
      const key = await unwrapFor(context.sheetId); assertCurrent(captured);
      const acknowledgement = await addEntryBatch({ actor: captured.actor!, sheetId: context.sheetId, payloads: exact,
        messageHandle: draft.importId, relayId: "", sheetKey: key, beforeMutate: () => assertCurrent(captured) });
      assertCurrent(captured); completed.current = true; setSaved(true);
      setNotice(acknowledgement.replayed ? "Saved in IOU — the earlier save was already accepted." : "Saved in IOU.");
      try { binding.senderWindow.postMessage(buildLocalImportCommittedReceipt(binding.sessionNonce, draft.importId, acknowledgement), binding.senderOrigin); }
      catch { setNotice("Saved in IOU. OpenChat could not be notified; do not create another proposal to retry this save."); }
    } catch {
      setNotice("The save did not return a confirmed result. Check this sheet before retrying the same reviewed fields.");
      throw new Error("The save did not return a confirmed result. Check this sheet before retrying the same reviewed fields.");
    } finally { pending.current = false; }
  }
  const localImport: LocalSheetImport = { sheetId: context.sheetId, pairId: context.pairId, importId: draft.importId, drafts,
    ready: !!readyContext.current && types.ready && !types.error && !dismissed, saved, notice: types.error ? "This sheet’s Types could not be loaded. Saving is disabled." : notice,
    assertCurrent, save, dismiss: () => { if (!pending.current) setDismissed(true); } };
  return <SheetPage localImport={localImport} />;
}
