// AUTOMATED live verification of the MULTI-ENTRY confirmable-action flow (Issue 2):
//
//   one message → the model (here the deterministic manual seam) emits a JSON ARRAY of 2 entries →
//   ONE card → ONE confirm → ONE deposit / ONE messageId per member → on the IOU side ONE
//   "Pending from chat" card shows "2 entries" → "Review & add" opens the BatchConfirmModal →
//   "Add all 2 entries" writes BOTH entries (each tagged with the SAME import_message_id) → the card
//   disappears (messageId consumed) and re-importing is a no-op.
//
// Modeled on journey-fanout.ts (same env/attach/propose/confirm scaffolding). This is a SKELETON —
// the orchestrator runs and fixes it against the live env (replica :8080, OC :5003, IOU :3000, CDP
// 9241/9222/9231). Prereq: the manager↔father DM exists, both members are paired to IOU, and the
// chat is linked to a sheet (journey-fanout.ts establishes pairing; link the chat once via the IOU
// "Pending from chat" first-import "remember" checkbox or /openchat/link-chat).
//
//   pnpm exec tsx scripts/live/verify-multi-entry.ts
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

// ONE CDP connection per port (see journey-fanout.ts for why a second connection loses dialogs).
const connections = new Map<number, ReturnType<typeof chromium.connectOverCDP>>();
async function attach(port: number, urlPart: string): Promise<Page> {
  if (!connections.has(port)) connections.set(port, chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const browser = await connections.get(port)!;
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes(urlPart)) ?? ctx.pages()[0];
  if (!page) throw new Error(`no page on :${port}`);
  return page;
}

// Roles: proposer = manager (v1, :9241), confirmer = father (:9222 OC / :9231 IOU). The confirmer's
// IOU tab is where we drive the multi-entry import (its fan-out envelope carries the same messageId).
const PROPOSER = { user: "manager", ocPort: 9241 };
const CONFIRMER = { user: "father", ocPort: 9222, iouPort: 9231 };

async function main() {
  const a = await agent();
  const appId = await iouAppId(a);
  console.log(`[env] user_index=${IDS.userIndex} inbox=${IDS.inbox} appId=${appId}`);

  const proposerOC = await attach(PROPOSER.ocPort, "localhost:5003");
  const confirmerOC = await attach(CONFIRMER.ocPort, "localhost:5003");
  const confirmerIOU = await attach(CONFIRMER.iouPort, "127.0.0.1:3000");

  // 1. Open the direct chat on both OC sides; resolve both user ids from the URLs.
  await proposerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" });
  await proposerOC.waitForTimeout(3000);
  await proposerOC.locator(".chat-summary, .chat_summary").filter({ hasText: new RegExp(CONFIRMER.user, "i") }).first().click({ timeout: 15000 });
  await proposerOC.waitForTimeout(2500);
  const confirmerId = /user\/([a-z0-9-]+)/.exec(proposerOC.url())?.[1];
  check(!!confirmerId, `${CONFIRMER.user} user id resolved (${confirmerId})`);

  await confirmerOC.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
  await confirmerOC.waitForTimeout(3000);
  await confirmerOC.locator(".chat-summary, .chat_summary").filter({ hasText: new RegExp(PROPOSER.user, "i") }).first().click({ timeout: 15000 });
  await confirmerOC.waitForTimeout(2500);
  const proposerId = /user\/([a-z0-9-]+)/.exec(confirmerOC.url())?.[1];
  check(!!proposerId, `${PROPOSER.user} user id resolved (${proposerId})`);
  if (!confirmerId || !proposerId) throw new Error("could not resolve both user ids");

  const keys = await memberKeys(a, appId, [proposerId, confirmerId]);
  if (!keys.has(proposerId) || !keys.has(confirmerId)) {
    throw new Error("both members must be paired to IOU first — run journey-fanout.ts once to pair");
  }
  const fpConfirmer = await fingerprintOfPem(keys.get(confirmerId)!);
  const beforeBucket = await bucketCount(a, fpConfirmer);
  console.log(`[inbox] confirmer bucket before: ${beforeBucket}`);

  // 2. Propose with the manual seam, answering with a 2-ELEMENT ARRAY (Issue 2 wire form).
  await proposerOC.evaluate(`localStorage.setItem("oc:manualExtract","1")`);
  const nonce = Date.now() % 1000000;
  const text = `Multi ${nonce}: two fees`;
  const extraction = JSON.stringify([
    { kind: "iou", amount: 350, currency: "EGP", direction: "credit", note: `multi-a ${nonce}` },
    { kind: "iou", amount: 500, currency: "EGP", direction: "credit", note: `multi-b ${nonce}` },
  ]);
  proposerOC.on("dialog", (d) => {
    const reply = /JSON/i.test(d.message()) ? extraction : "1";
    d.accept(reply).catch(() => {});
  });
  const composer = proposerOC.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await proposerOC.keyboard.type(text);
  await proposerOC.keyboard.press("Enter");
  await proposerOC.waitForTimeout(2500);

  // v1 propose (manager): hover the just-sent bubble → .menu-icon → "Propose action". IOU renders
  // its own card in an <iframe>, so this run's entry NOTES live in the iframe's editable inputs (not
  // the outer .action-card innerText). A MULTI card's confirm is the iframe's "Add all N entries"
  // button (no OC disclosure checkbox — the app owns the card).
  async function findOurFrame(): Promise<ReturnType<typeof confirmerOC.frameLocator> | null> {
    for (const c of await confirmerOC.locator(".action-card:has(iframe)").all()) {
      const inputs = c.frameLocator("iframe").locator("input");
      const cnt = await inputs.count().catch(() => 0);
      for (let i = 0; i < cnt; i++) {
        if ((await inputs.nth(i).inputValue().catch(() => "")).includes(`multi-a ${nonce}`)) {
          return c.frameLocator("iframe");
        }
      }
    }
    return null;
  }
  async function ourCardPosted(): Promise<boolean> {
    for (let i = 0; i < 16; i++) {
      const f = await findOurFrame();
      if (f && (await f.getByRole("button", { name: /Add all \d+ entries/i }).count().catch(() => 0))) return true;
      await confirmerOC.waitForTimeout(2000);
    }
    return false;
  }
  let posted = false;
  for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
    try {
      const bubble = proposerOC.locator(".bubble-wrapper").last();
      await bubble.scrollIntoViewIfNeeded().catch(() => {});
      await bubble.hover();
      await proposerOC.waitForTimeout(500);
      await bubble.locator(".menu-icon").first().click({ timeout: 12000 });
      await proposerOC.getByText("Propose action", { exact: true }).click({ timeout: 12000 });
      posted = await ourCardPosted();
    } catch (e) {
      console.log(`propose attempt ${attempt} failed: ${(e as Error).message.slice(0, 90)}`);
    }
    if (!posted) {
      await proposerOC.keyboard.press("Escape").catch(() => {});
      await proposerOC.waitForTimeout(1000);
    }
  }
  check(posted, "the multi-entry action card posted (Add all N entries visible on confirmer's side)");
  if (!posted) throw new Error("card never posted");

  // 3. Confirm once (ONE deposit / ONE messageId per member) via the iframe's "Add all N entries".
  const frame = await findOurFrame();
  if (!frame) throw new Error("this run's multi card iframe not found — refusing to confirm");
  await frame.getByRole("button", { name: /Add all \d+ entries/i }).click({ timeout: 15000 });
  await confirmerOC.waitForTimeout(6000);
  const afterBucket = await bucketCount(a, fpConfirmer);
  check(afterBucket === beforeBucket + 1, `ONE deposit for the whole batch (${beforeBucket} → ${afterBucket})`);

  // 4. IOU side: the "Pending from chat" card shows "2 entries"; Review & add → Add all → 2 land.
  // The card is scoped to the sheet the proposer's chat is LINKED to (draftBelongsOnSheet). Resolve
  // that sheet from the confirmer's chat→sheet links; a chat with no link would show on any sheet,
  // but ours is linked (journey-fanout's confirm remembers chat → sheet), so target it directly.
  const chatKey = `direct:${proposerId}`;
  const linkedSheet = (await confirmerIOU.evaluate((key: string) => {
    try {
      return (JSON.parse(localStorage.getItem("iou.openchat.chatSheetLinks.v1") || "{}") as Record<string, string>)[key] ?? null;
    } catch {
      return null;
    }
  }, chatKey)) as string | null;
  check(!!linkedSheet, `proposer chat ${chatKey} is linked to a sheet (${linkedSheet})`);
  if (!linkedSheet) throw new Error("link the chat to a sheet first (import once with the remember checkbox on)");
  await confirmerIOU.goto(`http://127.0.0.1:3000/sheet/${linkedSheet}`, { waitUntil: "domcontentloaded" });
  await confirmerIOU.waitForTimeout(2500);

  // The pending card summary must read "2 entries: …" (batchSummary). Poll — the inbox polls at 15 s.
  const pendingCard = confirmerIOU.locator("li").filter({ hasText: /2 entr/i }).filter({ hasText: new RegExp(`multi-a ${nonce}`) }).first();
  let sawCount = false;
  for (let i = 0; i < 12 && !sawCount; i++) {
    sawCount = await pendingCard.isVisible().catch(() => false);
    if (!sawCount) {
      await confirmerIOU.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await confirmerIOU.waitForTimeout(3000);
    }
  }
  check(sawCount, 'the IOU pending card shows "2 entries"');

  if (sawCount) {
    await pendingCard.getByRole("button", { name: /Review & add/ }).click({ timeout: 10000 });
    // The BatchConfirmModal: "Add 2 entries?" + an "Add all 2 entries" primary button.
    const modal = confirmerIOU.getByRole("dialog");
    await modal.getByRole("heading", { name: /Add 2 entries\?/ }).waitFor({ timeout: 10000 });
    check(true, "BatchConfirmModal opened listing the 2 entries");
    await modal.getByRole("button", { name: /Add all 2 entries/ }).click({ timeout: 10000 });
    await confirmerIOU.waitForTimeout(4000);

    // Both entries land in the history and the pending card is gone (messageId consumed).
    const historyText = (await confirmerIOU.locator("section.history").innerText().catch(() => "")).replace(/\s+/g, " ");
    check(new RegExp(`multi-a ${nonce}`).test(historyText), "entry A landed in history");
    check(new RegExp(`multi-b ${nonce}`).test(historyText), "entry B landed in history");
    check(!(await pendingCard.isVisible().catch(() => false)), "the pending card disappeared after Add all (messageId consumed)");
  }

  if (failures > 0) {
    console.error(`\nMULTI-ENTRY VERIFY FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 MULTI-ENTRY LIVE VERIFY PASSED: array → 1 card '2 entries' → Add all → 2 entries, 1 messageId");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
