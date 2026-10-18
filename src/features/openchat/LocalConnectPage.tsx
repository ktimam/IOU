import { useEffect, useRef, useState } from "react";
import { AuthProvider, useAuth } from "../auth/AuthProvider";
import { SheetKeyProvider } from "../flows/SheetKeyContext";
import { useActor } from "../flows/useActor";
import { LocalDeliveryKeyProvider } from "./LocalDeliveryKeyProvider";
import { LocalSetupV2Panel } from "./LocalSetupV2Panel";
import { AccountVaultGate } from "../crypto/AccountVaultControls";
import { claimLocalSetupCode, type LocalSetupCodeSession } from "./localSetupCode";

/** Top-level app-owned code entry: sign-in, storage and autofill use IOU's origin, never a client iframe. */
export function LocalConnectPage() {
  if (window.parent !== window || !["/openchat/connect", "/openchat/connect.html"].includes(location.pathname) || location.search || location.hash) {
    return <main><h1>Connect IOU</h1><p>Open Apps in OpenChat and choose Connect to start.</p></main>;
  }
  return <AuthProvider><LocalDeliveryKeyProvider><AccountVaultGate><ConnectSession /></AccountVaultGate></LocalDeliveryKeyProvider></AuthProvider>;
}

function ConnectSession() {
  const { state: auth, identity, signIn, signOut } = useAuth();
  const { actor, err } = useActor();
  const principal = auth.kind === "authenticated" ? auth.principal : undefined;
  const [code, setCode] = useState("");
  const [session, setSession] = useState<LocalSetupCodeSession>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [shared, setShared] = useState(false);
  const live = useRef({ principal, identity, actor });
  live.current = { principal, identity, actor };
  const current = useRef<LocalSetupCodeSession>();
  const mounted = useRef(false), generation = useRef(0), pending = useRef(false);
  function close(message: string) {
    ++generation.current; current.current?.close(); current.current = undefined;
    setSession(undefined); setCode(""); setNotice(message);
  }
  useEffect(() => {
    mounted.current = true;
    const pagehide = () => close("Connection closed. Get a fresh code from OpenChat.");
    window.addEventListener("pagehide", pagehide);
    return () => { mounted.current = false; ++generation.current; current.current?.close(); window.removeEventListener("pagehide", pagehide); };
  }, []);
  useEffect(() => {
    ++generation.current; current.current?.close(); current.current = undefined; setSession(undefined); setCode(""); setShared(false);
  }, [principal, identity, actor]);
  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => {
      if (!session.isCurrent()) close("Connection closed or expired. Check OpenChat before starting a fresh connection.");
    }, 1000);
    return () => clearInterval(timer);
  }, [session]);
  async function claim() {
    if (pending.current || !actor || !identity || !principal || session || shared) return;
    pending.current = true; setBusy(true); setNotice("");
    const captured = live.current, epoch = generation.current;
    const check = () => {
      if (!mounted.current || epoch !== generation.current || live.current.actor !== captured.actor ||
        live.current.identity !== captured.identity || live.current.principal !== captured.principal) throw new Error("Connection session changed");
    };
    try {
      const next = await claimLocalSetupCode({ code, actor, setupUrl: `${location.origin}${location.pathname}`, assertCurrent: check });
      check(); current.current = next; setSession(next); setCode("");
    } catch {
      if (mounted.current && epoch === generation.current) setNotice("The code could not be verified or has expired. Copy the code from OpenChat and try again.");
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  return <main style={{ maxWidth: 680, margin: "24px auto", padding: 16, overflowWrap: "anywhere" }}>
    <h1>Connect to OpenChat</h1>
    <p>Paste the connection code shown in OpenChat. No entries, sign-in credentials or private keys are shared.</p>
    {auth.kind === "loading" && <p>Restoring your IOU sign-in…</p>}
    {auth.kind === "anonymous" && <button onClick={() => void signIn().catch(() => setNotice("IOU sign-in did not finish. Try again."))}>Sign in to IOU</button>}
    {auth.kind === "authenticated" && <>
      <p>Signed in to IOU.</p>
      {!session && !shared && <div className="card">
        <label htmlFor="openchat-connection-code">Connection code</label>
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input id="openchat-connection-code" value={code} onChange={event => setCode(event.target.value)}
            autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} maxLength={43}
            placeholder="Paste the code from OpenChat" disabled={busy} style={{ flex: "1 1 280px", minWidth: 0, fontFamily: "monospace" }} />
          <button disabled={busy || !actor || !code.trim()} onClick={() => void claim()}>{busy ? "Checking…" : "Continue"}</button>
        </div>
      </div>}
      {session && <>
        <p>Client address supplied by the request: <strong>{session.clientOrigin}</strong>. Continue only if you started this connection in OpenChat.</p>
        <SheetKeyProvider key={principal}><LocalSetupV2Panel principal={principal!} session={session} close={close}
          onShared={() => { current.current = undefined; setSession(undefined); setShared(true); setNotice("Connected. Return to OpenChat and choose Check connection."); }} /></SheetKeyProvider>
        <button className="secondary" onClick={() => close("Connection closed. Existing entries were not changed. Check OpenChat before starting again.")}>Cancel connection</button>
      </>}
      <button className="secondary" onClick={() => { close("Signed out. Get a fresh code after signing in again."); void signOut(); }}>Sign out</button>
    </>}
    {(notice || err) && <p role="status">{notice || "IOU could not load the connection. Try again."}</p>}
  </main>;
}
