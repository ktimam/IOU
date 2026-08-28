// Durable OpenChat restore. If the profile's session delegation is still valid, no-op. Otherwise
// re-inject the saved credential (WebAuthn.addCredential) into a virtual authenticator and drive the
// passkey sign-in — restoring the SAME user after a restart / session expiry. Uses a raw WS to the
// page's own debugger (WebAuthn scope) + foregrounds the window (WebAuthn focus requirement).
//   pnpm exec tsx scripts/live/oc-restore.ts --openchat-frontend <frontend-dir> \
//     --port 9241 --cred <live-profile-root>/creds/manager.json
import { chromium, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
const CRED = JSON.parse(readFileSync(arg("cred"), "utf8"));
const FOCUS = arg("focus", `profiles\\${CRED.user}`);
const FOCUS_PROC = arg("focusProc", "chrome");
const OC = "http://localhost:5003/";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HERE = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function foreground(): void {
  try {
    execFileSync("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", `${HERE}/focus-window.ps1`, "-Match", FOCUS, "-ProcName", FOCUS_PROC], { encoding: "utf8", timeout: 15000 });
  } catch { /* best-effort */ }
}
function httpJson(path: string): Promise<any> {
  return new Promise((res, rej) => { http.get({ host: "127.0.0.1", port: PORT, path }, (x) => { let d = ""; x.on("data", (c) => (d += c)); x.on("end", () => res(JSON.parse(d))); }).on("error", rej); });
}
async function clickExact(page: Page, rx: string): Promise<string> {
  return page.evaluate(
    `(() => { const re = new RegExp('^' + ${JSON.stringify(rx)} + '$', 'i'); const el = [...document.querySelectorAll('button,[role=button],a,div,span')].filter(e => re.test((e.textContent||'').replace(/\\s+/g,' ').trim()) && e.getBoundingClientRect().width > 0).sort((a,b)=> (a.textContent||'').length - (b.textContent||'').length)[0]; if (!el) return 'not-found'; el.click(); return 'clicked'; })()`,
  ) as Promise<string>;
}
// Correct discriminator, evaluated on the /communities app route (NOT root, which serves the marketing
// landing page whose feature copy false-trips a naive chats regex). Signed-OUT shows the "Tap here to
// create account or sign in" banner; signed-IN never does. Require the app shell to have loaded first.
async function signedIn(page: Page): Promise<boolean> {
  return page.evaluate(`(() => {
    const t = document.body.innerText;
    const banner = /Tap here to create account or sign in|Welcome to OpenChat|Sign in to OpenChat|Create account or sign in/i.test(t);
    const marketing = /Launch app|Whitepaper|Roadmap|Fully featured\\. Fully secure/i.test(t);
    const loaded = /Explore communities|Notifications|Direct chats|New group|Selected chat|AI apps/i.test(t);
    return loaded && !banner && !marketing;
  })()`) as Promise<boolean>;
}

async function main() {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const ctx = b.contexts()[0];
  let page = ctx.pages().find((p) => p.url().includes("5003")) ?? ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(OC + "communities", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4500);
  if (await signedIn(page)) {
    console.log(`[${CRED.user}] session valid — signed in (no re-auth)`);
    await b.close(); // Disconnect this driver; the durable browser stays open.
    return;
  }

  console.log(`[${CRED.user}] re-injecting saved credential + signing in…`);
  const targets = await httpJson("/json/list");
  const t = targets.find((x: any) => x.type === "page" && /localhost:5003/.test(x.url || "")) ?? targets.find((x: any) => x.type === "page");
  const ws = new WebSocket(t.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  let msgId = 0; const pend = new Map<number, (v: any) => void>();
  const cdp = (m: string, p?: any) => new Promise<any>((r) => { const id = ++msgId; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: p || {} })); });
  ws.on("message", (buf: any) => { const m = JSON.parse(buf.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)!(m.result ?? m); pend.delete(m.id); } });
  await new Promise<void>((r) => ws.on("open", () => r()));

  await cdp("WebAuthn.enable", { enableUI: false });
  const va = await cdp("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await cdp("WebAuthn.addCredential", {
    authenticatorId: va.authenticatorId,
    credential: { credentialId: CRED.credentialId, isResidentCredential: CRED.isResidentCredential ?? true, rpId: CRED.rpId, privateKey: CRED.privateKey, ...(CRED.userHandle ? { userHandle: CRED.userHandle } : {}), signCount: CRED.signCount ?? 0 },
  });

  await page.goto(OC + "communities", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(2500);
  // Open the auth panel, then (if a bare "Sign in" step exists) advance to the passkey screen.
  await clickExact(page, "Tap here to create account or sign in");
  await sleep(1800);
  await clickExact(page, "Sign in"); // no-op if the panel goes straight to the passkey button
  await sleep(1500);
  // Foreground the window (WebAuthn focus requirement) then fire the passkey get() ceremony — the
  // virtual authenticator (seeded with the saved credential) auto-answers it.
  await page.bringToFront();
  foreground();
  await sleep(400);
  console.log(`[${CRED.user}] passkey:`, await clickExact(page, "Sign in with Passkey"));

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    if (i === 3) { await page.bringToFront().catch(() => {}); foreground(); } // re-assert focus once
    if (await signedIn(page)) {
      console.log(`[${CRED.user}] RESTORED — signed in via saved credential`);
      ws.close();
      await b.close();
      return;
    }
  }
  const tail = await page.evaluate(`document.body.innerText.replace(/\\s+/g,' ').slice(-200)`).catch(() => "");
  console.error(`[${CRED.user}] restore did NOT complete. tail: ${tail}`);
  ws.close();
  await b.close();
  process.exit(1);
}
main().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
