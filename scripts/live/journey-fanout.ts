// AUTOMATED live journey (P0-30/32 class): pairing → propose → confirm → confirmer deposit, asserted.
//
//   manager (browser :9241, IOU tab same profile)  ──┐ direct chat
//   father  (desktop OC :9222, IOU tab :9231)       ──┘
//
// Steps (each asserted; exit 1 on any failure):
//   1. Resolve the manager↔father direct chat + both OC user ids from the chat URLs.
//   2. Ensure BOTH signed-in IOU profiles have an authenticated inbox selector; any member missing
//      one is paired live via the real UI: OC AI-apps → Connect → read the claim token → IOU
//      /settings → claim. (The connect flow itself is part of the journey.)
//   3. Snapshot both members' action_inbox fingerprint buckets.
//   4. manager sends a fresh chat message and proposes via the DETERMINISTIC manual-JSON path
//      (browser clients prompt for the extraction JSON — no on-device model, no nondeterminism).
//   5. father (the NON-proposer) confirms the card.
//   6. Assert ONE confirm deposited exactly +1 envelope into the confirmer's own bucket and did not
//      leak a copy into the non-confirmer's account.
//   7. On the confirmer's IOU page, follow the draft's authoritative chat route, press
//      "Review & add", submit the prefilled EntryForm, and assert this run's nonce in History.
//      The exact nonce-scoped entry is soft-deleted afterwards so repeated runs do not affect
//      balances (the canister intentionally retains its audit tombstone).
//
// Repeatable: assertions are relative to the before-counts. Requires the live env (replica :8080,
// OC :5003, IOU :3000, CDP 9241/9222/9231 — launch.ps1 + restore-all.sh).
//
//   pnpm exec tsx scripts/live/journey-fanout.ts
import {
  chromium,
  type Dialog,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
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

async function proposalFailureText(page: Page): Promise<string | null> {
  const toast = page.locator(".toast .message.failure").last();
  if (!(await toast.isVisible().catch(() => false))) return null;
  const text = (await toast.innerText().catch(() => "")).trim();
  if (!text) return null;
  // Failure messages should not contain credentials, but keep diagnostics safe if a backend ever
  // starts echoing a URL, claim code, or opaque identifier into one.
  return text
    .replace(/([?&](?:token|code|claim|credential)[^=]*)=[^\s&]+/gi, "$1=<redacted>")
    .replace(/\b[a-z0-9]{5}(?:-[a-z0-9]{3,5}){2,}\b/gi, "<id>")
    .slice(0, 240);
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

const inboxIdl = ({ IDL: idl }: any) => {
  const Args = idl.Record({ max_results: idl.Nat32, consumer_key_fingerprint: idl.Vec(idl.Nat8), since_id: idl.Nat64 });
  const StoredAction = idl.Record({
    id: idl.Nat64, ciphertext: idl.Vec(idl.Nat8), ephemeral_public_key: idl.Vec(idl.Nat8),
    created_at: idl.Nat64, oc_signature: idl.Vec(idl.Nat8),
  });
  return idl.Service({
    actions: idl.Func([Args], [idl.Variant({ Success: idl.Record({ actions: idl.Vec(StoredAction) }) })], []),
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

type InboxPairingState = {
  selector: Uint8Array | null;
  current: boolean;
  bindingRevision: string | null;
  configuredRevision: string | null;
};

async function actionInboxState(page: Page): Promise<InboxPairingState> {
  // Keep this browser-native: tsx/esbuild's keepNames transform injects its Node-side __name helper
  // into nested callbacks, but Playwright serializes only the callback body into the page.
  const state = (await page.evaluate(`(async () => {
    const inbox = await import("/src/features/openchat/actionInboxClient.ts");
    const auth = await import("/src/features/auth/AuthProvider.tsx");
    const declarations = await import("/src/backend/declarations.ts");
    const identity = auth.loadDevIdentityForDiagnostics();
    if (!identity) throw new Error("signed-in local development identity is required");
    const actor = declarations.createActor(await auth.buildAgent(identity));
    const config = await inbox.getActionInboxConfig(actor);
    const binding = (await actor.get_openchat_binding())[0];
    const configured = (await actor.get_config()).ai_app_verification_binding[0];
    const samePrincipal = (left, right) => left?.toText() === right?.toText();
    const selector = config ? Array.from(config.consumerKeySelector) : null;
    const selectorMatches =
      selector !== null &&
      binding !== undefined &&
      selector.length === binding.consumer_queue_selector.length &&
      selector.every((byte, index) => byte === binding.consumer_queue_selector[index]);
    const current = Boolean(
      config &&
      binding &&
      configured &&
      binding.app_id === configured.app_id &&
      binding.app_revision === configured.app_revision &&
      samePrincipal(binding.app_canister_id, configured.app_canister_id) &&
      samePrincipal(binding.user_index_canister_id, configured.user_index_canister_id) &&
      selectorMatches
    );
    return {
      selector,
      current,
      bindingRevision: binding?.app_revision?.toString() ?? null,
      configuredRevision: configured?.app_revision?.toString() ?? null,
    };
  })()`)) as {
    selector: number[] | null;
    current: boolean;
    bindingRevision: string | null;
    configuredRevision: string | null;
  };
  return {
    ...state,
    selector: state.selector === null ? null : Uint8Array.from(state.selector),
  };
}

type LoadedRunCard = {
  card: Locator;
  frame: FrameLocator;
  observerId: string;
  loadedFromCleanGate: boolean;
};

type InboxRunLookup = {
  found: boolean;
  linkedSheet: string | null;
  matched: number;
  acknowledged: number;
};

// Observe cards that are added after this point and retain each card's presentation transitions.
// The exact sender card is identified later from the nonce inside its isolated iframe; the observer
// id then lets the journey prove that same DOM card moved from optimistic/unverified to the
// backend-verified directory binding without a page reload.
async function installNewCardObserver(page: Page, tag: string): Promise<void> {
  await page.evaluate(`(() => {
    const observerTag = ${JSON.stringify(tag)};
    const root = globalThis;
    if (root.__iouJourneyCardObserver) {
      root.__iouJourneyCardObserver.observer.disconnect();
    }
    const state = {
      tag: observerTag,
      nextId: 0,
      baseline: new Set(document.querySelectorAll(".action-card")),
      records: {},
      observer: null,
    };
    const sample = () => {
      for (const card of document.querySelectorAll(".action-card")) {
        if (state.baseline.has(card)) continue;
        let id = card.dataset.iouJourneyCardId;
        if (!id) {
          id = observerTag + "-" + state.nextId++;
          card.dataset.iouJourneyCardId = id;
        }
        const text = card.innerText.replace(/\\s+/g, " ").trim();
        const records = (state.records[id] ??= []);
        if (records.at(-1) !== text) records.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    state.observer = observer;
    root.__iouJourneyCardObserver = state;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    sample();
  })()`);
}

async function observedCardTransitions(page: Page, observerId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const root = globalThis as typeof globalThis & {
      __iouJourneyCardObserver?: { records: Record<string, string[]> };
    };
    return [...(root.__iouJourneyCardObserver?.records[id] ?? [])];
  }, observerId);
}

async function removeNewCardObserver(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const root = globalThis as typeof globalThis & {
        __iouJourneyCardObserver?: {
          observer: MutationObserver;
          tag: string;
        };
      };
      const state = root.__iouJourneyCardObserver;
      state?.observer.disconnect();
      if (state) {
        for (const card of document.querySelectorAll<HTMLElement>(
          ".action-card[data-iou-journey-card-id]",
        )) {
          if (card.dataset.iouJourneyCardId?.startsWith(`${state.tag}-`)) {
            delete card.dataset.iouJourneyCardId;
          }
        }
      }
      delete root.__iouJourneyCardObserver;
    })
    .catch(() => {});
}

async function findAndLoadRunCard(
  page: Page,
  note: string,
  who: string,
  timeoutMs = 35_000,
  failOnProposalToast = false,
): Promise<LoadedRunCard | null> {
  const cleanGateIds = new Set<string>();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failOnProposalToast) {
      const failure = await proposalFailureText(page);
      if (failure) throw new Error(`proposal UI failure: ${failure}`);
    }
    const cards = page.locator(".action-card[data-iou-journey-card-id]");
    const count = await cards.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const card = cards.nth(index);
      if (!(await card.isVisible().catch(() => false))) continue;
      const observerId = await card.getAttribute("data-iou-journey-card-id");
      if (!observerId) continue;

      // Do not contact an arbitrary external origin. Only a newly added card whose authoritative
      // directory identity has resolved to IOU may have its explicit load gate opened.
      const isIou = await card
        .getByText(/Directory entry:\s*iou/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (!isIou) continue;
      const hasUntrustedWarning = await card
        .getByText(/card content is untrusted|Untrusted card text/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (hasUntrustedWarning) continue;

      if ((await card.locator("iframe").count()) === 0) {
        const load = card.getByRole("button", { name: "Load app card", exact: true });
        if (await load.isVisible().catch(() => false)) {
          if (!(await load.isEnabled().catch(() => false))) {
            throw new Error(`[${who}] this run's verified Load app card gate is disabled`);
          }
          await load.click({ timeout: 10_000 });
          cleanGateIds.add(observerId);
        }
      }

      if ((await card.locator("iframe").count()) === 0) continue;
      const frame = card.frameLocator("iframe");
      await frame.locator("input").first().waitFor({ timeout: 4_000 }).catch(() => {});
      const inputs = frame.locator("input");
      const inputCount = await inputs.count().catch(() => 0);
      const values: string[] = [];
      for (let input = 0; input < inputCount; input++) {
        values.push(await inputs.nth(input).inputValue().catch(() => ""));
      }
      if (values.includes(note)) {
        return {
          card,
          frame,
          observerId,
          loadedFromCleanGate: cleanGateIds.has(observerId),
        };
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function approveRunCardConfirmation(
  loaded: LoadedRunCard,
  note: string,
  currency: string,
): Promise<void> {
  const add = loaded.frame.getByRole("button", { name: "Add to IOU", exact: true });
  await add.waitFor({ state: "visible", timeout: 10_000 });
  if (!(await add.isEnabled())) throw new Error("the nonce-scoped Add to IOU button is disabled");
  await add.click();

  const approval = loaded.card.getByRole("group", { name: "Approve app card request" });
  await approval.waitFor({ state: "visible", timeout: 10_000 });
  const summary = await approval.innerText();
  if (!summary.includes(note) || !summary.includes("350") || !summary.includes(currency)) {
    throw new Error("host approval summary is not bound to this run's exact card values");
  }
  const disclosure = approval.getByRole("checkbox");
  if (await disclosure.isVisible().catch(() => false)) await disclosure.check();
  await approval.getByRole("button", { name: "Confirm request", exact: true }).click({
    timeout: 10_000,
  });
}

async function cancelRunCard(loaded: LoadedRunCard): Promise<boolean> {
  const cancel = loaded.frame.getByRole("button", { name: "Cancel", exact: true });
  if (!(await cancel.isVisible().catch(() => false))) return false;
  await cancel.click({ timeout: 8_000 });
  const approval = loaded.card.getByRole("group", { name: "Approve app card request" });
  if (!(await approval.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false))) {
    return false;
  }
  await approval.getByRole("button", { name: "Cancel card", exact: true }).click({
    timeout: 8_000,
  });
  return true;
}

async function lookupInboxRun(
  page: Page,
  note: string,
  acknowledge: boolean,
): Promise<InboxRunLookup> {
  const input = JSON.stringify({ exactNote: note, shouldAcknowledge: acknowledge });
  return (await page.evaluate(`(async ({ exactNote, shouldAcknowledge }) => {
      // Execute as browser-native JavaScript: this callback has recursive/nested helpers that must
      // not inherit tsx/esbuild's Node-side keepNames implementation.
      const inbox = await import("/src/features/openchat/actionInboxClient.ts");
      const auth = await import("/src/features/auth/AuthProvider.tsx");
      const declarations = await import("/src/backend/declarations.ts");
      const routing = await import("/src/features/openchat/chatSheetLinks.ts");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("signed-in local development identity is required");
      const actor = declarations.createActor(await auth.buildAgent(identity));
      const config = await inbox.getActionInboxConfig(actor);
      if (!config) throw new Error("OpenChat binding is not configured");
      const containsNote = (value) => {
        if (Array.isArray(value)) return value.some(containsNote);
        return (
          typeof value === "object" &&
          value !== null &&
          "note" in value &&
          value.note === exactNote
        );
      };
      const drafts = await inbox.pollActionInbox({
        config,
        identity,
        maxResults: 120,
      });
      const matches = drafts.filter((candidate) => containsNote(candidate.draft));
      const links = await routing.fetchChatSheetLinks(
        actor,
        identity.getPrincipal().toText(),
      );
      const linkedSheets = new Set(
        matches
          .map((match) => links[match.context.chatHandle])
          .filter((sheet) =>
            typeof sheet === "string" && sheet.length > 0,
          ),
      );
      let acknowledged = 0;
      if (shouldAcknowledge) {
        for (const match of matches) {
          const result = await inbox.acknowledgeActionInbox({
            config,
            identity,
            throughId: match.id,
            acknowledgementSecret: match.acknowledgementSecret,
          });
          acknowledged += result.acknowledged;
        }
      }
      return {
        found: matches.length > 0,
        linkedSheet: linkedSheets.size === 1 ? [...linkedSheets][0] : null,
        matched: matches.length,
        acknowledged,
      };
    })(${input})`)) as InboxRunLookup;
}

async function cleanupIouRun(
  page: Page,
  note: string,
  knownSheet: string | null,
  who: string,
  waitForImportedEntry: boolean,
): Promise<{ sheet: string | null; deletedEntries: number; acknowledged: number }> {
  await page.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" }).catch(() => {});
  let lookup: InboxRunLookup = { found: false, linkedSheet: null, matched: 0, acknowledged: 0 };
  for (let attempt = 0; attempt < 10 && !lookup.found && knownSheet === null; attempt++) {
    lookup = await lookupInboxRun(page, note, false);
    if (!lookup.found) await page.waitForTimeout(1_500);
  }
  const sheet = knownSheet ?? lookup.linkedSheet;
  let deletedEntries = 0;
  if (sheet) {
    await page.goto(`${IOU_BASE}/sheet/${sheet}`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog");
    if (await dialog.isVisible().catch(() => false)) {
      const dialogNote = await dialog
        .getByLabel("Note", { exact: true })
        .inputValue()
        .catch(() => "");
      if (dialogNote === note) {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
      }
    }

    const exactEntries = page
      .locator("section.history")
      .locator(":scope > ul > li")
      .filter({ hasText: note });
    if (waitForImportedEntry) {
      await exactEntries.first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = exactEntries.first();
      if (!(await row.isVisible().catch(() => false))) break;
      const remove = row.getByRole("button", { name: "delete", exact: true });
      if (!(await remove.isVisible().catch(() => false))) {
        throw new Error(`[${who}] exact nonce entry is visible but has no delete action`);
      }
      await remove.click({ timeout: 8_000 });
      await row.waitFor({ state: "hidden", timeout: 15_000 });
      deletedEntries++;
    }
  }

  // The per-delivery acknowledgement secret authorizes removal of only this exact signed inbox
  // envelope. Do this for both users so fan-out QC does not grow either persistent bucket.
  const acknowledged = await lookupInboxRun(page, note, true);
  if (sheet) {
    await page.goto(`${IOU_BASE}/sheet/${sheet}`, { waitUntil: "domcontentloaded" });
    const pending = page
      .locator("section.card")
      .filter({ has: page.getByRole("heading", { name: /Pending from chat/i }) })
      .locator(":scope > ul > li")
      .filter({ hasText: note });
    if (await pending.first().isVisible().catch(() => false)) {
      // Fallback for an already-rendered local echo. This remains nonce-scoped and uses the product's
      // ordinary dismiss path; it cannot touch another user's draft.
      await pending
        .first()
        .getByTitle("Dismiss without adding (for everyone on this sheet)")
        .click({ timeout: 8_000 });
      await pending.first().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    }
  }
  return { sheet, deletedEntries, acknowledged: acknowledged.acknowledged };
}

// Pair one member with IOU via the REAL Connect UI: OC AI-apps directory → Connect → claim token →
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
  await oc.locator("code.code").first().waitFor({ timeout: 20000 });
  const code = (await oc.locator("code.code").first().innerText()).trim();
  if (!/^[0-9a-f]{64}$/.test(code)) throw new Error(`[${who}] malformed claim token`);
  console.log(`[${who}] received one-time claim token (${code.length} hex chars; redacted)`);

  await iou.goto(`${IOU_BASE}/settings`, { waitUntil: "domcontentloaded" });
  await iou.getByRole("heading", { name: /OpenChat action inbox/i }).waitFor({ timeout: 20000 });
  await iou.locator('input[placeholder="64-character claim token"]').fill(code);
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

  // 2. The cross-user key lookup is intentionally C2C-only. Each signed-in IOU profile exposes
  //    only its own caller-private selector through its authenticated backend binding, which is
  //    exactly what this journey needs to address and count that user's inbox bucket.
  let proposerState = await actionInboxState(proposerIOU);
  let confirmerState = await actionInboxState(confirmerIOU);
  if (!proposerState.current) {
    console.log(
      `[${PROPOSER.user}] reconnecting stale/missing OpenChat link (${proposerState.bindingRevision ?? "none"} -> ${proposerState.configuredRevision ?? "unknown"})`,
    );
    await pairViaUi(proposerOC, proposerIOU, PROPOSER.user);
  }
  if (!confirmerState.current) {
    console.log(
      `[${CONFIRMER.user}] reconnecting stale/missing OpenChat link (${confirmerState.bindingRevision ?? "none"} -> ${confirmerState.configuredRevision ?? "unknown"})`,
    );
    await pairViaUi(confirmerOC, confirmerIOU, CONFIRMER.user);
  }
  proposerState = await actionInboxState(proposerIOU);
  confirmerState = await actionInboxState(confirmerIOU);
  const proposerSelector = proposerState.selector;
  const confirmerSelector = confirmerState.selector;
  check(
    proposerState.current && !!proposerSelector,
    `${PROPOSER.user} has a current-revision authenticated per-user IOU inbox selector`,
  );
  check(
    confirmerState.current && !!confirmerSelector,
    `${CONFIRMER.user} has a current-revision authenticated per-user IOU inbox selector`,
  );
  if (!proposerSelector || !confirmerSelector) throw new Error("pairing failed");

  // Re-open the direct chat on BOTH sides (pairing navigates each paired member's OC page away to
  // /communities — the confirm gate polls the confirmer's page, so their chat must be open too).
  for (const [page, rowRx] of [[proposerOC, proposerRow], [confirmerOC, confirmerRow]] as const) {
    await page.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.locator(".chat-summary, .chat_summary").filter({ hasText: rowRx }).first().click({ timeout: 15000 });
    await page.waitForTimeout(2000);
  }

  // 3. Bucket snapshot.
  const fpProposer = proposerSelector;
  const fpConfirmer = confirmerSelector;
  const before = { proposer: await bucketCount(a, fpProposer), confirmer: await bucketCount(a, fpConfirmer) };
  console.log("[inbox] before:", before);

  const nonce = `${Date.now()}-${webcrypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const note = `journey ${nonce}`;
  const text = `Journey ${nonce}: cleaning fee 350 EGP`;
  const extraction = JSON.stringify({
    kind: "iou",
    amount: 350,
    currency: "EGP",
    direction: "credit",
    note,
  });
  let previousManualExtract: string | null | undefined;
  let manualExtractTouched = false;
  let proposerObserverInstalled = false;
  let confirmerObserverInstalled = false;
  let dialogListenerInstalled = false;
  let navigationListenerInstalled = false;
  let senderMainFrameNavigations = 0;
  let senderCard: LoadedRunCard | null = null;
  let confirmerCard: LoadedRunCard | null = null;
  let confirmerLinkedSheet: string | null = null;
  let confirmationAttempted = false;
  let entrySubmissionAttempted = false;
  let deliveryObserved = false;
  let journeyBodyCompleted = false;
  const documentMarker = `iou-card-journey-${nonce}`;
  const onDialog = (d: Dialog) => {
    const msg = d.message();
    const reply = /JSON/i.test(msg) ? extraction : "1";
    console.log(`[${PROPOSER.user}] extraction/app dialog -> ${reply.slice(0, 50)}`);
    d.accept(reply).catch(() =>
      console.log(`[${PROPOSER.user}] dialog accept raced - will retry propose`),
    );
  };
  const onSenderNavigation = (frame: Frame) => {
    if (frame === proposerOC.mainFrame()) senderMainFrameNavigations++;
  };

  try {

  // 4. The proposer sends a message + proposes via the DETERMINISTIC manual-JSON prompt.
  // Issue 1 test seam: with no on-device model, REAL users are now guided to set one up instead of a
  // raw JSON prompt. The automated journey drives the deterministic manual-JSON path, so it OPTS IN
  // to the manual prompt by setting oc:manualExtract="1" on the proposer's OC page before proposing.
  previousManualExtract = await proposerOC.evaluate(() => localStorage.getItem("oc:manualExtract"));
  await proposerOC.evaluate(() => localStorage.setItem("oc:manualExtract", "1"));
  manualExtractTouched = true;
  await installNewCardObserver(proposerOC, `sender-${nonce}`);
  proposerObserverInstalled = true;
  await installNewCardObserver(confirmerOC, `recipient-${nonce}`);
  confirmerObserverInstalled = true;
  await proposerOC.evaluate((marker) => {
    (globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string })
      .__iouJourneyDocumentMarker = marker;
  }, documentMarker);
  proposerOC.on("framenavigated", onSenderNavigation);
  navigationListenerInstalled = true;
  proposerOC.on("dialog", onDialog);
  dialogListenerInstalled = true;
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
  // IOU now renders its own card in an <iframe> (app-owned card), so this run's note
  // (`journey ${nonce}`) and amount (350) live in the iframe's editable INPUTS, not the outer
  // .action-card innerText. findOurFrame() returns the frameLocator for the card whose inputs carry
  // our unique note; the app-card bridge confirm is screened by pending && !readonly (no OC
  // disclosure checkbox — the app owns any disclosure), so confirming is just the iframe's button.
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
      await proposerOC.locator(".toast .close").last().click({ timeout: 1_000 }).catch(() => {});
      if (isV2) {
        const autoFix = proposerOC.locator('button:has(path[d^="M7.5,5.6"])').first(); // AutoFix icon
        // Open the v2 action sheet, then click the AutoFix item. The gesture depends on the device:
        // MenuTrigger only wires the longpress action when `isTouchDevice`; on a NON-touch device
        // (this harness's desktop Chrome at a narrow width) a long press is just a click, and a click
        // must NOT open the menu — that was the bug where opening a chat also opened its context menu
        // — so the desktop equivalent is a RIGHT-CLICK (oncontextmenu). Try right-click first and keep
        // the long press as the fallback for a genuinely touch-enabled run.
        // The v2 MenuTrigger also suppresses long-press during the SCROLL cooldown (longpressCooldown
        // = scrollStatus.isCooldown) — and the just-sent message auto-scrolls the chat. Let the scroll
        // settle before pressing, and back off between retries.
        await proposerOC.waitForTimeout(3000);
        let sheetOpen = false;
        for (let press = 0; press < 3 && !sheetOpen; press++) {
          const msg = proposerOC.locator(".message_text").filter({ hasText: text }).last();
          // Raw mouse coords do NOT auto-scroll (locator.hover/click do) — as the chat grows, the
          // last message sits above/below the viewport and presses land at negative Y. Scroll first.
          await msg.scrollIntoViewIfNeeded().catch(() => {});
          await proposerOC.waitForTimeout(800);
          await msg.click({ button: "right", timeout: 6000 }).catch(() => {});
          sheetOpen = await autoFix.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
          if (!sheetOpen) {
            const box = await msg.boundingBox();
            if (!box) throw new Error("v2: no message box");
            await proposerOC.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await proposerOC.mouse.down();
            await proposerOC.waitForTimeout(900);
            await proposerOC.mouse.up();
            sheetOpen = await autoFix.waitFor({ state: "visible", timeout: 4000 }).then(() => true).catch(() => false);
          }
          if (!sheetOpen) await proposerOC.waitForTimeout(1500); // let any scroll cooldown lapse
        }
        if (!sheetOpen) throw new Error("v2: action sheet never opened");
        await autoFix.click({ timeout: 8000 });
      } else {
        const bubble = proposerOC.locator(".bubble-wrapper").filter({ hasText: text }).last();
        await bubble.hover();
        await proposerOC.waitForTimeout(500);
        await bubble.locator(".menu-icon").first().click({ timeout: 12000 });
        await proposerOC.getByText("Propose action", { exact: true }).click({ timeout: 12000 });
      }
      console.log(`[${PROPOSER.user}] proposed (attempt ${attempt}, manual JSON — no model)`);
      senderCard ??= await findAndLoadRunCard(proposerOC, note, PROPOSER.user, 18_000, true);
      if (senderCard) {
        // A sender-side card proves the post succeeded. Do not post a duplicate merely because the
        // other browser is still catching up; wait for its authoritative hydration instead.
        confirmerCard ??= await findAndLoadRunCard(confirmerOC, note, CONFIRMER.user, 35_000);
      }
      posted = senderCard !== null && confirmerCard !== null;
      if (!posted) {
        const failure = await proposalFailureText(proposerOC);
        if (failure) console.log(`[${PROPOSER.user}] proposal failure: ${failure}`);
      }
    } catch (e) {
      console.log(`[${PROPOSER.user}] propose attempt ${attempt} failed: ${(e as Error).message.slice(0, 90)}`);
    }
    if (!posted) {
      // Clear any leftover sheet/overlay before retrying.
      await proposerOC.keyboard.press("Escape").catch(() => {});
      await proposerOC.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => {});
      await proposerOC.waitForTimeout(1000);
    }
    if (senderCard && !posted) break;
  }
  check(posted, `the nonce-scoped action card loaded through the explicit gate on both sides`);
  if (!posted) throw new Error("card never posted");

  check(senderCard!.loadedFromCleanGate, "sender opened this new card through Load app card");
  check(confirmerCard!.loadedFromCleanGate, "recipient opened this new card through Load app card");
  const senderTransitions = await observedCardTransitions(proposerOC, senderCard!.observerId);
  const sawOptimistic = senderTransitions.some((value) => value.includes("Unverified card binding"));
  const sawVerified = senderTransitions.some((value) => /Directory entry:\s*iou/i.test(value));
  const markerSurvived = await proposerOC.evaluate(
    (marker) =>
      (globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string })
        .__iouJourneyDocumentMarker === marker,
    documentMarker,
  );
  check(sawOptimistic, "sender card was observed in its optimistic/unverified state");
  check(sawVerified, "the same sender card became directory-bound and actionable");
  check(
    markerSurvived && senderMainFrameNavigations === 0,
    "sender optimistic→verified transition completed in-place without reload/navigation",
  );
  if (!sawOptimistic || !sawVerified || !markerSurvived || senderMainFrameNavigations !== 0) {
    throw new Error("sender card did not transition from optimistic to verified in place");
  }

  // 5. The confirmer (the NON-proposer) confirms — on the nonce-scoped iframe card only (see above).
  //    Belt-and-braces before clicking: the matched iframe must carry this run's amount 350 in one of
  //    its inputs (a mis-scoped or stale card fails here instead of getting confirmed). The app-owned
  //    card has no OC disclosure checkbox — confirm is the iframe's "Add to IOU" button.
  const outerCard = confirmerCard!.card;
  const frame = confirmerCard!.frame;
  const outerText = await outerCard.innerText();
  const staleDirectoryWarning = outerText.includes("Directory binding only; card content is untrusted");
  const staleTextWarning = outerText.includes("Untrusted card text");
  check(!staleDirectoryWarning, "backend-attested card omits the stale untrusted-content warning");
  check(!staleTextWarning, "backend-attested card omits the stale untrusted-text warning");
  if (staleDirectoryWarning || staleTextWarning) {
    throw new Error("backend-attested card still renders stale untrusted-content copy");
  }
  const inputVals: string[] = [];
  const fin = frame.locator("input");
  const finCount = await fin.count().catch(() => 0);
  for (let i = 0; i < finCount; i++) inputVals.push(await fin.nth(i).inputValue().catch(() => ""));
  const cardIsOurs = inputVals.includes("350");
  check(cardIsOurs, `the matched card carries this run's amount 350 (${JSON.stringify(inputVals)})`);
  if (!cardIsOurs) throw new Error("matched card is not this run's draft — refusing to confirm");
  const cardCurrency = await frame.getByLabel("Currency", { exact: true }).inputValue();
  check(cardCurrency === "EGP", `the matched card preserves this run's stated EGP currency`);
  if (cardCurrency !== "EGP") {
    throw new Error("matched card changed this run's stated EGP currency to " + (cardCurrency || "default"));
  }
  confirmationAttempted = true;
  await approveRunCardConfirmation(confirmerCard!, note, "EGP");
  console.log(`[${CONFIRMER.user}] approved the app request through the OpenChat host`);
  await confirmerOC.waitForTimeout(6000);

  // 6. Per-user delivery: ONE confirm → +1 envelope for the authoritative confirmer only. The
  //    non-confirmer's own key must not receive a copy (OpenChat's card route is confirmer-bound).
  const after = { proposer: await bucketCount(a, fpProposer), confirmer: await bucketCount(a, fpConfirmer) };
  console.log("[inbox] after:", after);
  check(after.proposer === before.proposer, `${PROPOSER.user} non-confirmer bucket unchanged (${before.proposer})`);
  check(after.confirmer === before.confirmer + 1, `${CONFIRMER.user} bucket +1 (${before.confirmer} → ${after.confirmer})`);
  deliveryObserved = after.proposer === before.proposer && after.confirmer === before.confirmer + 1;

  // 7. Continue through the IOU consumer UI. Resolve this exact delivery's opaque chat handle from
  //    the verified inbox envelope, then resolve that handle through the authenticated user's
  //    canister-backed chat→sheet map. Do not guess from a raw OpenChat user id or a legacy
  //    localStorage key: v4 routes are app-scoped 32-byte handles.
  await confirmerIOU.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" });
  let route: InboxRunLookup = { found: false, linkedSheet: null, matched: 0, acknowledged: 0 };
  for (let i = 0; i < 10 && !route.found; i++) {
    route = await lookupInboxRun(confirmerIOU, note, false);
    if (!route.found) await confirmerIOU.waitForTimeout(2000);
  }
  check(route.found, `the verified IOU inbox contains this run's draft (${note})`);
  check(!!route.linkedSheet, `this chat's app-scoped route resolves to one IOU sheet`);
  if (!route.found || !route.linkedSheet) {
    throw new Error("this run's verified draft or authoritative chat→sheet route is unavailable");
  }
  confirmerLinkedSheet = route.linkedSheet;

  await confirmerIOU.goto(`${IOU_BASE}/sheet/${confirmerLinkedSheet}`, {
    waitUntil: "domcontentloaded",
  });
  const pendingSection = confirmerIOU.locator("section.card").filter({
    has: confirmerIOU.getByRole("heading", { name: /Pending from chat/i }),
  });
  const pendingCard = pendingSection.locator(":scope > ul > li").filter({
    hasText: note,
  }).first();
  // Let SheetPage's authenticated ActionInbox effect finish. Repeated short reloads cancel that
  // effect and can starve a healthy poll forever; use one uninterrupted wait, then one fallback
  // reload for a genuinely missed mount.
  let pendingVisible = await pendingCard
    .waitFor({ state: "visible", timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!pendingVisible) {
    await confirmerIOU.reload({ waitUntil: "domcontentloaded" });
    pendingVisible = await pendingCard
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
  }
  check(pendingVisible, `this run's nonce-scoped draft appears under Pending from chat`);
  if (!pendingVisible) throw new Error("this run's pending IOU draft did not render");

  await pendingCard.getByRole("button", { name: /Review & add/i }).click({ timeout: 10000 });
  const entryDialog = confirmerIOU.getByRole("dialog");
  await entryDialog.getByRole("heading", { name: "Add entry", exact: true }).waitFor({ timeout: 10000 });
  const formValues = {
    // EntryForm uses wrapping labels without explicit htmlFor/id pairs. Keep these selectors aligned
    // with test/ui/flows.ts: the transaction currency is the first select and the transaction
    // amount is the first number input (later controls belong to optional fee/schedule sections).
    amount: await entryDialog.locator('input[type="number"]').first().inputValue(),
    currency: await entryDialog.locator("select").first().inputValue(),
    note: await entryDialog.locator('input[placeholder="lunch, taxi, etc."]').inputValue(),
    credit: await entryDialog
      .locator("fieldset")
      .filter({ hasText: "Direction" })
      .locator('input[type="radio"]')
      .first()
      .isChecked(),
  };
  const formMatches =
    Number(formValues.amount) === 350 &&
    formValues.currency === "EGP" &&
    formValues.note === note &&
    formValues.credit;
  if (!formMatches) {
    console.error("[form] observed prefill:", JSON.stringify(formValues));
  }
  check(formMatches, "Review & add opens a prefilled EntryForm with this card's exact values");
  if (!formMatches) throw new Error("prefilled EntryForm does not match this run's card");

  entrySubmissionAttempted = true;
  await entryDialog.getByRole("button", { name: "Add entry", exact: true }).click({ timeout: 10000 });
  await entryDialog.waitFor({ state: "hidden", timeout: 30000 });
  const history = confirmerIOU.locator("section.history");
  const createdEntry = history.locator(":scope > ul > li").filter({ hasText: note }).first();
  await createdEntry.waitFor({ state: "visible", timeout: 30000 });
  check(await createdEntry.isVisible(), `the submitted entry is present in .history with nonce ${nonce}`);
  check(!(await pendingCard.isVisible().catch(() => false)), "the consumed Pending from chat card is gone");
  journeyBodyCompleted = true;
  } finally {
    if (dialogListenerInstalled) proposerOC.off("dialog", onDialog);
    if (navigationListenerInstalled) proposerOC.off("framenavigated", onSenderNavigation);

    if (manualExtractTouched) {
      await proposerOC
        .evaluate((previous) => {
          if (previous === null) localStorage.removeItem("oc:manualExtract");
          else localStorage.setItem("oc:manualExtract", previous);
        }, previousManualExtract ?? null)
        .catch((error) => {
          failures++;
          console.error(`[cleanup] could not restore oc:manualExtract: ${(error as Error).message}`);
        });
    }

    // A failed run must not leave its still-pending chat action behind. Re-identify only among cards
    // added after this run's observer was installed, then cancel only the card whose isolated inputs
    // carry this exact nonce.
    if (!deliveryObserved && proposerObserverInstalled) {
      try {
        senderCard ??= await findAndLoadRunCard(proposerOC, note, PROPOSER.user, 5_000);
        if (senderCard) {
          const cancelled = await cancelRunCard(senderCard);
          console.log(
            cancelled
              ? `[cleanup] cancelled only the nonce-scoped pending OpenChat card`
              : `[cleanup] nonce card was no longer cancellable`,
          );
        }
      } catch (error) {
        failures++;
        console.error(`[cleanup] OpenChat card cleanup failed: ${(error as Error).message}`);
      }
    }

    let confirmerCleanup:
      | { sheet: string | null; deletedEntries: number; acknowledged: number }
      | undefined;
    if (confirmationAttempted || deliveryObserved || confirmerLinkedSheet !== null) {
      try {
        confirmerCleanup = await cleanupIouRun(
          confirmerIOU,
          note,
          confirmerLinkedSheet,
          CONFIRMER.user,
          entrySubmissionAttempted,
        );
        console.log(
          `[cleanup] ${CONFIRMER.user}: deleted=${confirmerCleanup.deletedEntries}, acknowledged=${confirmerCleanup.acknowledged}`,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] ${CONFIRMER.user} IOU cleanup failed: ${(error as Error).message}`);
      }
      try {
        const proposerCleanup = await cleanupIouRun(
          proposerIOU,
          note,
          null,
          PROPOSER.user,
          false,
        );
        console.log(
          `[cleanup] ${PROPOSER.user}: deleted=${proposerCleanup.deletedEntries}, acknowledged=${proposerCleanup.acknowledged}`,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] ${PROPOSER.user} IOU cleanup failed: ${(error as Error).message}`);
      }
    }

    if (journeyBodyCompleted) {
      check(
        confirmerCleanup?.deletedEntries === 1,
        `cleanup soft-deleted exactly this run's imported History entry`,
      );
    }
    if (deliveryObserved) {
      let finalBuckets = {
        proposer: await bucketCount(a, fpProposer),
        confirmer: await bucketCount(a, fpConfirmer),
      };
      for (
        let attempt = 0;
        attempt < 8 &&
        (finalBuckets.proposer !== before.proposer || finalBuckets.confirmer !== before.confirmer);
        attempt++
      ) {
        await confirmerIOU.waitForTimeout(1_000);
        finalBuckets = {
          proposer: await bucketCount(a, fpProposer),
          confirmer: await bucketCount(a, fpConfirmer),
        };
      }
      check(
        finalBuckets.proposer === before.proposer && finalBuckets.confirmer === before.confirmer,
        `cleanup returned both action-inbox buckets to their pre-run counts`,
      );
    }

    if (proposerObserverInstalled) await removeNewCardObserver(proposerOC);
    if (confirmerObserverInstalled) await removeNewCardObserver(confirmerOC);
    await proposerOC
      .evaluate((marker) => {
        const root = globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string };
        if (root.__iouJourneyDocumentMarker === marker) delete root.__iouJourneyDocumentMarker;
      }, documentMarker)
      .catch(() => {});
  }

  if (failures > 0) {
    console.error(`\nJOURNEY FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n🏁 JOURNEY PASSED: chat send → card Add to IOU → confirmer delivery → Review & add → IOU History");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
