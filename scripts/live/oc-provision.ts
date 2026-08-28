// Durable OpenChat signup. Uses Playwright for UI driving + a RAW WebSocket to the page's own CDP
// debugger URL for WebAuthn (Playwright's newCDPSession scopes the virtual authenticator to a session
// the page's create() doesn't use — the raw page-target WS is what actually injects it). After signup
// it EXPORTS the credential's private key (WebAuthn.getCredentials) so oc-restore can re-inject it.
//
//   pnpm exec tsx scripts/live/oc-provision.ts --openchat-frontend <frontend-dir> \
//     --port 9241 --user manager --out <live-profile-root>/creds/manager.json
import { chromium, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import { loadOpenChatWebSocket } from "./openChatFrontendDependency";

const WebSocket = loadOpenChatWebSocket();

function arg(name: string, def?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  throw new Error(`missing --${name}`);
}
const PORT = Number(arg("port"));
const USER = arg("user");
const OUT = arg("out");
const FOCUS = arg("focus", `profiles\\${USER}`);
const FOCUS_PROC = arg("focusProc", "chrome");
const OC = "http://localhost:5003/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function foreground(): void {
  try {
    const out = execFileSync("powershell.exe",
      ["-ExecutionPolicy", "Bypass", "-File", `${HERE}/focus-window.ps1`, "-Match", FOCUS, "-ProcName", FOCUS_PROC],
      { encoding: "utf8", timeout: 15000 });
    console.log(`  [${USER} focus] ${out.trim()}`);
  } catch (e) { console.log(`  [${USER} focus] ${(e as Error).message.slice(0, 80)}`); }
}

// Hold the target window RESTORED + foreground for the WHOLE ceremony, in ONE detached process.
// A single pre-click foreground() is not enough: (a) focus-window.ps1 MINIMIZES competing windows, so
// provisioning another profile leaves this one minimized — and a minimized window is
// visibilityState="hidden", which fails WebAuthn's focus check even when SetForegroundWindow succeeds;
// (b) OpenChat fetches a registration challenge and only THEN calls create(), and focus is routinely
// lost in that gap (every powershell spawn briefly owns the foreground). Returns a kill function.
function holdForeground(seconds: number): () => void {
  const p = spawn("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${HERE}/hold-focus.ps1`,
     "-Match", FOCUS, "-ProcName", FOCUS_PROC, "-Seconds", String(seconds)],
    { detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  return () => { try { p.kill(); } catch {} };
}

function httpJson(path: string): Promise<any> {
  return new Promise((res, rej) => {
    http.get({ host: "127.0.0.1", port: PORT, path }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res(JSON.parse(d))); }).on("error", rej);
  });
}

async function clickExact(page: Page, rx: string): Promise<string> {
  return page.evaluate(
    `(() => {
      const re = new RegExp('^' + ${JSON.stringify(rx)} + '$', 'i');
      const el = [...document.querySelectorAll('button,[role=button],a,div,span')]
        .filter(e => re.test((e.textContent||'').replace(/\\s+/g,' ').trim()) && e.getBoundingClientRect().width > 0)
        .sort((a,b)=> (a.textContent||'').length - (b.textContent||'').length)[0];
      if (!el) return 'not-found'; el.click(); return 'clicked';
    })()`,
  ) as Promise<string>;
}

async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes("5003")) ?? ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(OC + "communities", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(2500);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(3500);

  // Raw WS to THIS page's debugger target (the session WebAuthn actually applies to).
  const targets = await httpJson("/json/list");
  const t = targets.find((x: any) => x.type === "page" && /localhost:5003/.test(x.url || "")) ?? targets.find((x: any) => x.type === "page");
  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  let msgId = 0; const pend = new Map<number, (v: any) => void>();
  const cdp = (method: string, params?: any) => new Promise<any>((r) => { const id = ++msgId; pend.set(id, r); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  ws.on("message", (buf: any) => { const m = JSON.parse(buf.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m); pend.delete(m.id); } });
  await new Promise<void>((r) => ws.on("open", () => r()));

  page.on("pageerror", (e) => console.log(`  [${USER} pageerror] ${String(e).slice(0, 150)}`));

  // Two layouts: the NARROW/mobile layout shows the bottom banner; the WIDE/desktop layout (the
  // Tauri exe) shows "Back to create account & sign in" on /communities and then "Create new
  // account" on the auth screen. Try both texts at each step.
  let entry = await clickExact(page, "Tap here to create account or sign in");
  if (entry === "not-found") entry = await clickExact(page, "Back to create account & sign in");
  console.log(`[${USER}] entry:`, entry);
  await sleep(2500);
  let create = await clickExact(page, "Create account");
  if (create === "not-found") create = await clickExact(page, "Create new account");
  console.log(`[${USER}] create account:`, create);
  await sleep(2500);
  const filled = await page.evaluate(
    `(() => { const inp = [...document.querySelectorAll('input')].find(i => /username/i.test(i.placeholder||'')); if (!inp) return 'no-input'; inp.focus(); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(inp, ${JSON.stringify(USER)}); inp.dispatchEvent(new Event('input', { bubbles: true })); return 'filled:' + inp.value; })()`,
  );
  console.log(`[${USER}] username:`, filled);

  // The mobile/web layout's submit is "Proceed"; the desktop (Tauri) layout's is "Start my journey"
  // behind an agreement checkbox — tick any unchecked checkbox on the signup form first.
  await page.evaluate(
    `(() => { for (const cb of document.querySelectorAll('input[type="checkbox"]')) { if (!cb.checked) cb.click(); } })()`,
  );
  const PROCEED_RX = "^(Proceed|Start my journey)$";
  let ready = false;
  for (let i = 0; i < 16; i++) {
    await sleep(1500);
    const s: any = await page.evaluate(`(() => { const p = [...document.querySelectorAll('button,[role=button]')].find(e => /${PROCEED_RX}/i.test((e.textContent||'').replace(/\\s+/g,' ').trim())); return { present: !!p, disabled: p ? !!p.disabled : true, taken: /taken|already (taken|in use)/i.test(document.body.innerText) }; })()`);
    if (s.taken) { console.error(`[${USER}] username TAKEN`); process.exit(2); }
    if (s.present && !s.disabled) { ready = true; break; }
  }
  if (!ready) { console.error(`[${USER}] Proceed never enabled`); process.exit(3); }

  // Virtual authenticator on the page's own session.
  await cdp("WebAuthn.enable", { enableUI: false });
  const va = await cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const authId = va.authenticatorId;

  // Activate the TAB (a background tab is hidden even in a foreground window), then hold the window
  // restored+foreground for the whole ceremony — not just the instant before the click.
  await page.bringToFront();
  const releaseFocus = holdForeground(120);
  await sleep(1200);
  const vis: any = await page.evaluate(`JSON.stringify({focus:document.hasFocus(),vis:document.visibilityState})`);
  console.log(`[${USER}] ${vis} proceed:`, await clickExact(page, "(Proceed|Start my journey)"));
  // Fail FAST and legibly rather than spinning 90s on a ceremony WebAuthn will always refuse.
  if (!/"focus":true/.test(String(vis)) || !/"vis":"visible"/.test(String(vis))) {
    console.error(`[${USER}] window not focused+visible — WebAuthn will refuse. Is the window minimized?`);
  }

  let done = false;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const creds = (await cdp("WebAuthn.getCredentials", { authenticatorId: authId }).catch(() => ({ credentials: [] }))).credentials || [];
    const modal = await page.evaluate(`/Sign up to OpenChat|Choose a username|Proceed/i.test(document.body.innerText)`).catch(() => true);
    if (i % 4 === 0) console.log(`  [${USER}] +${i * 2}s creds=${creds.length} modalOpen=${modal}`);
    if (creds.length > 0 && !modal) { done = true; break; }
  }
  releaseFocus();
  if (!done) {
    const tail = await page.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(-240)`).catch(() => "");
    console.error(`[${USER}] signup did not complete. tail: ${tail}`);
    process.exit(1);
  }

  const creds = (await cdp("WebAuthn.getCredentials", { authenticatorId: authId })).credentials;
  const c = creds[0];
  const cred = { user: USER, port: PORT, rpId: c.rpId, credentialId: c.credentialId, privateKey: c.privateKey, userHandle: c.userHandle ?? null, signCount: c.signCount ?? 0, isResidentCredential: c.isResidentCredential ?? true, createdAt: new Date().toISOString().slice(0, 10) };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(cred, null, 2));
  console.log(`[${USER}] REGISTERED — credential saved (${OUT}, credId=${String(cred.credentialId).slice(0, 16)}…)`);
  ws.close();
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
