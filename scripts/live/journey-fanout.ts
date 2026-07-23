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

// ── Role parameters (the v1/v2 UI matrix) ──────────────────────────────────────────────────────
// The two OpenChat UI trees (v1 classic `components/`, v2 mobile `components_mobile/` — selected in
// main.ts by OC_MOBILE_LAYOUT=v2 + a below-breakpoint window at boot) are FULL parallel
// implementations, so each direction of the journey exercises a different propose/confirm UI. Roles
// are `user:ocPort:iouPort`; defaults = the original manager(v1-wide)→father(v2-exe) direction.
//   pnpm exec tsx scripts/live/journey-fanout.ts \
//     --proposer mother:9242:9242 --confirmer manager:9241:9241   # v2-browser proposes, v1 confirms
type Role = { user: string; ocPort: number; iouPort: number };
function roleArg(name: string, def: Role): Role {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0 || !process.argv[i + 1]) return def;
  const [user, oc, iou] = process.argv[i + 1].split(":");
  if (!user || !oc || !iou) throw new Error(`--${name} must be user:ocPort:iouPort`);
  return { user, ocPort: Number(oc), iouPort: Number(iou) };
}
const PROPOSER = roleArg("proposer", { user: "manager", ocPort: 9241, iouPort: 9241 });
const CONFIRMER = roleArg("confirmer", { user: "father", ocPort: 9222, iouPort: 9231 });

async function main() {
  const a = await agent();
  const appId = await iouAppId(a);
  console.log(`[env] user_index=${IDS.userIndex} inbox=${IDS.inbox} appId=${appId}`);
  console.log(`[roles] proposer=${PROPOSER.user}(oc:${PROPOSER.ocPort}) confirmer=${CONFIRMER.user}(oc:${CONFIRMER.ocPort})`);

  const proposerOC = await attach(PROPOSER.ocPort, "localhost:5003");
  const confirmerOC = await attach(CONFIRMER.ocPort, "localhost:5003");
  const proposerIOU = await attach(PROPOSER.iouPort, "127.0.0.1:3000");
  const confirmerIOU = await attach(CONFIRMER.iouPort, "127.0.0.1:3000");
  const proposerRow = new RegExp(CONFIRMER.user, "i"); // the row the proposer clicks = the OTHER member
  const confirmerRow = new RegExp(PROPOSER.user, "i");

  // 1. Open the direct chat on both sides; ids come from the chat URLs. The rail row is the
  //    `.chat-summary` (web) / `.chat_summary` (mobile tree) container.
  await proposerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await proposerOC.waitForTimeout(3000);
  await proposerOC.locator(".chat-summary, .chat_summary").filter({ hasText: proposerRow }).first().click({ timeout: 15000 });
  await proposerOC.waitForTimeout(2500);
  const confirmerId = /user\/([a-z0-9-]+)/.exec(proposerOC.url())?.[1];
  check(!!confirmerId, `${PROPOSER.user} side: ${CONFIRMER.user}'s user id resolved (${confirmerId})`);

  await confirmerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await confirmerOC.waitForTimeout(3000);
  await confirmerOC.locator(".chat-summary, .chat_summary").filter({ hasText: confirmerRow }).first().click({ timeout: 15000 });
  await confirmerOC.waitForTimeout(2500);
  const proposerId = /user\/([a-z0-9-]+)/.exec(confirmerOC.url())?.[1];
  check(!!proposerId, `${CONFIRMER.user} side: ${PROPOSER.user}'s user id resolved (${proposerId})`);
  if (!confirmerId || !proposerId) throw new Error("could not resolve both user ids");

  // 2. Both members need a per-user IOU key — pair any that lack one via the real UI.
  let keys = await memberKeys(a, appId, [proposerId, confirmerId]);
  if (!keys.has(proposerId)) await pairViaUi(proposerOC, proposerIOU, PROPOSER.user);
  if (!keys.has(confirmerId)) await pairViaUi(confirmerOC, confirmerIOU, CONFIRMER.user);
  keys = await memberKeys(a, appId, [proposerId, confirmerId]);
  check(keys.has(proposerId), `${PROPOSER.user} has a registered per-user IOU key`);
  check(keys.has(confirmerId), `${CONFIRMER.user} has a registered per-user IOU key`);
  if (!keys.has(proposerId) || !keys.has(confirmerId)) throw new Error("pairing failed");

  // Re-open the direct chat on BOTH sides (pairing navigates each paired member's OC page away to
  // /communities — the confirm gate polls the confirmer's page, so their chat must be open too).
  for (const [page, rowRx] of [[proposerOC, proposerRow], [confirmerOC, confirmerRow]] as const) {
    await page.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator(".chat-summary, .chat_summary").filter({ hasText: rowRx }).first().click({ timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  // 3. Bucket snapshot.
  const fpProposer = await fingerprintOfPem(keys.get(proposerId)!);
  const fpConfirmer = await fingerprintOfPem(keys.get(confirmerId)!);
  const before = { proposer: await bucketCount(a, fpProposer), confirmer: await bucketCount(a, fpConfirmer) };
  console.log("[inbox] before:", before);

  // 4. The proposer sends a message + proposes via the DETERMINISTIC manual-JSON prompt.
  // Issue 1 test seam: with no on-device model, REAL users are now guided to set one up instead of a
  // raw JSON prompt. The automated journey drives the deterministic manual-JSON path, so it OPTS IN
  // to the manual prompt by setting oc:manualExtract="1" on the proposer's OC page before proposing.
  await proposerOC.evaluate(`localStorage.setItem("oc:manualExtract","1")`);
  const nonce = Date.now() % 1000000;
  const text = `Journey ${nonce}: cleaning fee 350 EGP`;
  const extraction = JSON.stringify({ kind: "iou", amount: 350, currency: "EGP", direction: "credit", note: `journey ${nonce}` });
  proposerOC.on("dialog", (d) => {
    const msg = d.message();
    const reply = /JSON/i.test(msg) ? extraction : "1"; // extraction prompt vs (optional) app chooser
    console.log(`[${PROPOSER.user}] dialog: "${msg.slice(0, 60)}…" → ${reply.slice(0, 50)}`);
    // accept() can race a concurrent dismissal ("No dialog is showing") — tolerate it; the retry
    // loop below re-proposes if the card never posts.
    d.accept(reply).catch(() => console.log(`[${PROPOSER.user}] dialog accept raced — will retry propose`));
  });
  // Dismiss any open modal/sheet overlay first (a leftover #masked_overlay — e.g. an open chat menu
  // from a prior aborted run — silently intercepts ALL pointer events on the v2 tree).
  for (let i = 0; i < 3; i++) {
    const blocked = await proposerOC.evaluate(
      `(() => { const ov = document.querySelector('#masked_overlay'); return !!ov && ov.className.includes('visible'); })()`,
    );
    if (!blocked) break;
    await proposerOC.keyboard.press("Escape").catch(() => {});
    await proposerOC.waitForTimeout(500);
    await proposerOC.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 3000 }).catch(() => {});
    await proposerOC.waitForTimeout(500);
  }
  const composer = proposerOC.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await proposerOC.keyboard.type(text);
  await proposerOC.keyboard.press("Enter");
  console.log(`[${PROPOSER.user}] sent: ${text}`);
  await proposerOC.waitForTimeout(2500);

  // The propose entry is the message menu ("Propose action"): hover the just-sent bubble to reveal
  // its menu icon, open it, click the item — the manual-JSON prompt then fires and the dialog
  // handler above answers it deterministically. Retried once in case the dialog answer raced;
  // success gate = OUR card's confirm button visible on the CONFIRMER's side. The confirm button
  // carries the MANIFEST's confirm_label — for the live iou app "Add to IOU".
  //
  // Confirm targeting is scoped to THIS RUN'S card, never "the last confirm button on the page":
  // the card's Note row renders the extraction JSON's `note` — the run-unique `journey ${nonce}` —
  // so match the `.action-card` (ActionCardContent.svelte, shared by the v1 and v2 UI trees)
  // containing that nonce. A stale unconfirmed card left in the chat by an earlier run can then
  // neither satisfy the posted-gate nor receive the confirm click (live 2026-07-22: the journey
  // confirmed a leftover invalid "hi" card instead of its own 350 EGP one). Step 5 additionally
  // asserts the matched card shows this run's amount before clicking.
  const card = confirmerOC.locator(".action-card").filter({ hasText: `journey ${nonce}` }).last();
  const confirmBtn = card.locator("button").filter({ hasText: /^(Add to IOU|Confirm)$/i });
  // v1 vs v2 propose UI: the classic tree has .bubble-wrapper + a hover menu with a TEXT item; the
  // v2 (components_mobile) tree opens an icon-button sheet on LONG-PRESS, where the propose item is
  // the AutoFix (wand) ICON button — no text, so target its SVG path.
  const isV2 = (await proposerOC.locator(".bubble-wrapper").count()) === 0;
  console.log(`[${PROPOSER.user}] propose UI tree: ${isV2 ? "v2 (mobile)" : "v1 (classic)"}`);
  let posted = false;
  for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
    // Each attempt is fully fenced: any step timing out must fall through to the NEXT attempt, not
    // abort the run (a thrown click timeout previously killed the whole journey on a flaky menu).
    try {
      if (isV2) {
        const autoFix = proposerOC.locator('button:has(path[d^="M7.5,5.6"])').first(); // AutoFix icon
        // Long-press until the action sheet actually shows the AutoFix button (cooldowns/timing can
        // swallow a press), then click it.
        // The v2 MenuTrigger suppresses long-press during the SCROLL cooldown (longpressCooldown =
        // scrollStatus.isCooldown) — and the just-sent message auto-scrolls the chat. Let the
        // scroll settle before pressing, and back off between press retries.
        await proposerOC.waitForTimeout(3000);
        let sheetOpen = false;
        for (let press = 0; press < 3 && !sheetOpen; press++) {
          const msg = proposerOC.locator(".message_text").last();
          // Raw mouse coords do NOT auto-scroll (locator.hover/click do) — as the chat grows, the
          // last message sits above/below the viewport and presses land at negative Y. Scroll first.
          await msg.scrollIntoViewIfNeeded().catch(() => {});
          await proposerOC.waitForTimeout(800);
          const box = await msg.boundingBox();
          if (!box) throw new Error("v2: no message box");
          await proposerOC.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await proposerOC.mouse.down();
          await proposerOC.waitForTimeout(900);
          await proposerOC.mouse.up();
          sheetOpen = await autoFix.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
          if (!sheetOpen) await proposerOC.waitForTimeout(1500); // let any scroll cooldown lapse
        }
        if (!sheetOpen) throw new Error("v2: action sheet never opened");
        await autoFix.click({ timeout: 8000 });
      } else {
        const bubble = proposerOC.locator(".bubble-wrapper").last();
        await bubble.hover();
        await proposerOC.waitForTimeout(500);
        await bubble.locator(".menu-icon").first().click({ timeout: 12000 });
        await proposerOC.getByText("Propose action", { exact: true }).click({ timeout: 12000 });
      }
      console.log(`[${PROPOSER.user}] proposed (attempt ${attempt}, manual JSON — no model)`);
      posted = await confirmBtn.waitFor({ timeout: 30000 }).then(() => true).catch(() => false);
    } catch (e) {
      console.log(`[${PROPOSER.user}] propose attempt ${attempt} failed: ${(e as Error).message.slice(0, 90)}`);
    }
    if (!posted) {
      // Clear any leftover sheet/overlay before retrying.
      await proposerOC.keyboard.press("Escape").catch(() => {});
      await proposerOC.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => {});
      await proposerOC.waitForTimeout(1000);
    }
  }
  check(posted, `the action card posted (confirm visible on ${CONFIRMER.user}'s side)`);
  if (!posted) throw new Error("card never posted");

  // 5. The confirmer (the NON-proposer) confirms — on the nonce-scoped card only (see above).
  //    Belt-and-braces before clicking: the matched card must carry this run's amount 350 (a
  //    mis-scoped or stale card fails here instead of getting confirmed). The IOU manifest
  //    declares a DISCLOSURE, so the confirm button stays disabled until the acknowledgment
  //    checkbox ON THIS CARD is ticked.
  const cardText = (await card.innerText()).replace(/\s+/g, " ");
  const cardIsOurs = cardText.includes("350");
  check(cardIsOurs, `the matched card carries this run's amount 350 ("${cardText.slice(0, 80)}")`);
  if (!cardIsOurs) throw new Error("matched card is not this run's draft — refusing to confirm");
  await card.locator('input[type="checkbox"]').check({ timeout: 15000 });
  await confirmBtn.click();
  console.log(`[${CONFIRMER.user}] confirmed`);
  await confirmerOC.waitForTimeout(6000);

  // 6. Fan-out: ONE confirm → +1 envelope in EACH member's own bucket.
  const after = { proposer: await bucketCount(a, fpProposer), confirmer: await bucketCount(a, fpConfirmer) };
  console.log("[inbox] after:", after);
  check(after.proposer === before.proposer + 1, `${PROPOSER.user} bucket +1 (${before.proposer} → ${after.proposer})`);
  check(after.confirmer === before.confirmer + 1, `${CONFIRMER.user} bucket +1 (${before.confirmer} → ${after.confirmer})`);

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
