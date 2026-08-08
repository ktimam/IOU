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
import { OPENCHAT_MESSAGE_TEXT_SELECTOR } from "./openChatArtifactCleanup";

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

function cleanupCheck(cond: boolean, label: string): void {
  try {
    check(cond, label);
  } catch (error) {
    failures++;
    console.error(`[cleanup] assertion reporting failed (${label}): ${(error as Error).message}`);
  }
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

type ManualPromptProbe = { promptCalls: number; prompts: string[] };

async function installManualPromptOverride(page: Page, exactResponse: string): Promise<void> {
  const response = JSON.stringify(exactResponse);
  // Browser-native source avoids tsx/esbuild injecting Node-only helpers into the prompt callback.
  await page.evaluate(`(() => {
    const root = globalThis;
    const previous = root.__iouJourneyPromptProbe;
    if (previous) window.prompt = previous.originalPrompt;
    const state = { originalPrompt: window.prompt, promptCalls: 0, prompts: [] };
    root.__iouJourneyPromptProbe = state;
    window.prompt = (message) => {
      state.promptCalls++;
      state.prompts.push(String(message ?? ""));
      return ${response};
    };
  })()`);
}

async function readManualPromptProbe(page: Page): Promise<ManualPromptProbe> {
  return page.evaluate(`(() => {
    const state = globalThis.__iouJourneyPromptProbe;
    if (!state) throw new Error("manual prompt override is not installed");
    return { promptCalls: state.promptCalls, prompts: [...state.prompts] };
  })()`);
}

async function removeManualPromptOverride(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const root = globalThis;
    const state = root.__iouJourneyPromptProbe;
    if (!state) return;
    window.prompt = state.originalPrompt;
    delete root.__iouJourneyPromptProbe;
  })()`);
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

// ONE CDP connection per port keeps page identity and authenticated state stable across the journey.
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
  message: ChatMessageRef;
};

type CardLoadExpectation = "auto" | "explicit" | "either";

type ChatMessageRef = {
  messageId: string;
  messageIndex: number;
  eventIndex: number;
};

type ExactMessageEvidence =
  | { kind: "source"; exactText: string }
  | { kind: "card"; observerId: string };

const MESSAGE_WRAPPER_SELECTOR = '[data-id][data-index][id^="event-"]';

function exactMessageWrapper(page: Page, message: ChatMessageRef): Locator {
  return page.locator(
    `[data-id="${message.messageId}"][data-index="${message.messageIndex}"][id="event-${message.eventIndex}"]`,
  );
}

async function messageRefFromWrapper(wrapper: Locator, label: string): Promise<ChatMessageRef> {
  const count = await wrapper.count();
  if (count !== 1) throw new Error(`${label}: expected one exact message wrapper, found ${count}`);
  const [messageId, rawMessageIndex, rawEventId] = await Promise.all([
    wrapper.getAttribute("data-id"),
    wrapper.getAttribute("data-index"),
    wrapper.getAttribute("id"),
  ]);
  const eventMatch = /^event-(\d+)$/.exec(rawEventId ?? "");
  if (!/^\d+$/.test(messageId ?? "") || !/^\d+$/.test(rawMessageIndex ?? "") || !eventMatch) {
    throw new Error(`${label}: message wrapper has invalid stable coordinates`);
  }
  return {
    messageId: messageId!,
    messageIndex: Number(rawMessageIndex),
    eventIndex: Number(eventMatch[1]),
  };
}

async function captureMessageIdBaseline(page: Page): Promise<Set<string>> {
  const ids = await page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll((wrappers) => {
    const result: string[] = [];
    for (const wrapper of wrappers) {
      const id = wrapper.getAttribute("data-id");
      if (id !== null && /^\d+$/.test(id)) result.push(id);
    }
    return result;
  });
  return new Set(ids);
}

async function freshSourceCandidates(
  page: Page,
  exactText: string,
  baselineIds: ReadonlySet<string>,
): Promise<Array<ChatMessageRef & { owned: boolean }>> {
  return page.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(
    (nodes, { expected, baseline }) => {
      const normalizedExpected = expected.replace(/\s+/g, " ").trim();
      const matches = new Map<string, ChatMessageRef & { owned: boolean }>();
      for (const node of nodes as HTMLElement[]) {
        if (
          node.classList.contains("markdown-wrapper") &&
          node.closest(".message_text") !== null
        )
          continue;
        if (node.innerText.replace(/\s+/g, " ").trim() !== normalizedExpected) continue;
        const wrapper = node.closest<HTMLElement>('[data-id][data-index][id^="event-"]');
        const messageId = wrapper?.dataset.id ?? "";
        const rawMessageIndex = wrapper?.dataset.index ?? "";
        const eventMatch = /^event-(\d+)$/.exec(wrapper?.id ?? "");
        if (
          baseline.includes(messageId) ||
          !/^\d+$/.test(messageId) ||
          !/^\d+$/.test(rawMessageIndex) ||
          !eventMatch
        )
          continue;
        const classicOwned =
          wrapper!.classList.contains("message") && wrapper!.classList.contains("me");
        const mobileOwned =
          wrapper!.classList.contains("container") &&
          getComputedStyle(wrapper!).justifyContent === "flex-end";
        matches.set(messageId, {
          messageId,
          messageIndex: Number(rawMessageIndex),
          eventIndex: Number(eventMatch[1]),
          owned: classicOwned || mobileOwned,
        });
      }
      return [...matches.values()];
    },
    { expected: exactText, baseline: [...baselineIds] },
  );
}

async function captureFreshSourceMessage(
  page: Page,
  exactText: string,
  baselineIds: ReadonlySet<string>,
  who: string,
  timeoutMs = 15_000,
): Promise<ChatMessageRef> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await freshSourceCandidates(page, exactText, baselineIds);
    if (matches.length > 1) {
      throw new Error(`[${who}] multiple fresh messages exactly matched this run; refusing ambiguity`);
    }
    if (matches.length === 1) {
      if (!matches[0].owned) {
        throw new Error(`[${who}] fresh Journey message is not rendered as the current user's message`);
      }
      const message: ChatMessageRef = {
        messageId: matches[0].messageId,
        messageIndex: matches[0].messageIndex,
        eventIndex: matches[0].eventIndex,
      };
      if ((await exactMessageWrapper(page, message).count()) !== 1) {
        throw new Error(`[${who}] fresh Journey message coordinates are not unique`);
      }
      return message;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`[${who}] fresh Journey message never acquired stable message coordinates`);
}

async function captureCardMessage(card: Locator, observerId: string, who: string): Promise<ChatMessageRef> {
  const wrapper = card.locator(
    'xpath=ancestor::*[@data-id and @data-index and starts-with(@id,"event-")][1]',
  );
  const message = await messageRefFromWrapper(wrapper, `[${who}] nonce-scoped card`);
  const exactCard = exactMessageWrapper(card.page(), message).locator(
    `.action-card[data-iou-journey-card-id="${observerId}"]`,
  );
  if ((await exactCard.count()) !== 1) {
    throw new Error(`[${who}] nonce-scoped card is not uniquely contained by its captured message`);
  }
  return message;
}

type InboxRunLookup = {
  found: boolean;
  linkedSheet: string | null;
  matched: number;
  acknowledged: number;
};

function messageRefKey(message: ChatMessageRef): string {
  return `${message.messageId}/${message.messageIndex}/${message.eventIndex}`;
}

function rememberRunCards(
  tracked: Map<string, LoadedRunCard>,
  cards: readonly LoadedRunCard[],
  who: string,
): void {
  for (const card of cards) {
    const key = messageRefKey(card.message);
    const existing = tracked.get(key);
    if (existing && existing.observerId !== card.observerId) {
      throw new Error(
        `[${who}] two observed cards occupy the same stable message coordinates; refusing ambiguity`,
      );
    }
    tracked.set(key, card);
  }
}

function uniqueTrackedRunCard(
  tracked: ReadonlyMap<string, LoadedRunCard>,
  who: string,
): LoadedRunCard | null {
  if (tracked.size > 1) {
    throw new Error(`[${who}] ${tracked.size} nonce-exact run cards were found; refusing confirmation`);
  }
  return tracked.values().next().value ?? null;
}

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

async function observedRunCardCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __iouJourneyCardObserver?: { records: Record<string, string[]> };
    };
    return Object.keys(root.__iouJourneyCardObserver?.records ?? {}).length;
  });
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

async function findAndLoadRunCards(
  page: Page,
  note: string,
  who: string,
  cleanGateIds: Set<string>,
  timeoutMs = 35_000,
  failOnProposalToast = false,
  loadExpectation: CardLoadExpectation = "either",
): Promise<LoadedRunCard[]> {
  const found = new Map<string, LoadedRunCard>();
  let firstFoundAt: number | null = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
          if (loadExpectation === "auto") continue;
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
        const message = await captureCardMessage(card, observerId, who);
        const loaded: LoadedRunCard = {
          card,
          frame,
          observerId,
          loadedFromCleanGate: cleanGateIds.has(observerId),
          message,
        };
        const key = messageRefKey(message);
        const existing = found.get(key);
        if (existing && existing.observerId !== observerId) {
          throw new Error(
            `[${who}] two nonce-exact cards occupy the same stable message coordinates`,
          );
        }
        found.set(key, loaded);
        firstFoundAt ??= Date.now();
      }
    }
    // Continue briefly after the first match so a duplicate created by a raced retry is inventoried
    // and cleaned instead of being hidden by an early return.
    if (firstFoundAt !== null && Date.now() - firstFoundAt >= 800) return [...found.values()];
    if (failOnProposalToast && found.size === 0) {
      const failure = await proposalFailureText(page);
      if (failure) throw new Error(`proposal UI failure: ${failure}`);
    }
    await page.waitForTimeout(400);
  }
  return [...found.values()];
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

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const matches: Locator[] = [];
  const count = await locator.count();
  for (let index = 0; index < count; index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
  }
  return matches;
}

async function exactlyOneVisible(locator: Locator, label: string, timeoutMs = 5_000): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await visibleMatches(locator);
    if (matches.length > 1) {
      throw new Error(`${label}: expected one visible match, found ${matches.length}`);
    }
    if (matches.length === 1) return matches[0];
    await locator.page().waitForTimeout(100);
  }
  throw new Error(`${label}: no visible match appeared`);
}

async function dismissOpenChatOverlay(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = await page.evaluate(() => {
      const overlay = document.querySelector("#masked_overlay");
      return overlay instanceof HTMLElement && overlay.classList.contains("visible");
    });
    if (!open) return;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(300);
  }
  const stillOpen = await page.locator("#masked_overlay.visible").isVisible().catch(() => false);
  if (stillOpen) throw new Error("an existing OpenChat overlay could not be dismissed safely");
}

async function exactMessageEvidencePresent(
  page: Page,
  message: ChatMessageRef,
  evidence: ExactMessageEvidence,
): Promise<boolean> {
  const wrapper = exactMessageWrapper(page, message);
  const wrapperCount = await wrapper.count();
  if (wrapperCount > 1) throw new Error(`message ${message.messageId}: stable coordinates are ambiguous`);
  if (wrapperCount === 0) return false;
  if (evidence.kind === "source") {
    const expected = evidence.exactText.replace(/\s+/g, " ").trim();
    const matches = await wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(
      (nodes, exact) => {
        let count = 0;
        for (const node of nodes as HTMLElement[]) {
          if (
            node.classList.contains("markdown-wrapper") &&
            node.closest(".message_text") !== null
          )
            continue;
          if (node.innerText.replace(/\s+/g, " ").trim() === exact) count++;
        }
        return count;
      },
      expected,
    );
    if (matches > 1) throw new Error(`message ${message.messageId}: source evidence is ambiguous`);
    return matches === 1;
  }

  const cards = wrapper.locator(".action-card");
  const cardCount = await cards.count();
  if (cardCount > 1) throw new Error(`message ${message.messageId}: card evidence is ambiguous`);
  if (cardCount === 0) return false;
  const card = cards.first();
  const currentObserverId = await card.getAttribute("data-iou-journey-card-id");
  if (currentObserverId !== null && currentObserverId !== evidence.observerId) {
    throw new Error(`message ${message.messageId}: observed card identity changed`);
  }
  const identity = await card.evaluate((node) => ({
    title: node.querySelector(".title")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    text: node.textContent?.replace(/\s+/g, " ").trim() ?? "",
  }));
  if (identity.title !== "Add to IOU" || !/Directory entry:\s*iou/i.test(identity.text)) {
    throw new Error(`message ${message.messageId}: IOU card identity no longer matches`);
  }
  return true;
}

async function waitForExactEvidenceAbsent(
  page: Page,
  message: ChatMessageRef,
  evidence: ExactMessageEvidence,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await exactMessageEvidencePresent(page, message, evidence))) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`message ${message.messageId}: original evidence remained after deletion`);
}

async function openOwnedMobileMessageMenu(page: Page, message: ChatMessageRef): Promise<Locator> {
  const wrapper = exactMessageWrapper(page, message);
  if ((await wrapper.count()) !== 1) {
    throw new Error(`message ${message.messageId}: exact mobile wrapper is unavailable`);
  }
  const ownedByAlignment = await wrapper.evaluate(
    (node) => node.classList.contains("container") && getComputedStyle(node).justifyContent === "flex-end",
  );
  if (!ownedByAlignment) throw new Error(`message ${message.messageId}: mobile message is not sender-owned`);
  const trigger = wrapper.locator(".message_bubble_wrapper > .menu-trigger");
  if ((await trigger.count()) !== 1) {
    throw new Error(`message ${message.messageId}: exact mobile menu trigger is ambiguous`);
  }
  await trigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);

  for (let attempt = 0; attempt < 3; attempt++) {
    await dismissOpenChatOverlay(page);
    await trigger.dispatchEvent("click").catch(() => {});
    await page.waitForTimeout(500);
    let menus = await visibleMatches(page.locator(".message_bubble_menu.second"));
    if (menus.length === 0) {
      const box = await trigger.boundingBox();
      if (!box) throw new Error(`message ${message.messageId}: mobile trigger has no bounds`);
      const session = await page.context().newCDPSession(page);
      try {
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await page.waitForTimeout(750);
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } finally {
        await session.detach().catch(() => {});
      }
      await page.waitForTimeout(500);
      menus = await visibleMatches(page.locator(".message_bubble_menu.second"));
    }
    if (menus.length > 1) {
      throw new Error(`message ${message.messageId}: multiple mobile message menus opened`);
    }
    if (menus.length === 1) {
      if (!(await menus[0].evaluate((node) => node.classList.contains("me")))) {
        throw new Error(`message ${message.messageId}: opened mobile menu is not sender-owned`);
      }
      return menus[0];
    }
    await page.waitForTimeout(1_200);
  }
  throw new Error(`message ${message.messageId}: exact mobile message menu did not open`);
}

async function deleteExactMessageViaUi(
  page: Page,
  message: ChatMessageRef,
  evidence: ExactMessageEvidence,
): Promise<void> {
  if (!(await exactMessageEvidencePresent(page, message, evidence))) {
    throw new Error(`message ${message.messageId}: exact deletion evidence is unavailable`);
  }
  await dismissOpenChatOverlay(page);
  const wrapper = exactMessageWrapper(page, message);
  const classic = await wrapper.evaluate((node) => node.classList.contains("message"));
  if (classic) {
    if (!(await wrapper.evaluate((node) => node.classList.contains("me")))) {
      throw new Error(`message ${message.messageId}: classic message is not sender-owned`);
    }
    const bubble = wrapper.locator(".bubble-wrapper");
    if ((await bubble.count()) !== 1) {
      throw new Error(`message ${message.messageId}: exact classic bubble is ambiguous`);
    }
    await bubble.hover();
    const menuIcon = await exactlyOneVisible(bubble.locator(".menu-icon"), "classic message menu");
    await menuIcon.click({ timeout: 10_000 });
  } else {
    const menu = await openOwnedMobileMessageMenu(page, message);
    const more = await exactlyOneVisible(menu.locator(".menu-btn button"), "mobile more-options button");
    await more.click({ timeout: 10_000 });
  }

  const deleteForMe = await visibleMatches(
    page.getByRole("menuitem", { name: "Delete for me", exact: true }),
  );
  if (deleteForMe.length !== 0) {
    throw new Error(`message ${message.messageId}: UI offered Delete for me instead of sender deletion`);
  }
  const deleteItem = await exactlyOneVisible(
    page.getByRole("menuitem", { name: "Delete", exact: true }),
    "sender Delete menu item",
  );
  await deleteItem.click({ timeout: 10_000 });

  const confirmation = page.getByRole("button", { name: "Yes please", exact: true });
  const confirmationDeadline = Date.now() + 2_000;
  while (Date.now() < confirmationDeadline) {
    const confirmations = await visibleMatches(confirmation);
    if (confirmations.length > 1) {
      throw new Error(`message ${message.messageId}: multiple delete confirmations are visible`);
    }
    if (confirmations.length === 1) {
      await confirmations[0].click({ timeout: 10_000 });
      break;
    }
    if (!(await exactMessageEvidencePresent(page, message, evidence))) return;
    await page.waitForTimeout(100);
  }
  await waitForExactEvidenceAbsent(page, message, evidence);
}

async function verifyDeletedAfterReload(
  page: Page,
  deleted: ReadonlyArray<{ message: ChatMessageRef; evidence: ExactMessageEvidence }>,
): Promise<void> {
  if (deleted.length === 0) return;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".ProseMirror").first().waitFor({ state: "visible", timeout: 20_000 });
  for (const item of deleted) {
    if (await exactMessageEvidencePresent(page, item.message, item.evidence)) {
      throw new Error(`message ${item.message.messageId}: deletion did not survive reload`);
    }
  }
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
      // A nonce should identify one envelope. Never mutate an ambiguous set: cleanup must leave
      // duplicates intact for diagnosis rather than sweeping every partial match.
      if (shouldAcknowledge && matches.length === 1) {
        const match = matches[0];
        const result = await inbox.acknowledgeActionInbox({
          config,
          identity,
          throughId: match.id,
          acknowledgementSecret: match.acknowledgementSecret,
        });
        acknowledged += result.acknowledged;
      }
      return {
        found: matches.length === 1,
        linkedSheet: matches.length === 1 && linkedSheets.size === 1 ? [...linkedSheets][0] : null,
        matched: matches.length,
        acknowledged,
      };
    })(${input})`)) as InboxRunLookup;
}

async function exactHistoryRows(page: Page, exactNote: string): Promise<Locator[]> {
  const rows = page.locator("section.history > ul > li");
  const matches: Locator[] = [];
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const noteField = row.locator(".row-1 > strong");
    if ((await noteField.count()) !== 1) continue;
    const renderedNote = (await noteField.innerText()).replace(/\s+/g, " ").trim();
    if (renderedNote === exactNote.replace(/\s+/g, " ").trim()) matches.push(row);
  }
  return matches;
}

async function exactPendingRows(page: Page, exactSummary: string): Promise<Locator[]> {
  const section = page.locator("section.card").filter({
    has: page.getByRole("heading", { name: /Pending from chat/i }),
  });
  const rows = section.locator(":scope > ul > li");
  const matches: Locator[] = [];
  const normalizedExpected = exactSummary.replace(/\s+/g, " ").trim();
  const count = await rows.count();
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const summary = row.locator(":scope > span.small");
    if ((await summary.count()) !== 1) continue;
    // The OpenChat provenance cue is a nested span. Compare only the direct summary text node, which
    // is generated from the parsed draft, against the full expected summary.
    const renderedSummary = await summary.evaluate((node) =>
      [...node.childNodes]
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => child.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (renderedSummary === normalizedExpected) matches.push(row);
  }
  return matches;
}

async function waitForUniqueExactRow(
  page: Page,
  findRows: () => Promise<Locator[]>,
  label: string,
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await findRows();
    if (rows.length > 1) throw new Error(`${label}: found ${rows.length} exact matches; refusing ambiguity`);
    if (rows.length === 1) return rows[0];
    await page.waitForTimeout(250);
  }
  return null;
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
  const lookupAttempts = knownSheet === null ? 10 : 1;
  for (let attempt = 0; attempt < lookupAttempts && lookup.matched === 0; attempt++) {
    lookup = await lookupInboxRun(page, note, false);
    if (lookup.matched === 0 && attempt + 1 < lookupAttempts) await page.waitForTimeout(1_500);
  }
  if (lookup.matched > 1) {
    throw new Error(
      `[${who}] ${lookup.matched} inbox envelopes exactly match this nonce; refusing cleanup mutation`,
    );
  }
  const sheet = knownSheet ?? lookup.linkedSheet;
  let exactEntries: Locator[] = [];
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

    if (waitForImportedEntry) {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        exactEntries = await exactHistoryRows(page, note);
        if (exactEntries.length !== 0) break;
        await page.waitForTimeout(250);
      }
    } else {
      exactEntries = await exactHistoryRows(page, note);
    }
    if (exactEntries.length > 1) {
      throw new Error(
        `[${who}] ${exactEntries.length} History rows have this exact nonce; refusing cleanup mutation`,
      );
    }
  }

  // The per-delivery acknowledgement secret authorizes removal of only this exact signed inbox
  // envelope. Do this for both users so fan-out QC does not grow either persistent bucket.
  const acknowledged = await lookupInboxRun(page, note, true);
  if (acknowledged.matched > 1) {
    throw new Error(
      `[${who}] ${acknowledged.matched} inbox envelopes exactly match this nonce; none were acknowledged`,
    );
  }

  let deletedEntries = 0;
  if (exactEntries.length === 1) {
    const row = exactEntries[0];
    const remove = row.getByRole("button", { name: "delete", exact: true });
    if (!(await remove.isVisible().catch(() => false))) {
      throw new Error(`[${who}] exact nonce entry is visible but has no delete action`);
    }
    await remove.click({ timeout: 8_000 });
    await row.waitFor({ state: "hidden", timeout: 15_000 });
    deletedEntries = 1;
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

  let proposerOC = await attach(PROPOSER.ocPort, "localhost:5003");
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
  let proposerQcPage: Page | null = null;
  let proposerObserverInstalled = false;
  let confirmerObserverInstalled = false;
  let promptOverrideInstalled = false;
  let navigationListenerInstalled = false;
  let senderMainFrameNavigations = 0;
  let sourceBaselineIds: Set<string> | null = null;
  let sourceSendSucceeded = false;
  let sourceMessage: ChatMessageRef | null = null;
  let senderCard: LoadedRunCard | null = null;
  let confirmerCard: LoadedRunCard | null = null;
  const senderRunCards = new Map<string, LoadedRunCard>();
  const confirmerRunCards = new Map<string, LoadedRunCard>();
  const senderCleanGateIds = new Set<string>();
  const confirmerCleanGateIds = new Set<string>();
  let confirmerLinkedSheet: string | null = null;
  let confirmationAttempted = false;
  let entrySubmissionAttempted = false;
  let deliveryObserved = false;
  let journeyBodyCompleted = false;
  const documentMarker = `iou-card-journey-${nonce}`;
  const onSenderNavigation = (frame: Frame) => {
    if (frame === proposerOC.mainFrame()) senderMainFrameNavigations++;
  };

  try {

  // 4. The proposer sends a message + proposes via the DETERMINISTIC manual-JSON prompt.
  // Issue 1 test seam: with no on-device model, REAL users are now guided to set one up instead of a
  // raw JSON prompt. The automated journey opts in only on a temporary tab whose URL carries the
  // one-shot QC query. The user's normal OpenChat tab and persistent storage are never modified.
  const regularProposerPage = proposerOC;
  const qcUrl = new URL(regularProposerPage.url());
  qcUrl.searchParams.set("manualExtract", "1");
  proposerQcPage = await regularProposerPage.context().newPage();
  await proposerQcPage.goto(qcUrl.toString(), { waitUntil: "domcontentloaded" });
  await proposerQcPage.waitForTimeout(2_500);
  proposerOC = proposerQcPage;
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
  // Only the disposable manualExtract tab replaces the browser primitive. The product's ordinary
  // runProposeFlow still calls parseManualExtractionPrompt; this override merely returns its exact
  // deterministic JSON synchronously so Playwright cannot race and auto-dismiss the native prompt.
  await installManualPromptOverride(proposerOC, extraction);
  promptOverrideInstalled = true;
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
  sourceBaselineIds = await captureMessageIdBaseline(proposerOC);
  const composer = proposerOC.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await proposerOC.keyboard.type(text);
  await proposerOC.keyboard.press("Enter");
  sourceSendSucceeded = true;
  console.log(`[${PROPOSER.user}] sent: ${text}`);
  sourceMessage = await captureFreshSourceMessage(
    proposerOC,
    text,
    sourceBaselineIds,
    PROPOSER.user,
  );
  check(
    true,
    `${PROPOSER.user} fresh Journey source is sender-owned and captured as message ${sourceMessage.messageId}/${sourceMessage.messageIndex}/${sourceMessage.eventIndex}`,
  );

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
  let proposalCardObserved = false;
  for (let attempt = 1; attempt <= 3 && !posted; attempt++) {
    // Each attempt is fully fenced: any step timing out must fall through to the NEXT attempt, not
    // abort the run (a thrown click timeout previously killed the whole journey on a flaky menu).
    try {
      proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
      if (!proposalCardObserved) {
      await proposerOC.locator(".toast .close").last().click({ timeout: 1_000 }).catch(() => {});
      if (isV2) {
        const ownedMenu = await openOwnedMobileMessageMenu(proposerOC, sourceMessage!);
        const autoFix = await exactlyOneVisible(
          ownedMenu.locator('button:has(path[d^="M7.5,5.6"])'),
          "sender-owned Propose action",
        );
        // openOwnedMobileMessageMenu already opened the exact sender-owned message's v2 sheet using
        // its stable wrapper and the device-appropriate gesture; do not run a second gesture path.
        proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
        if (proposalCardObserved) {
          throw new Error("a card appeared while opening the v2 action sheet; refusing another Propose click");
        }
        await autoFix.click({ timeout: 8000 });
      } else {
        const wrapper = exactMessageWrapper(proposerOC, sourceMessage!);
        if (!(await wrapper.evaluate((node) => node.classList.contains("me")))) {
          throw new Error("classic Journey source is not sender-owned");
        }
        const bubble = wrapper.locator(".bubble-wrapper");
        if ((await bubble.count()) !== 1) throw new Error("classic Journey source bubble is ambiguous");
        await bubble.hover();
        await proposerOC.waitForTimeout(500);
        const menuIcon = await exactlyOneVisible(bubble.locator(".menu-icon"), "classic source menu");
        await menuIcon.click({ timeout: 12000 });
        const propose = await exactlyOneVisible(
          proposerOC.getByText("Propose action", { exact: true }),
          "classic sender-owned Propose action",
        );
        proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
        if (proposalCardObserved) {
          throw new Error("a card appeared while opening the classic menu; refusing another Propose click");
        }
        await propose.click({ timeout: 12000 });
      }
      console.log(`[${PROPOSER.user}] proposed (attempt ${attempt}, manual JSON — no model)`);
      }
      if (proposalCardObserved) {
        console.log(
          `[${PROPOSER.user}] an observed card already exists; attempt ${attempt} only waits and never clicks Propose again`,
        );
      }
      const foundSenderCards = await findAndLoadRunCards(
        proposerOC,
        note,
        PROPOSER.user,
        senderCleanGateIds,
        18_000,
        true,
        "auto",
      );
      rememberRunCards(senderRunCards, foundSenderCards, PROPOSER.user);
      proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0;
      senderCard = uniqueTrackedRunCard(senderRunCards, PROPOSER.user);
      if (senderCard) {
        // A sender-side card proves the post succeeded. Do not post a duplicate merely because the
        // other browser is still catching up; wait for its authoritative hydration instead.
        const foundConfirmerCards = await findAndLoadRunCards(
          confirmerOC,
          note,
          CONFIRMER.user,
          confirmerCleanGateIds,
          35_000,
          false,
          "explicit",
        );
        rememberRunCards(confirmerRunCards, foundConfirmerCards, CONFIRMER.user);
        confirmerCard = uniqueTrackedRunCard(confirmerRunCards, CONFIRMER.user);
      }
      posted = senderCard !== null && confirmerCard !== null;
      if (!posted) {
        const failure = await proposalFailureText(proposerOC);
        if (failure) console.log(`[${PROPOSER.user}] proposal failure: ${failure}`);
      }
    } catch (e) {
      console.log(`[${PROPOSER.user}] propose attempt ${attempt} failed: ${(e as Error).message.slice(0, 90)}`);
      proposalCardObserved ||= (await observedRunCardCount(proposerOC).catch(() => 0)) > 0;
    }
    if (!posted) {
      // Clear any leftover sheet/overlay before retrying.
      await proposerOC.keyboard.press("Escape").catch(() => {});
      await proposerOC.locator("#masked_overlay").click({ position: { x: 10, y: 10 }, timeout: 2000 }).catch(() => {});
      await proposerOC.waitForTimeout(1000);
    }
  }
  senderCard = uniqueTrackedRunCard(senderRunCards, PROPOSER.user);
  confirmerCard = uniqueTrackedRunCard(confirmerRunCards, CONFIRMER.user);
  posted = senderCard !== null && confirmerCard !== null;
  const promptProbe = await readManualPromptProbe(proposerOC);
  const promptMessage = promptProbe.prompts[0] ?? "";
  console.log(
    `[${PROPOSER.user}] manual extraction prompt calls=${promptProbe.promptCalls}, message=${JSON.stringify(promptMessage.slice(0, 160))}`,
  );
  const exactlyOnePrompt = promptProbe.promptCalls === 1 && promptProbe.prompts.length === 1;
  const isExtractionPrompt = exactlyOnePrompt && /JSON/i.test(promptMessage);
  check(exactlyOnePrompt, `runProposeFlow opened exactly one manual extraction prompt`);
  check(isExtractionPrompt, `parseManualExtractionPrompt received the expected JSON prompt`);
  if (!exactlyOnePrompt || !isExtractionPrompt) {
    throw new Error("manual extraction prompt count/message did not match this run");
  }
  check(posted, `the nonce-scoped action card auto-loaded for its proposer and loaded for its recipient`);
  if (!posted) throw new Error("card never posted");

  const sameCardMessage =
    senderCard!.message.messageId === confirmerCard!.message.messageId &&
    senderCard!.message.messageIndex === confirmerCard!.message.messageIndex &&
    senderCard!.message.eventIndex === confirmerCard!.message.eventIndex;
  const cardFollowsSource =
    sourceMessage !== null && senderCard!.message.messageIndex > sourceMessage.messageIndex;
  check(sameCardMessage, "sender and confirmer resolved the nonce-scoped card to the same stable message");
  check(cardFollowsSource, "the captured card message follows this run's captured Journey source");
  if (!sameCardMessage || !cardFollowsSource) {
    throw new Error("nonce-scoped card message coordinates did not cross-check; refusing confirmation");
  }

  check(
    !senderCard!.loadedFromCleanGate,
    "sender's freshly proposed attested card loaded without a second Load app card click",
  );
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
  const pendingSummary = `IOU 350.00 EGP \u00b7 owed to you \u00b7 ${note}`;
  // Let SheetPage's authenticated ActionInbox effect finish. Repeated short reloads cancel that
  // effect and can starve a healthy poll forever; use one uninterrupted wait, then one fallback
  // reload for a genuinely missed mount.
  let pendingCard = await waitForUniqueExactRow(
    confirmerIOU,
    () => exactPendingRows(confirmerIOU, pendingSummary),
    "pending IOU draft",
    30_000,
  );
  if (pendingCard === null) {
    await confirmerIOU.reload({ waitUntil: "domcontentloaded" });
    pendingCard = await waitForUniqueExactRow(
      confirmerIOU,
      () => exactPendingRows(confirmerIOU, pendingSummary),
      "pending IOU draft after reload",
      30_000,
    );
  }
  check(pendingCard !== null, `this run's exact draft summary appears under Pending from chat`);
  if (pendingCard === null) throw new Error("this run's pending IOU draft did not render");

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
  const createdEntry = await waitForUniqueExactRow(
    confirmerIOU,
    () => exactHistoryRows(confirmerIOU, note),
    "created History entry",
    30_000,
  );
  if (createdEntry === null) throw new Error("the exact submitted History entry did not render");
  check(await createdEntry.isVisible(), `the submitted entry is present in .history with nonce ${nonce}`);
  check(!(await pendingCard.isVisible().catch(() => false)), "the consumed Pending from chat card is gone");
  journeyBodyCompleted = true;
  } finally {
    try {
    try {
      if (navigationListenerInstalled) proposerOC.off("framenavigated", onSenderNavigation);
    } catch (error) {
      failures++;
      console.error(`[cleanup] navigation-listener teardown failed: ${(error as Error).message}`);
    }

    // Enter may have succeeded even if the immediate coordinate capture then failed. Recover only a
    // unique sender-owned exact-text message that was absent from the pre-send baseline; ambiguity is
    // reported and left untouched.
    if (sourceSendSucceeded && sourceMessage === null && sourceBaselineIds !== null) {
      try {
        sourceMessage = await captureFreshSourceMessage(
          proposerOC,
          text,
          sourceBaselineIds,
          PROPOSER.user,
          3_000,
        );
        console.log(`[cleanup] recovered exact Journey source message ${sourceMessage.messageId}`);
      } catch (error) {
        failures++;
        console.error(`[cleanup] exact Journey source recovery failed: ${(error as Error).message}`);
      }
    }

    // A failed run must not leave its still-pending chat action behind. Re-identify only among cards
    // added after this run's observer was installed, then cancel only the card whose isolated inputs
    // carry this exact nonce.
    if (proposerObserverInstalled) {
      try {
        rememberRunCards(
          senderRunCards,
          await findAndLoadRunCards(
            proposerOC,
            note,
            PROPOSER.user,
            senderCleanGateIds,
            5_000,
          ),
          PROPOSER.user,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] OpenChat sender-card inventory failed: ${(error as Error).message}`);
      }
    }
    if (confirmerObserverInstalled) {
      try {
        rememberRunCards(
          confirmerRunCards,
          await findAndLoadRunCards(
            confirmerOC,
            note,
            CONFIRMER.user,
            confirmerCleanGateIds,
            5_000,
          ),
          CONFIRMER.user,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] OpenChat recipient-card inventory failed: ${(error as Error).message}`);
      }
    }
    if (!deliveryObserved) {
      for (const trackedCard of [...senderRunCards.values()].sort(
        (left, right) => right.message.messageIndex - left.message.messageIndex,
      )) {
        try {
          const cancelled = await cancelRunCard(trackedCard);
          console.log(
            cancelled
              ? `[cleanup] cancelled nonce-scoped pending OpenChat card ${trackedCard.message.messageId}`
              : `[cleanup] nonce card ${trackedCard.message.messageId} was no longer cancellable`,
          );
        } catch (error) {
          failures++;
          console.error(
            `[cleanup] OpenChat card ${trackedCard.message.messageId} cancellation failed: ${(error as Error).message}`,
          );
        }
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
      cleanupCheck(
        confirmerCleanup?.deletedEntries === 1,
        `cleanup soft-deleted exactly this run's imported History entry`,
      );
    }
    if (deliveryObserved) {
      try {
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
      cleanupCheck(
        finalBuckets.proposer === before.proposer && finalBuckets.confirmer === before.confirmer,
        `cleanup returned both action-inbox buckets to their pre-run counts`,
      );
      } catch (error) {
        failures++;
        console.error(`[cleanup] action-inbox bucket verification failed: ${(error as Error).message}`);
      }
    }

    // Remove every uniquely nonce-proven card message before the exact full-text source. Normal
    // OpenChat sender UI is used so backend authorization remains identical to a real user deletion.
    const proposerDeleted: Array<{
      message: ChatMessageRef;
      evidence: ExactMessageEvidence;
    }> = [];
    const deletedCardKeys = new Set<string>();
    for (const trackedCard of [...senderRunCards.values()].sort(
      (left, right) => right.message.messageIndex - left.message.messageIndex,
    )) {
      const evidence: ExactMessageEvidence = {
        kind: "card",
        observerId: trackedCard.observerId,
      };
      try {
        await deleteExactMessageViaUi(proposerOC, trackedCard.message, evidence);
        proposerDeleted.push({ message: trackedCard.message, evidence });
        deletedCardKeys.add(messageRefKey(trackedCard.message));
        cleanupCheck(true, `cleanup deleted exact OpenChat card message ${trackedCard.message.messageId}`);
      } catch (error) {
        failures++;
        console.error(
          `[cleanup] exact OpenChat card ${trackedCard.message.messageId}/${trackedCard.message.messageIndex}/${trackedCard.message.eventIndex} was not deleted: ${(error as Error).message}`,
        );
      }
    }
    if (sourceMessage !== null) {
      const evidence: ExactMessageEvidence = { kind: "source", exactText: text };
      try {
        await deleteExactMessageViaUi(proposerOC, sourceMessage, evidence);
        proposerDeleted.push({ message: sourceMessage, evidence });
        cleanupCheck(true, `cleanup deleted exact Journey source message ${sourceMessage.messageId}`);
      } catch (error) {
        failures++;
        console.error(
          `[cleanup] exact Journey source ${sourceMessage.messageId}/${sourceMessage.messageIndex}/${sourceMessage.eventIndex} was not deleted: ${(error as Error).message}`,
        );
      }
    }

    if (proposerDeleted.length > 0) {
      try {
        await verifyDeletedAfterReload(proposerOC, proposerDeleted);
        cleanupCheck(true, "exact OpenChat message deletions survived proposer reload");
      } catch (error) {
        failures++;
        console.error(`[cleanup] proposer reload verification failed: ${(error as Error).message}`);
      }
    }
    const confirmerDeleted = [...confirmerRunCards.entries()]
      .filter(([key]) => deletedCardKeys.has(key))
      .map(([, card]) => ({
        message: card.message,
        evidence: { kind: "card", observerId: card.observerId } as ExactMessageEvidence,
      }));
    if (confirmerDeleted.length > 0) {
      try {
        await verifyDeletedAfterReload(confirmerOC, confirmerDeleted);
        cleanupCheck(true, "exact card deletion propagated to the confirmer and survived reload");
      } catch (error) {
        failures++;
        console.error(`[cleanup] confirmer reload verification failed: ${(error as Error).message}`);
      }
    }

    } finally {
      // This teardown is deliberately nested: no cleanup/query/delete failure may retain listeners,
      // MutationObservers, the document marker, or the temporary manual-extraction tab.
      try {
        if (navigationListenerInstalled) proposerOC.off("framenavigated", onSenderNavigation);
      } catch (error) {
        console.error(`[teardown] navigation listener detach failed: ${(error as Error).message}`);
      }
      if (promptOverrideInstalled) {
        await removeManualPromptOverride(proposerOC).catch((error) =>
          console.error(`[teardown] manual prompt restore failed: ${(error as Error).message}`),
        );
      }
      if (proposerObserverInstalled) await removeNewCardObserver(proposerOC).catch(() => {});
      if (confirmerObserverInstalled) await removeNewCardObserver(confirmerOC).catch(() => {});
      await proposerOC
        .evaluate((marker) => {
          const root = globalThis as typeof globalThis & { __iouJourneyDocumentMarker?: string };
          if (root.__iouJourneyDocumentMarker === marker) delete root.__iouJourneyDocumentMarker;
        }, documentMarker)
        .catch(() => {});
      await proposerQcPage?.close().catch(() => {});
    }
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
