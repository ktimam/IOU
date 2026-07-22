// Create (or open) a DIRECT chat between two provisioned users after a clean replica wiped all
// chats. UI-free id resolution: user_index `search` (msgpack) resolves usernames → user ids; then
// the FROM side SPA-navigates to /chats/user/<toId> via an injected anchor click (page.js
// intercepts anchors — a hard nav to a chat route 404s the SPA) and sends a first message, which
// materializes the DM on both sides.
//   pnpm exec tsx scripts/live/dm-create.ts --fromPort 9222 --to manager --text "hi"
import { chromium } from "@playwright/test";
import { HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { Packr } = require("C:/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle/frontend/node_modules/msgpackr");
const packer = new Packr({ useRecords: false, skipValues: [null, undefined], largeBigIntToString: true });

function arg(n: string, d = "") { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; }
const FROM_PORT = Number(arg("fromPort", "9222"));
const TO_USER = arg("to", "manager");
const TEXT = arg("text", "hi");

function userIndexId(): string {
  const env = readFileSync("C:/Kiko/MyProjects/IOU/.env.local", "utf8");
  const id = /VITE_OC_USER_INDEX_CANISTER_ID=([a-z0-9-]+)/.exec(env)?.[1];
  if (!id) throw new Error("no user_index id in .env.local");
  return id;
}

async function main() {
  const a = new HttpAgent({ host: "http://127.0.0.1:8080" });
  await a.fetchRootKey();
  const resp = await a.query(Principal.fromText(userIndexId()), {
    methodName: "search_msgpack",
    arg: new Uint8Array(packer.pack({ search_term: TO_USER, max_results: 5 })),
  });
  if (resp.status !== "replied") throw new Error("search rejected");
  const result = packer.unpack(new Uint8Array((resp as any).reply.arg));
  const users = result?.Success?.users ?? [];
  const target = users.find((u: any) => u.username === TO_USER) ?? users[0];
  if (!target) throw new Error(`user "${TO_USER}" not found on the user_index`);
  const toId = Principal.fromUint8Array(new Uint8Array(target.user_id)).toText();
  console.log(`[dm] ${TO_USER} = ${toId}`);

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${FROM_PORT}`);
  const page = b.contexts()[0].pages().find((p) => p.url().includes("5003"));
  if (!page) throw new Error(`no OC page on :${FROM_PORT}`);
  await page.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  // SPA-friendly navigation: page.js intercepts anchor clicks; a hard goto to a chat route 404s.
  await page.evaluate(`(() => {
    const a = document.createElement('a');
    a.href = '/chats/user/${toId}';
    a.textContent = 'dm';
    document.body.appendChild(a);
    a.click();
    a.remove();
  })()`);
  await page.waitForTimeout(3000);
  console.log(`[dm] after nav: ${page.url()}`);
  const composer = page.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await page.keyboard.type(TEXT);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  console.log(`[dm] sent "${TEXT}" → DM materialized`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
