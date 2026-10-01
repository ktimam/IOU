import { useCallback, useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { SheetKeyProvider } from "../flows/SheetKeyContext";
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

type Consent = ReturnType<typeof createLocalAppSetupConsent>;
type SheetChoice = { pairId: string; sheetId: string; otherPrincipal: string };

/** Authenticated setup only: no draft receiver, transaction write, processor execution or OC call. */
export function LocalConnectPage() {
  const [opener] = useState(() => window.opener as Window | null);
  if (window.parent !== window || !opener || opener.closed || location.pathname !== "/openchat/connect" || location.search || location.hash) {
    return <main><h1>Connect IOU from your client</h1><p>Start a fresh Connect request in the client. This setup page requires its original window and a plain URL.</p></main>;
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
    <h1>Connect IOU setup</h1>
    <p>This shares your selected account/sheet routing metadata, Type names, keywords, directions, currency preferences and a public delivery-encryption key with the requesting client. It sends no chat, image, draft, sign-in credential, private key or sheet secret, and saves no entry.</p>
    {state.kind === "waiting" && <p>Waiting for a setup request. Nothing has been shared.</p>}
    {state.kind === "pending" && <section aria-label="Setup requester">
      <p>Requesting client: <strong>{state.binding.senderOrigin}</strong></p>
      <p>This address is not proof of an official client. Connect only if you just started this request and recognize the exact address. The request expires after ten minutes.</p>
      <button className="secondary" onClick={() => close("Setup request cancelled. Nothing was shared.")}>Cancel connection</button>
    </section>}
    {state.kind === "closed" && <p>Connection closed or expired. Start a fresh Connect request; this page will not share automatically.</p>}
    {state.kind === "shared" && <p>Setup was sent to the requesting client. No entry was saved. Check the client to confirm it accepted the setup.</p>}
    {auth.kind === "loading" && <p>Restoring your IOU sign-in…</p>}
    {auth.kind === "anonymous" && state.kind !== "closed" && state.kind !== "shared" && <button onClick={() => void signIn().catch(() => setNotice("IOU sign-in did not finish. Nothing was shared."))}>Sign in to IOU</button>}
    {auth.kind === "authenticated" && <>
      <p>Signed-in IOU principal: <strong>{auth.principal}</strong></p>
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
  const [result, setResult] = useState<{ actor: unknown; sheets: SheetChoice[]; defaultCurrency: string }>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setResult(undefined); setSelected(""); setError("");
    if (!actor) return;
    void Promise.all([actor.get_my_pairs(), actor.get_my_user()]).then(([pairs, user]) => {
      if (cancelled) return;
      const sheets: SheetChoice[] = [];
      for (const pair of pairs) {
        const sheetId = unwrap(pair.active_sheet_id);
        if (typeof sheetId === "string" && /^[a-f0-9]{16}$/.test(sheetId) && unwrap(pair.archived_at) == null) {
          sheets.push({ pairId: pair.id, sheetId, otherPrincipal: pair.other_principal.toText() });
        }
      }
      setResult({ actor, sheets, defaultCurrency: currencyFromUserRecord(unwrap(user)) ?? "" });
    }).catch(() => { if (!cancelled) setError("IOU could not load your existing sheets. Nothing was shared."); });
    return () => { cancelled = true; };
  }, [actor]);
  const sheet = result?.actor === actor ? result?.sheets.find(item => item.sheetId === selected) : undefined;
  return <section>
    <h2>Choose the IOU account and sheet</h2>
    {(error || err) && <p role="alert">{error || err}</p>}
    <label>Existing active sheet <select value={selected} disabled={!result || result.actor !== actor} onChange={(event) => {
      if (selected) connection.close("The selected IOU destination changed. Start a fresh Connect request for that destination.");
      setSelected(event.target.value);
    }}><option value="">Choose a sheet…</option>
      {result?.actor === actor && result?.sheets.map(item => <option key={item.sheetId} value={item.sheetId}>Account {item.pairId} — sheet {item.sheetId} — other member {item.otherPrincipal}</option>)}
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
    pending.current = true; setBusy(true); setNotice("");
    try {
      const context = createLocalProcessorContext(shared, defaultCurrency);
      const { metadata } = await verifiedLocalSetupProcessor();
      const key = await deliveryKeys.load(true);
      const deliveryEncryption = await createLocalDeliveryEncryption(key.publicKey, {
        principal, backendHost, backendCanisterId, pairId: sheet.pairId, sheetId: sheet.sheetId,
      });
      if (!mounted.current || opener.closed || !consent.isCurrent(state.binding) || !localSetupContextMatches(captured, current.current)) {
        throw new Error("Setup session changed");
      }
      const catalog = createIouLocalAppPackage(`${location.origin}/openchat/import`, metadata, {
        processorContext: context,
        deliveryEncryption,
        recipientLabel: `IOU account ${sheet.pairId}; sheet ${sheet.sheetId}. Encrypted to this IOU user and sheet; review again in IOU before saving.`,
      });
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
    <h2>Review the setup you will share</h2>
    <p>Account {sheet.pairId}; sheet {sheet.sheetId}; currency {defaultCurrency || "unset"}.</p>
    {(loading || (!ready && !error)) && <p>Loading this sheet’s private Types…</p>}
    {error && <p role="alert">This sheet’s private Types could not be read. Sharing is disabled.</p>}
    {ready && <ul>{shared.map(type => <li key={type.id}>{type.name}: {type.direction === "credit" ? "Owed to you" : "You owe"}; keywords: {(type.keywords ?? []).join(", ") || "name only"}</li>)}</ul>}
    <p>Only this setup is sent. Fees, schedules, entries, sheet keys and IOU sign-in credentials stay in IOU. The client may remember the shared setup on this device.</p>
    <button disabled={!ready || !deliveryKeys.ready || loading || !!error || busy} onClick={() => void share()}>{busy ? "Verifying and sharing setup…" : "Connect / share setup"}</button>
    {notice && <p role="status">{notice}</p>}
  </section>;
}
