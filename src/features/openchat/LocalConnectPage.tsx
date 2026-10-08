import { useCallback, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { SheetKeyProvider, useSheetKey } from "../flows/SheetKeyContext";
import { useActor, unwrap } from "../flows/useActor";
import { usePairTemplates } from "../templates/PairTemplatesContext";
import { currencyFromUserRecord } from "../settings/defaultCurrency";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext } from "./localProcessorContext";
import { localSetupContextMatches, verifiedLocalSetupProcessor, type LocalSetupContext } from "./LocalSetupDownloads";
import { createLocalAppSetupConsent, type LocalAppSetupState } from "./localAppSetupConsent";
import { LocalDeliveryKeyProvider, useLocalDeliveryKey } from "./LocalDeliveryKeyProvider";
import { createLocalDeliveryEncryption } from "./localImportEncryption";
import { host as backendHost, canisterId as backendCanisterId } from "../auth/config";
import { decryptName } from "../crypto/devVetkd";
import { localAppSenderWindow } from "./localAppSender";
import { localConnectionLabel, localConnectionLabels } from "./localConnectionLabels";
import { createDurableInboxGrant, type DurableInboxActor, type DurableInboxRoute } from "./durableInboxService";

type Consent = ReturnType<typeof createLocalAppSetupConsent>;
type SheetChoice = { pairId: string; sheetId: string; accountName: string; sheetName: string };

/** Authenticated setup only: no draft receiver, transaction write, processor execution or OC call. */
export function LocalConnectPage() {
  const [opener] = useState(() => localAppSenderWindow(window));
  if (!opener || opener.closed || location.pathname !== "/openchat/connect" || location.search || location.hash) {
    return <main><h1>Connect IOU</h1><p>Open Apps in OpenChat and choose Connect to start.</p></main>;
  }
  return <AuthProvider><LocalDeliveryKeyProvider><ConnectSession opener={opener} /></LocalDeliveryKeyProvider></AuthProvider>;
}

function ConnectSession({ opener }: { opener: Window }) {
  const { state: auth, identity, signIn, signOut } = useAuth();
  const consentRef = useRef<Consent>();
  const [state, setState] = useState<LocalAppSetupState>({ kind: "waiting" });
  const [notice, setNotice] = useState("");
  const principal = auth.kind === "authenticated" ? auth.principal : undefined;
  const previousAuth = useRef<{ principal: string; identity: unknown }>();
  const close = useCallback((message: string) => {
    const consent = consentRef.current;
    consent?.close(); setState(consent?.state() ?? { kind: "closed" }); setNotice(message);
  }, []);
  useEffect(() => {
    if (previousAuth.current && (previousAuth.current.principal !== principal || previousAuth.current.identity !== identity)) {
      close("The IOU sign-in changed. Nothing further will be shared. Start a fresh Connect request.");
    }
    if (principal) previousAuth.current = { principal, identity };
  }, [principal, identity, close]);
  useEffect(() => {
    // Each effect installation owns its consent. StrictMode replays setup/cleanup in development;
    // reusing a state-owned instance would reuse the permanently closed first installation.
    const consent = createLocalAppSetupConsent({ opener, appId: "iou" });
    consentRef.current = consent;
    setState(consent.state());
    const receive = (event: MessageEvent) => setState(consent.receive(event));
    const pagehide = () => close("This setup connection closed. Start a fresh Connect request.");
    window.addEventListener("message", receive);
    window.addEventListener("pagehide", pagehide);
    const timer = window.setInterval(() => {
      if (opener.closed) close("The requesting window closed. Nothing further will be shared.");
      else setState(consent.state());
    }, 1000);
    return () => {
      clearInterval(timer); consent.close();
      if (consentRef.current === consent) consentRef.current = undefined;
      window.removeEventListener("message", receive); window.removeEventListener("pagehide", pagehide);
    };
  }, [opener, close]);
  const consent = consentRef.current;

  return <main style={{ maxWidth: 880, margin: "24px auto", padding: 16, overflowWrap: "anywhere" }}>
    <h1>Connect IOU</h1>
    <p>Choose the sheet to use with OpenChat. Connecting shares its Types and preferences, but not your entries, sign-in or private keys.</p>
    {state.kind === "waiting" && <p>Waiting for a setup request. Nothing has been shared.</p>}
    {state.kind === "pending" && <section aria-label="Setup requester">
      <p>Requesting client: <strong>{state.binding.senderOrigin}</strong></p>
      <p>Connect only if you started this request and recognize this address.</p>
      <button className="secondary" onClick={() => close("Setup request cancelled. Nothing was shared.")}>Cancel connection</button>
    </section>}
    {state.kind === "closed" && <p>Connection closed or expired. Start a fresh Connect request; this page will not share automatically.</p>}
    {state.kind === "shared" && <p>Setup was sent to the requesting client. No entry was saved. Check the client to confirm it accepted the setup.</p>}
    {auth.kind === "loading" && <p>Restoring your IOU sign-in…</p>}
    {auth.kind === "anonymous" && state.kind !== "closed" && state.kind !== "shared" && <button onClick={() => void signIn().catch(() => setNotice("IOU sign-in did not finish. Nothing was shared."))}>Sign in to IOU</button>}
    {auth.kind === "authenticated" && <>
      <p>Signed in to IOU.</p>
      <button className="secondary" onClick={() => { close("Signed out. Start a fresh Connect request before sharing setup."); void signOut(); }}>Sign out</button>
      {state.kind === "pending" && consent && <SheetKeyProvider key={auth.principal}>
        <ConnectAccount key={auth.principal} principal={auth.principal} opener={opener} consent={consent} state={state}
          close={close} onShared={() => setState(consent.state())} />
      </SheetKeyProvider>}
    </>}
    {notice && <p role="status">{notice}</p>}
  </main>;
}

function ConnectAccount({ principal, ...connection }: {
  principal: string; opener: Window; consent: Consent; state: Extract<LocalAppSetupState, { kind: "pending" }>;
  close: (message: string) => void; onShared: () => void;
}) {
  const { actor, err } = useActor();
  const keyring = useSheetKey();
  const keyringRef = useRef(keyring);
  keyringRef.current = keyring;
  const [result, setResult] = useState<{ actor: unknown; sheets: SheetChoice[]; defaultCurrency: string }>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setResult(undefined); setSelected(""); setError("");
    if (!actor) return;
    void Promise.all([actor.get_my_pairs(), actor.get_my_user()]).then(async ([pairs, user]) => {
      if (cancelled) return;
      const sheets: SheetChoice[] = [];
      for (const pair of pairs) {
        const sheetId = unwrap(pair.active_sheet_id);
        if (typeof sheetId === "string" && /^[a-f0-9]{16}$/.test(sheetId) && unwrap(pair.archived_at) == null) {
          sheets.push({ pairId: pair.id, sheetId, ...localConnectionLabels(sheets.length) });
        }
      }
      const named = await Promise.all(sheets.map(async (choice, index) => {
        try {
          const [sheetRecord, pairRecord, key] = await Promise.all([
            actor.get_sheet(choice.sheetId), actor.get_pair(choice.pairId),
            keyringRef.current.unwrapFor(choice.sheetId),
          ]);
          const sheet = unwrap(sheetRecord), pair = unwrap(pairRecord);
          if (!sheet || !pair) return choice;
          const [sheetName, accountName] = await Promise.all([
            decryptName(key, new Uint8Array(unwrap(sheet.name_iv) ?? []), new Uint8Array(unwrap(sheet.name_enc) ?? [])),
            decryptName(key, new Uint8Array(unwrap(pair.name_iv) ?? []), new Uint8Array(unwrap(pair.name_enc) ?? [])),
          ]);
          return { ...choice, ...localConnectionLabels(index, accountName, sheetName) };
        } catch { return choice; }
      }));
      if (!cancelled) setResult({ actor, sheets: named, defaultCurrency: currencyFromUserRecord(unwrap(user)) ?? "" });
    }).catch(() => { if (!cancelled) setError("IOU could not load your existing sheets. Nothing was shared."); });
    return () => { cancelled = true; };
  }, [actor]);
  const sheet = result?.actor === actor ? result?.sheets.find(item => item.sheetId === selected) : undefined;
  return <section>
    <h2>Choose the IOU account and sheet</h2>
    {(error || err) && <p role="alert">{error || err}</p>}
    <label>Sheet <select value={selected} disabled={!result || result.actor !== actor} onChange={(event) => {
      if (selected) connection.close("The selected IOU destination changed. Start a fresh Connect request for that destination.");
      setSelected(event.target.value);
    }}><option value="">Choose a sheet…</option>
      {result?.actor === actor && result?.sheets.map(item => <option key={item.sheetId} value={item.sheetId}>{localConnectionLabel(item)}</option>)}
    </select></label>
    {sheet && <ConnectSheet key={sheet.sheetId} {...connection} principal={principal} sheet={sheet} defaultCurrency={result!.defaultCurrency} />}
  </section>;
}

function ConnectSheet({ principal, sheet, defaultCurrency, opener, consent, state, close, onShared }: {
  principal: string; sheet: SheetChoice; defaultCurrency: string; opener: Window; consent: Consent;
  state: Extract<LocalAppSetupState, { kind: "pending" }>; close: (message: string) => void; onShared: () => void;
}) {
  const { actor } = useActor();
  const { identity } = useAuth();
  const deliveryKeys = useLocalDeliveryKey();
  const { shared, ready, readyGeneration, loading, error } = usePairTemplates(sheet.pairId, sheet.sheetId, { requireReadableSlots: true });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const current = useRef<LocalSetupContext>({ principal, pairId: sheet.pairId, sheetId: sheet.sheetId, defaultCurrency, actor, identity, binding: state.binding, shared, readyGeneration, ready });
  current.current = { principal, pairId: sheet.pairId, sheetId: sheet.sheetId, defaultCurrency, actor, identity, binding: state.binding, shared, readyGeneration, ready };
  const loaded = useRef<LocalSetupContext>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (loaded.current && !localSetupContextMatches(loaded.current, current.current)) {
      close("The private Type or account setup changed. Start a fresh Connect request; the previous setup was not shared.");
    } else if (ready && !loaded.current) loaded.current = { ...current.current };
  }, [principal, sheet.pairId, sheet.sheetId, defaultCurrency, actor, identity, shared, ready, readyGeneration, state.binding, close]);

  async function share() {
    if (pending.current || !ready || !deliveryKeys.ready || !consent.isCurrent(state.binding) || opener.closed) return;
    const captured = { ...current.current };
    const assertCurrent = () => {
      if (!mounted.current || opener.closed || !consent.isCurrent(state.binding) || !localSetupContextMatches(captured, current.current)) {
        throw new Error("Setup session changed");
      }
    };
    pending.current = true; setBusy(true); setNotice("");
    try {
      const context = createLocalProcessorContext(shared, defaultCurrency);
      const { metadata } = await verifiedLocalSetupProcessor();
      const key = await deliveryKeys.load(true);
      const deliveryEncryption = await createLocalDeliveryEncryption(key.publicKey, {
        principal, backendHost, backendCanisterId, pairId: sheet.pairId, sheetId: sheet.sheetId,
      });
      assertCurrent();
      const publicInbox: DurableInboxRoute = { version: 1, kind: "ic-canister", host: backendHost, canisterId: backendCanisterId };
      const destination = `${location.origin}/openchat/import`;
      // Validate the complete private recipe before consuming a grant slot. No capability is
      // minted for invalid Types, processor metadata, public route or encryption metadata.
      createIouLocalAppPackage(destination, metadata, { processorContext: context, deliveryEncryption,
        recipientLabel: localConnectionLabel(sheet) }, publicInbox);
      const deliveryInbox = await createDurableInboxGrant({
        actor: actor as unknown as DurableInboxActor, host: backendHost, canisterId: backendCanisterId,
        binding: { appId: "iou", appRevision: "local-import-v2", actionId: "iou.entry.import", destination, recipient: deliveryEncryption }, assertCurrent,
      });
      assertCurrent();
      const catalog = createIouLocalAppPackage(`${location.origin}/openchat/import`, metadata, {
        processorContext: context,
        deliveryEncryption,
        deliveryInbox,
        recipientLabel: localConnectionLabel(sheet),
      }, publicInbox);
      const response = consent.approve(state.binding, JSON.stringify(catalog));
      opener.postMessage(response, state.binding.senderOrigin);
      onShared();
    } catch {
      if (mounted.current) {
        if (consent.state().kind === "shared") close("The setup delivery outcome is unknown. Check the client before starting a fresh Connect request; this page will not retry.");
        else setNotice("The current setup could not be verified or the connection changed. Nothing was shared; start a fresh Connect request if it expired.");
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <section aria-label="Private setup consent">
    <h2>{localConnectionLabel(sheet)}</h2>
    <p>Currency: {defaultCurrency || "Not set"}</p>
    {(loading || (!ready && !error)) && <p>Loading this sheet’s private Types…</p>}
    {error && <p role="alert">This sheet’s private Types could not be read. Sharing is disabled.</p>}
    {ready && <ul>{shared.map(type => <li key={type.id}>{type.name}: {type.direction === "credit" ? "Owed to you" : "You owe"}; keywords: {(type.keywords ?? []).join(", ") || "name only"}</li>)}</ul>}
    <p>OpenChat will remember this connection on this device. It may deliver encrypted drafts for 90 days; pending drafts stay in IOU for up to 30 days and still need your review and Save.</p>
    <button disabled={!ready || !deliveryKeys.ready || loading || !!error || busy} onClick={() => void share()}>{busy ? "Connecting…" : "Connect"}</button>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
