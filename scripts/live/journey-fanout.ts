// AUTOMATED live journey (P0-30/32 class): pairing → propose → confirm → fan-out deposit, asserted.
//
//   manager (browser :9241, IOU tab same profile)  ──┐ direct chat
//   father  (desktop OC :9222, IOU tab :9231)       ──┘
//
// Steps (each asserted; exit 1 on any failure):
//   1. Resolve the manager↔father direct chat + both OC user ids from the chat URLs.
//   2. Ensure BOTH members have a registered per-user IOU key (ai_app_user_keys); any member
//      missing one is paired live via the real UI: OC AI-apps → Connect → read the 6-digit code →
//      IOU /settings → claim. (The connect flow itself is part of the journey.)
//   3. Snapshot both members' action_inbox fingerprint buckets.
//   4. manager sends a fresh chat message and proposes via the DETERMINISTIC manual-JSON path
//      (browser clients prompt for the extraction JSON — no on-device model, no nondeterminism).
//   5. father (the NON-proposer) confirms the card.
//   6. Assert ONE confirm deposited exactly +1 envelope into EACH member's own bucket.
//
// Repeatable: assertions are relative to the before-counts. Requires the live env (replica :8080,
// OC :5003, IOU :3000, CDP 9241/9222/9231 — launch.ps1 + restore-all.sh).
//
//   pnpm exec tsx scripts/live/journey-fanout.ts
import { chromium, type Page } from "@playwright/test";
import { Actor, HttpAgent } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const { Packr } = require("C:/Kiko/MyProjects/Blockchain/ICP/open-chat-cycle/frontend/node_modules/msgpackr");
const packer = new Packr({ useRecords: false, skipValues: [null, undefined], largeBigIntToString: true });

const HOST = "http://127.0.0.1:8080";
const IOU_BASE = "http://127.0.0.1:3000";

// Current canister ids from IOU's .env.local — never hardcode (they change on every clean redeploy).
function envIds(): { userIndex: string; inbox: string } {
  const env = readFileSync("C:/Kiko/MyProjects/IOU/.env.local", "utf8");
  const get = (k: string) => new RegExp(`${k}=([a-z0-9-]+)`).exec(env)?.[1];
  const userIndex = get("VITE_OC_USER_INDEX_CANISTER_ID");
  const inbox = get("VITE_ACTION_INBOX_CANISTER_ID");
  if (!userIndex || !inbox) throw new Error(".env.local missing user_index / action_inbox ids");
  return { userIndex, inbox };
}
const IDS = envIds();

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function agent(): Promise<HttpAgent> {
  const a = new HttpAgent({ host: HOST });
  await a.fetchRootKey();
  return a;
}

async function msgpackQuery(a: HttpAgent, canisterId: string, method: string, args: unknown): Promise<any> {
  const resp = await a.query(Principal.fromText(canisterId), {
    methodName: `${method}_msgpack`,
    arg: new Uint8Array(packer.pack(args)),
  });
  if (resp.status !== "replied") throw new Error(`${method}_msgpack rejected`);
  return packer.unpack(new Uint8Array((resp as any).reply.arg));
}

async function iouAppId(a: HttpAgent): Promise<number> {
  const resp = await msgpackQuery(a, IDS.userIndex, "ai_apps", {});
  const iou = (resp?.Success?.apps ?? []).find((x: any) => x?.manifest?.name === "iou");
  if (!iou) throw new Error("iou app not registered on the user_index");
  return Number(iou.id);
}

async function memberKeys(a: HttpAgent, appId: number, userIds: string[]): Promise<Map<string, string>> {
  const resp = await msgpackQuery(a, IDS.userIndex, "ai_app_user_keys", {
    app_id: appId,
    user_ids: userIds.map((u) => Principal.fromText(u).toUint8Array()),
  });
  const out = new Map<string, string>();
  for (const k of resp?.Success?.keys ?? []) {
    if ((k.public_key as string).length > 0) {
      out.set(Principal.fromUint8Array(new Uint8Array(k.user_id)).toText(), k.public_key as string);
    }
  }
  return out;
}

async function fingerprintOfPem(pem: string): Promise<Uint8Array> {
  const b64 = pem.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(Buffer.from(b64, "base64"));
  const point = der.slice(der.length - 65);
  if (point[0] !== 0x04) throw new Error("unexpected SPKI layout");
  return new Uint8Array(await webcrypto.subtle.digest("SHA-256", point));
}

const inboxIdl = ({ IDL: idl }: any) => {
  const Args = idl.Record({ max_results: idl.Nat32, consumer_key_fingerprint: idl.Vec(idl.Nat8), since_id: idl.Nat64 });
  const StoredAction = idl.Record({
    id: idl.Nat64, ciphertext: idl.Vec(idl.Nat8), ephemeral_public_key: idl.Vec(idl.Nat8),
    created_at: idl.Nat64, oc_signature: idl.Vec(idl.Nat8),
  });
  return idl.Service({
    actions: idl.Func([Args], [idl.Variant({ Success: idl.Record({ actions: idl.Vec(StoredAction) }) })], ["query"]),
  });
};

async function bucketCount(a: HttpAgent, fp: Uint8Array): Promise<number> {
  const actor: any = Actor.createActor(inboxIdl, { agent: a, canisterId: IDS.inbox });
  const resp = await actor.actions({ max_results: 500, consumer_key_fingerprint: Array.from(fp), since_id: 0n });
  return resp.Success.actions.length;
}

// ONE CDP connection per port. Connecting twice to the same browser creates a second set of Page
// objects; a window.prompt then reaches a page with no dialog listener on that second connection and
// Playwright AUTO-DISMISSES it there — racing (and losing us) the prompt we meant to answer.
const connections = new Map<number, ReturnType<typeof chromium.connectOverCDP>>();
async function attach(port: number, urlPart: string): Promise<Page> {
  if (!connections.has(port)) connections.set(port, chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const browser = await connections.get(port)!;
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes(urlPart)) ?? ctx.pages()[0];
  if (!page) throw new Error(`no page on :${port}`);
  return page;
}

// Pair one member with IOU via the REAL Connect UI: OC AI-apps directory → Connect → 6-digit code →
// IOU /settings → claim. (The stageA3 flow, hardened.)
async function pairViaUi(oc: Page, iou: Page, who: string): Promise<void> {
  console.log(`[${who}] pairing via the Connect UI…`);
  await oc.goto("http://localhost:5003/communities", { waitUntil: "domcontentloaded" });
  await oc.waitForTimeout(2500);
  await oc.getByText("AI apps", { exact: true }).first().click({ timeout: 15000 });
  await oc.waitForTimeout(1500);
  await oc.locator("div,a,li").filter({ hasText: /^iou$/i }).first().click({ timeout: 15000 }).catch(async () => {
    await oc.getByText(/iou/i).first().click({ timeout: 10000 });
  });
  await oc.waitForTimeout(1500);
  await oc.getByRole("button", { name: /^(Connect|Reconnect)$/ }).first().click({ timeout: 15000 });
  await oc.locator(".code .digit").first().waitFor({ timeout: 20000 });
  const code = (await oc.locator(".code .digit").allInnerTexts()).join("").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(code)) throw new Error(`[${who}] bad link code: ${code}`);
  console.log(`[${who}] link code: ${code}`);

  await iou.goto(`${IOU_BASE}/settings`, { waitUntil: "domcontentloaded" });
  await iou.getByRole("heading", { name: /OpenChat action inbox/i }).waitFor({ timeout: 20000 });
  await iou.locator('input[placeholder="6-digit code"]').fill(code);
  await iou.getByRole("button", { name: /^Connect$/ }).click();
  await iou.getByText(/Connected —/i).first().waitFor({ timeout: 30000 });
  console.log(`[${who}] paired`);
  // Close the OC modal (best-effort: Check connection resumes / dismiss).
  await oc.getByRole("button", { name: /Check connection/i }).first().click({ timeout: 5000 }).catch(() => {});
  await oc.keyboard.press("Escape").catch(() => {});
}

async function main() {
  const a = await agent();
  const appId = await iouAppId(a);
  console.log(`[env] user_index=${IDS.userIndex} inbox=${IDS.inbox} appId=${appId}`);

  const managerOC = await attach(9241, "localhost:5003");
  const fatherOC = await attach(9222, "localhost:5003");
  const managerIOU = await attach(9241, "127.0.0.1:3000");
  const fatherIOU = await attach(9231, "127.0.0.1:3000");

  // 1. Open the manager↔father direct chat on both sides; ids come from the chat URLs. The rail row
  //    is the `.chat-summary` container (a generic div/li filter matches outer wrappers and no-ops).
  await managerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await managerOC.waitForTimeout(3000);
  await managerOC.locator(".chat-summary").filter({ hasText: /father/i }).first().click({ timeout: 15000 });
  await managerOC.waitForTimeout(2500);
  const fatherId = /user\/([a-z0-9-]+)/.exec(managerOC.url())?.[1];
  check(!!fatherId, `manager side: father's user id resolved (${fatherId})`);

  await fatherOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await fatherOC.waitForTimeout(3000);
  await fatherOC.locator(".chat-summary").filter({ hasText: /manager/i }).first().click({ timeout: 15000 });
  await fatherOC.waitForTimeout(2500);
  const managerId = /user\/([a-z0-9-]+)/.exec(fatherOC.url())?.[1];
  check(!!managerId, `father side: manager's user id resolved (${managerId})`);
  if (!fatherId || !managerId) throw new Error("could not resolve both user ids");

  // 2. Both members need a per-user IOU key — pair any that lack one via the real UI.
  let keys = await memberKeys(a, appId, [managerId, fatherId]);
  if (!keys.has(managerId)) await pairViaUi(managerOC, managerIOU, "manager");
  if (!keys.has(fatherId)) await pairViaUi(fatherOC, fatherIOU, "father");
  keys = await memberKeys(a, appId, [managerId, fatherId]);
  check(keys.has(managerId), "manager has a registered per-user IOU key");
  check(keys.has(fatherId), "father has a registered per-user IOU key");
  if (!keys.has(managerId) || !keys.has(fatherId)) throw new Error("pairing failed");

  // Re-open the direct chat on the manager side (pairing navigated away).
  await managerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await managerOC.waitForTimeout(2500);
  await managerOC.locator(".chat-summary").filter({ hasText: /father/i }).first().click({ timeout: 15000 });
  await managerOC.waitForTimeout(2000);

  // 3. Bucket snapshot.
  const fpManager = await fingerprintOfPem(keys.get(managerId)!);
  const fpFather = await fingerprintOfPem(keys.get(fatherId)!);
  const before = { manager: await bucketCount(a, fpManager), father: await bucketCount(a, fpFather) };
  console.log("[inbox] before:", before);

  // 4. manager sends a message + proposes via the DETERMINISTIC manual-JSON prompt.
  const nonce = Date.now() % 1000000;
  const text = `Journey ${nonce}: cleaning fee 350 EGP`;
  const extraction = JSON.stringify({ kind: "iou", amount: 350, currency: "EGP", direction: "credit", note: `journey ${nonce}` });
  managerOC.on("dialog", (d) => {
    const msg = d.message();
    const reply = /JSON/i.test(msg) ? extraction : "1"; // extraction prompt vs (optional) app chooser
    console.log(`[manager] dialog: "${msg.slice(0, 60)}…" → ${reply.slice(0, 50)}`);
    // accept() can race a concurrent dismissal ("No dialog is showing") — tolerate it; the retry
    // loop below re-proposes if the card never posts.
    d.accept(reply).catch(() => console.log("[manager] dialog accept raced — will retry propose"));
  });
  const composer = managerOC.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await managerOC.keyboard.type(text);
  await managerOC.keyboard.press("Enter");
  console.log(`[manager] sent: ${text}`);
  await managerOC.waitForTimeout(2500);

  // The propose entry on the web client is the message menu ("Propose action"): hover the just-sent
  // bubble to reveal its menu icon, open it, click the item — the manual-JSON prompt then fires and
  // the dialog handler above answers it deterministically. Retried once in case the dialog answer
  // raced (see the handler); success gate = the card's Confirm button visible on FATHER's side.
  // The card's confirm button carries the MANIFEST's confirm_label — for the live iou app that is
  // "Add to IOU" (docs/openchat-registration.json), not a generic "Confirm".
  const confirmBtn = fatherOC.locator("button").filter({ hasText: /^(Add to IOU|Confirm)$/i }).last();
  let posted = false;
  for (let attempt = 1; attempt <= 2 && !posted; attempt++) {
    const bubble = managerOC.locator(".bubble-wrapper").last();
    await bubble.hover();
    await managerOC.waitForTimeout(500);
    await bubble.locator(".menu-icon").first().click({ timeout: 15000 });
    await managerOC.getByText("Propose action", { exact: true }).click({ timeout: 15000 });
    console.log(`[manager] proposed (attempt ${attempt}, manual JSON — no model)`);
    posted = await confirmBtn.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
  }
  check(posted, "the action card posted (Confirm visible on father's side)");
  if (!posted) throw new Error("card never posted");

  // 5. father confirms (the NON-proposer). The IOU manifest declares a DISCLOSURE, so the confirm
  //    button stays disabled until the acknowledgment checkbox on the card is ticked.
  await fatherOC.locator('input[type="checkbox"]').last().check({ timeout: 15000 });
  await confirmBtn.click();
  console.log("[father] confirmed");
  await fatherOC.waitForTimeout(6000);

  // 6. Fan-out: ONE confirm → +1 envelope in EACH member's own bucket.
  const after = { manager: await bucketCount(a, fpManager), father: await bucketCount(a, fpFather) };
  console.log("[inbox] after:", after);
  check(after.manager === before.manager + 1, `manager bucket +1 (${before.manager} → ${after.manager})`);
  check(after.father === before.father + 1, `father bucket +1 (${before.father} → ${after.father})`);

  if (failures > 0) {
    console.error(`\nJOURNEY FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n🏁 JOURNEY PASSED: pair → manual propose → partner confirm → fan-out to BOTH buckets");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
