// Durable OpenChat signup for the DESKTOP app (father / WebView2) — same flow as oc-provision.ts but
// driven entirely over RAW CDP.
//
// Why a separate script: Playwright's `connectOverCDP` throws
//   Error: targetInfo: { "type": "shared_worker", ... }
// on the WebView2 app (it cannot attach to the OC shared-worker target), so the Playwright-based
// oc-provision.ts / oc-clear-session.ts cannot drive father at all. Everything those use Playwright
// for — navigate, evaluate, bringToFront — has a direct CDP equivalent, so we just talk to the page
// target's webSocketDebuggerUrl (which is what WebAuthn needs anyway, see oc-provision.ts's header).
//
//   pnpm exec tsx scripts/live/oc-provision-desktop.ts --port 9222 --user father --out C:/Kiko/oc-live/creds/father.json
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire("C:/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle/frontend/package.json");
const WebSocket = require("ws");

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}
const PORT = Number(arg("port"));
const USER = arg("user");
const OUT = arg("out");
const FOCUS = arg("focus", "open-chat.exe");
const FOCUS_PROC = arg("focusProc", "open-chat");
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// See hold-focus.ps1: the window must be RESTORED + foreground for the WHOLE ceremony, or WebAuthn
// refuses (a minimized window is visibilityState="hidden").
function holdForeground(seconds: number): () => void {
  const p = spawn("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${HERE}/hold-focus.ps1`,
     "-Match", FOCUS, "-ProcName", FOCUS_PROC, "-Seconds", String(seconds)],
    { detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  return () => { try { p.kill(); } catch {} };
}

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const t = list.find((x: any) => x.type === "page" && /localhost:5003/.test(x.url || ""))
        ?? list.find((x: any) => x.type === "page");
  if (!t) throw new Error("no page target on the desktop app");

  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  let msgId = 0; const pend = new Map<number, (v: any) => void>();
  const cdp = (method: string, params?: any) =>
    new Promise<any>((r) => { const id = ++msgId; pend.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  ws.on("message", (buf: any) => { const m = JSON.parse(buf.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m); pend.delete(m.id); } });
  await new Promise<void>((r) => ws.on("open", () => r()));

  const evaluate = async (expression: string) =>
    (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;

  // Click the first visible element whose trimmed text matches /^rx$/i (same matcher as oc-provision).
  const clickExact = (rx: string) => evaluate(
    `(() => {
      const re = new RegExp('^' + ${JSON.stringify(rx)} + '$', 'i');
      const el = [...document.querySelectorAll('button,[role=button],a,div,span')]
        .filter(e => re.test((e.textContent||'').replace(/\\s+/g,' ').trim()) && e.getBoundingClientRect().width > 0)
        .sort((a,b)=> (a.textContent||'').length - (b.textContent||'').length)[0];
      if (!el) return 'not-found'; el.click(); return 'clicked';
    })()`);

  await cdp("Page.enable");
  await cdp("Page.navigate", { url: "http://localhost:5003/communities" });
  await sleep(6000);

  await cdp("WebAuthn.enable", { enableUI: false });
  const va = await cdp("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const authId = va.authenticatorId;

  // The desktop (wide) layout uses different copy than the mobile/web one — try both at each step.
  let entry = await clickExact("Tap here to create account or sign in");
  if (entry === "not-found") entry = await clickExact("Back to create account & sign in");
  console.log(`[${USER}] entry:`, entry);
  await sleep(2500);
  let create = await clickExact("Create account");
  if (create === "not-found") create = await clickExact("Create new account");
  console.log(`[${USER}] create account:`, create);
  await sleep(2500);

  const filled = await evaluate(
    `(() => { const inp = [...document.querySelectorAll('input')].find(i => /username/i.test(i.placeholder||''));
      if (!inp) return 'no-input'; inp.focus();
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(inp, ${JSON.stringify(USER)}); inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'filled:' + inp.value; })()`);
  console.log(`[${USER}] username:`, filled);

  await evaluate(`(() => { for (const cb of document.querySelectorAll('input[type="checkbox"]')) { if (!cb.checked) cb.click(); } })()`);

  const PROCEED = "^(Proceed|Start my journey)$";
  let ready = false;
  for (let i = 0; i < 16; i++) {
    await sleep(1500);
    const s = await evaluate(
      `(() => { const p = [...document.querySelectorAll('button,[role=button]')].find(e => /${PROCEED}/i.test((e.textContent||'').replace(/\\s+/g,' ').trim()));
        return JSON.stringify({ present: !!p, disabled: p ? !!p.disabled : true, taken: /taken|already (taken|in use)/i.test(document.body.innerText) }); })()`);
    const st = JSON.parse(String(s || "{}"));
    if (st.taken) { console.error(`[${USER}] username TAKEN`); process.exit(2); }
    if (st.present && !st.disabled) { ready = true; break; }
  }
  if (!ready) { console.error(`[${USER}] Proceed never enabled`); process.exit(3); }

  await cdp("Page.bringToFront");
  const releaseFocus = holdForeground(120);
  await sleep(1200);
  const vis = await evaluate(`JSON.stringify({focus:document.hasFocus(),vis:document.visibilityState})`);
  console.log(`[${USER}] ${vis} proceed:`, await clickExact("(Proceed|Start my journey)"));
  if (!/"focus":true/.test(String(vis)) || !/"vis":"visible"/.test(String(vis))) {
    console.error(`[${USER}] window not focused+visible — WebAuthn will refuse. Is the window minimized?`);
  }

  let done = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const creds = (await cdp("WebAuthn.getCredentials", { authenticatorId: authId }).catch(() => ({ credentials: [] }))).credentials || [];
    const modal = await evaluate(`/Sign up to OpenChat|Choose a username|Proceed/i.test(document.body.innerText)`);
    if (i % 4 === 0) console.log(`  [${USER}] +${i * 2}s creds=${creds.length} modalOpen=${modal}`);
    if (creds.length > 0 && !modal) { done = true; break; }
  }
  releaseFocus();
  if (!done) {
    const tail = await evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(-240)`);
    console.error(`[${USER}] signup did not complete. tail: ${tail}`);
    process.exit(1);
  }

  const c = (await cdp("WebAuthn.getCredentials", { authenticatorId: authId })).credentials[0];
  const cred = { user: USER, port: PORT, rpId: c.rpId, credentialId: c.credentialId, privateKey: c.privateKey,
    userHandle: c.userHandle ?? null, signCount: c.signCount ?? 0, isResidentCredential: c.isResidentCredential ?? true,
    createdAt: new Date().toISOString().slice(0, 10) };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(cred, null, 2));
  console.log(`[${USER}] REGISTERED — credential saved (${OUT}, credId=${String(cred.credentialId).slice(0, 16)}…)`);
  ws.close();
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
