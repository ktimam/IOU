// AUTOMATED live verification of the MULTI-ENTRY confirmable-action flow (Issue 2):
//
//   one message → the model (here the deterministic manual seam) emits a JSON ARRAY of 2 entries →
//   ONE card → ONE confirm → ONE deposit / ONE messageId per member → on the IOU side ONE
//   "Pending from chat" card shows "2 entries" → "Review & add" opens the BatchConfirmModal →
//   "Add all 2 entries" writes BOTH entries (each tagged with the SAME import_message_id) → the card
//   disappears (messageId consumed) and re-importing is a no-op.
//
// Modeled on journey-fanout.ts (same env/attach/propose/confirm scaffolding). The run uses the
// verified envelope's opaque chat handle and authenticated canister-backed route; it never guesses
// from raw OpenChat ids or legacy localStorage. Requires replica :8080, OC :5003, IOU :3000, CDP
// 9241/9222/9231. Prereq: the manager↔father DM exists, both members are paired to IOU, and the
// chat is linked to a sheet (journey-fanout.ts establishes pairing; link the chat once via the IOU
// "Pending from chat" first-import "remember" checkbox or /openchat/link-chat). Both nonce-scoped
// entries are soft-deleted after the History assertions so they do not affect later balances.
//
//   pnpm exec tsx scripts/live/verify-multi-entry.ts
import {
  chromium,
  type Dialog,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { Actor, HttpAgent } from "@dfinity/agent";
import { webcrypto } from "node:crypto";
import {
  ActionInboxArtifactScope,
  finalizeActionInboxArtifactCleanup,
} from "./actionInboxArtifactCleanup";
import {
  finalizeOpenChatArtifactCleanup,
  OpenChatArtifactScope,
} from "./openChatArtifactCleanup";
import {
  armManualExtractForCurrentUrl,
  TemporaryTabScope,
} from "./temporaryBrowserTab";

const HOST = "http://127.0.0.1:8080";
const IOU_BASE = "http://127.0.0.1:3000";

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

const inboxIdl = ({ IDL: idl }: any) => {
  const Args = idl.Record({ max_results: idl.Nat32, consumer_key_fingerprint: idl.Vec(idl.Nat8), since_id: idl.Nat64 });
  const StoredAction = idl.Record({
    id: idl.Nat64,
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    action_id: idl.Text,
    consumer_key_fingerprint: idl.Vec(idl.Nat8),
    idempotency_key: idl.Vec(idl.Nat8),
    payload_hash: idl.Vec(idl.Nat8),
    card_context_hash: idl.Vec(idl.Nat8),
    acknowledgement_secret_hash: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    ephemeral_public_key: idl.Vec(idl.Nat8),
    signature_version: idl.Nat16,
    signing_key_id: idl.Vec(idl.Nat8),
    created_at: idl.Nat64,
    oc_signature: idl.Vec(idl.Nat8),
  });
  const Success = idl.Record({ actions: idl.Vec(StoredAction) });
  const Error = idl.Record({ 0: idl.Nat16, 1: idl.Opt(idl.Text) });
  return idl.Service({
    // Replicated update, matching actionInboxIdlFactory in the production client.
    actions: idl.Func([Args], [idl.Variant({ Success, Error })], []),
  });
};

type AuthenticatedInboxBucket = {
  canisterId: string;
  consumerKeySelector: Uint8Array;
};

async function authenticatedInboxBucket(page: Page): Promise<AuthenticatedInboxBucket> {
  await page.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" });
  // Browser-native source avoids tsx/esbuild's module-scoped `__name` helper leaking into the
  // serialized evaluate callback when it contains nested dynamic-import helpers.
  const config = (await page.evaluate(`(async () => {
    const inbox = await import("/src/features/openchat/actionInboxClient.ts");
    const auth = await import("/src/features/auth/AuthProvider.tsx");
    const declarations = await import("/src/backend/declarations.ts");
    const identity = auth.loadDevIdentityForDiagnostics();
    if (!identity) throw new Error("signed-in local development identity is required");
    const actor = declarations.createActor(await auth.buildAgent(identity));
    const resolved = await inbox.getActionInboxConfig(actor);
    if (!resolved) throw new Error("OpenChat binding is not configured");
    return {
      canisterId: resolved.canisterId,
      consumerKeySelector: Array.from(resolved.consumerKeySelector),
    };
  })()`)) as { canisterId: unknown; consumerKeySelector: unknown };
  if (
    typeof config.canisterId !== "string" ||
    !Array.isArray(config.consumerKeySelector) ||
    config.consumerKeySelector.length !== 32 ||
    config.consumerKeySelector.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 255,
    )
  ) {
    throw new Error("authenticated IOU binding returned an invalid ActionInbox bucket selector");
  }
  return {
    canisterId: config.canisterId,
    consumerKeySelector: Uint8Array.from(config.consumerKeySelector),
  };
}

async function bucketCount(a: HttpAgent, bucket: AuthenticatedInboxBucket): Promise<number> {
  const actor: any = Actor.createActor(inboxIdl, { agent: a, canisterId: bucket.canisterId });
  const resp = await actor.actions({
    max_results: 500,
    consumer_key_fingerprint: Array.from(bucket.consumerKeySelector),
    since_id: 0n,
  });
  if (!resp?.Success || !Array.isArray(resp.Success.actions)) {
    throw new Error("ActionInbox rejected the authenticated bucket count");
  }
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

type ExpectedEntry = {
  kind: "iou";
  amount: number;
  currency: "EGP";
  direction: "credit";
  note: string;
};

type LoadedMultiCard = {
  card: Locator;
  frame: FrameLocator;
};

type InboxBatchLookup = {
  found: boolean;
  linkedSheet: string | null;
  matched: number;
  acknowledged: number;
};

function matchesExpectedBatch(value: unknown, expected: ExpectedEntry[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  return value.every((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
    const row = candidate as Record<string, unknown>;
    const wanted = expected[index];
    return (
      row.kind === wanted.kind &&
      row.amount === wanted.amount &&
      row.currency === wanted.currency &&
      row.direction === wanted.direction &&
      row.note === wanted.note
    );
  });
}

async function installNewCardObserver(page: Page, tag: string): Promise<void> {
  await page.evaluate(`((observerTag) => {
    const root = globalThis;
    root.__iouMultiCardObserver?.observer.disconnect();
    const state = {
      tag: observerTag,
      nextId: 0,
      baseline: new Set(document.querySelectorAll(".action-card")),
    };
    const tagCards = () => {
      for (const card of document.querySelectorAll(".action-card")) {
        if (state.baseline.has(card) || card.dataset.iouMultiCardId) continue;
        card.dataset.iouMultiCardId = observerTag + "-" + state.nextId++;
      }
    };
    const observer = new MutationObserver(tagCards);
    state.observer = observer;
    root.__iouMultiCardObserver = state;
    observer.observe(document.body, { childList: true, subtree: true });
    tagCards();
  })(${JSON.stringify(tag)})`);
}

async function removeNewCardObserver(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const root = globalThis;
    const state = root.__iouMultiCardObserver;
    state?.observer.disconnect();
    if (state) {
      for (const card of document.querySelectorAll(".action-card[data-iou-multi-card-id]")) {
        if (card.dataset.iouMultiCardId?.startsWith(state.tag + "-")) {
          delete card.dataset.iouMultiCardId;
        }
      }
    }
    delete root.__iouMultiCardObserver;
  })()`).catch(() => {});
}

async function findAndLoadMultiCard(
  page: Page,
  expected: ExpectedEntry[],
  timeoutMs = 40_000,
): Promise<LoadedMultiCard | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cards = page.locator(".action-card[data-iou-multi-card-id]");
    for (let index = 0; index < await cards.count().catch(() => 0); index++) {
      const card = cards.nth(index);
      if (!(await card.isVisible().catch(() => false))) continue;
      const isIou = await card.getByText(/Directory entry:\s*iou/i).first().isVisible().catch(() => false);
      if (!isIou) continue;
      const untrusted = await card
        .getByText(/card content is untrusted|Untrusted card text/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (untrusted) continue;
      if ((await card.locator("iframe").count()) === 0) {
        const load = card.getByRole("button", { name: "Load app card", exact: true });
        if (await load.isVisible().catch(() => false)) {
          if (!(await load.isEnabled())) throw new Error("the verified Load app card gate is disabled");
          await load.click({ timeout: 10_000 });
        }
      }
      if ((await card.locator("iframe").count()) === 0) continue;
      const frame = card.frameLocator("iframe");
      await frame.locator("input").first().waitFor({ timeout: 4_000 }).catch(() => {});
      const inputs = frame.locator("input");
      const values: string[] = [];
      for (let input = 0; input < await inputs.count().catch(() => 0); input++) {
        values.push(await inputs.nth(input).inputValue().catch(() => ""));
      }
      if (expected.every((entry) => values.includes(entry.note))) return { card, frame };
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function approveMultiCard(card: LoadedMultiCard, expected: ExpectedEntry[]): Promise<void> {
  const add = card.frame.getByRole("button", { name: `Add all ${expected.length} entries`, exact: true });
  await add.waitFor({ state: "visible", timeout: 10_000 });
  if (!(await add.isEnabled())) throw new Error("the nonce-scoped Add all button is disabled");
  await add.click();

  const approval = card.card.getByRole("group", { name: "Approve app card request" });
  await approval.waitFor({ state: "visible", timeout: 10_000 });
  const summaryText = await approval.locator(".approval-summary").innerText();
  let payload: unknown;
  try {
    payload = JSON.parse(summaryText);
  } catch {
    throw new Error("OpenChat host approval did not expose a canonical JSON payload");
  }
  if (!matchesExpectedBatch(payload, expected)) {
    throw new Error("OpenChat host approval is not bound to this run's exact two-entry payload");
  }
  const disclosure = approval.getByRole("checkbox");
  if (await disclosure.isVisible().catch(() => false)) await disclosure.check();
  const confirm = approval.getByRole("button", { name: "Confirm request", exact: true });
  if (!(await confirm.isEnabled())) throw new Error("OpenChat host approval is not actionable");
  await confirm.click({ timeout: 10_000 });
}

async function cancelMultiCard(card: LoadedMultiCard): Promise<boolean> {
  const pendingApproval = card.card.getByRole("group", { name: "Approve app card request" });
  if (await pendingApproval.isVisible().catch(() => false)) {
    await pendingApproval.getByRole("button", { name: "Dismiss", exact: true }).click().catch(() => {});
    // Dismiss is deliberately host-local; the iframe still shows its in-flight state. Reload only
    // this already nonce-identified iframe so it establishes a fresh bridge session and exposes
    // Cancel again. This never navigates the chat or selects another card.
    const iframe = card.card.locator("iframe");
    await iframe.evaluate((element) => {
      const src = element.getAttribute("src");
      if (src) element.setAttribute("src", src);
    });
  }
  const cancel = card.frame.getByRole("button", { name: "Cancel", exact: true });
  if (!(await cancel.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false))) {
    return false;
  }
  if (!(await cancel.isEnabled())) return false;
  await cancel.click({ timeout: 8_000 });
  const approval = card.card.getByRole("group", { name: "Approve app card request" });
  if (!(await approval.waitFor({ state: "visible", timeout: 8_000 }).then(() => true).catch(() => false))) {
    return false;
  }
  await approval.getByRole("button", { name: "Cancel card", exact: true }).click({ timeout: 8_000 });
  return true;
}

async function lookupInboxBatch(
  page: Page,
  expected: ExpectedEntry[],
  acknowledge: boolean,
): Promise<InboxBatchLookup> {
  const input = JSON.stringify({ exactEntries: expected, shouldAcknowledge: acknowledge });
  return (await page.evaluate(`(async ({ exactEntries, shouldAcknowledge }) => {
      const inbox = await import("/src/features/openchat/actionInboxClient.ts");
      const auth = await import("/src/features/auth/AuthProvider.tsx");
      const declarations = await import("/src/backend/declarations.ts");
      const routing = await import("/src/features/openchat/chatSheetLinks.ts");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("signed-in local development identity is required");
      const actor = declarations.createActor(await auth.buildAgent(identity));
      const config = await inbox.getActionInboxConfig(actor);
      if (!config) throw new Error("OpenChat binding is not configured");
      const isExactBatch = (value) => {
        if (!Array.isArray(value) || value.length !== exactEntries.length) return false;
        return value.every((candidate, index) => {
          if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return false;
          const row = candidate;
          const wanted = exactEntries[index];
          return (
            row.kind === wanted.kind &&
            row.amount === wanted.amount &&
            row.currency === wanted.currency &&
            row.direction === wanted.direction &&
            row.note === wanted.note
          );
        });
      };
      const drafts = await inbox.pollActionInbox({
        config,
        identity,
        maxResults: 120,
      });
      const matches = drafts.filter((candidate) => isExactBatch(candidate.draft));
      const links = await routing.fetchChatSheetLinks(
        actor,
        identity.getPrincipal().toText(),
      );
      const linkedSheets = new Set(
        matches
          .map((match) => links[match.context.chatHandle])
          .filter((sheet) => typeof sheet === "string" && sheet.length > 0),
      );
      let acknowledged = 0;
      if (shouldAcknowledge && matches.length === 1) {
        const match = matches[0];
        const result = await inbox.acknowledgeActionInbox({
          config,
          identity,
          throughId: match.id,
          acknowledgementSecret: match.acknowledgementSecret,
        });
        acknowledged = result.acknowledged;
      }
      return {
        found: matches.length > 0,
        linkedSheet: linkedSheets.size === 1 ? [...linkedSheets][0] : null,
        matched: matches.length,
        acknowledged,
      };
    })(${input})`)) as InboxBatchLookup;
}

async function cleanupIouBatch(
  page: Page,
  expected: ExpectedEntry[],
  knownSheet: string | null,
  waitForImportedEntries: boolean,
): Promise<{ deletedEntries: number; acknowledged: number }> {
  await page.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" }).catch(() => {});
  let lookup: InboxBatchLookup = { found: false, linkedSheet: null, matched: 0, acknowledged: 0 };
  for (let attempt = 0; attempt < 10 && !lookup.found && knownSheet === null; attempt++) {
    lookup = await lookupInboxBatch(page, expected, false);
    if (!lookup.found) await page.waitForTimeout(1_500);
  }
  const sheet = knownSheet ?? lookup.linkedSheet;
  let deletedEntries = 0;
  if (sheet) {
    await page.goto(`${IOU_BASE}/sheet/${sheet}`, { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog");
    if (await dialog.isVisible().catch(() => false)) {
      const text = await dialog.innerText().catch(() => "");
      if (expected.every((entry) => text.includes(entry.note))) {
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click().catch(() => {});
      }
    }
    for (const expectedEntry of expected) {
      const rows = page
        .locator("section.history")
        .locator(":scope > ul > li")
        .filter({ hasText: expectedEntry.note });
      if (waitForImportedEntries) {
        await rows.first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const row = rows.first();
        if (!(await row.isVisible().catch(() => false))) break;
        const remove = row.getByRole("button", { name: "delete", exact: true });
        if (!(await remove.isVisible().catch(() => false))) {
          throw new Error(`nonce-scoped History row ${expectedEntry.note} has no delete action`);
        }
        await remove.click({ timeout: 8_000 });
        await row.waitFor({ state: "hidden", timeout: 15_000 });
        deletedEntries++;
      }
    }
  }

  const acknowledged = await lookupInboxBatch(page, expected, true);
  if (sheet) {
    await page.goto(`${IOU_BASE}/sheet/${sheet}`, { waitUntil: "domcontentloaded" });
    const pending = page
      .locator("section.card")
      .filter({ has: page.getByRole("heading", { name: /Pending from chat/i }) })
      .locator(":scope > ul > li")
      .filter({ hasText: expected[0].note })
      .filter({ hasText: expected[1].note })
      .first();
    if (await pending.isVisible().catch(() => false)) {
      await pending
        .getByTitle("Dismiss without adding (for everyone on this sheet)")
        .click({ timeout: 8_000 });
      await pending.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
    }
  }
  return { deletedEntries, acknowledged: acknowledged.acknowledged };
}

// Roles: proposer = manager (v1, :9241), confirmer = father (:9222 OC / :9231 IOU). The confirmer's
// IOU tab is where we drive the multi-entry import (its fan-out envelope carries the same messageId).
const PROPOSER = { user: "manager", ocPort: 9241 };
const CONFIRMER = { user: "father", ocPort: 9222, iouPort: 9231 };

async function main() {
  const a = await agent();

  const proposerSource = await attach(PROPOSER.ocPort, "localhost:5003");
  const proposerIouSource = await attach(PROPOSER.ocPort, "127.0.0.1:3000");
  const confirmerSource = await attach(CONFIRMER.ocPort, "localhost:5003");
  const confirmerIouSource = await attach(CONFIRMER.iouPort, "127.0.0.1:3000");
  const tabs = new TemporaryTabScope();
  const failuresBefore = failures;
  let artifactScope: OpenChatArtifactScope | undefined;
  let inboxScope: ActionInboxArtifactScope | undefined;
  let primaryFailed = false;
  try {
  const proposerOC = await tabs.open(proposerSource, "http://localhost:5003/chats", {
    manualExtract: true,
  });
  const proposerIOU = await tabs.open(proposerIouSource, `${IOU_BASE}/pairs`);
  const confirmerOC = await tabs.open(confirmerSource, "http://localhost:5003/chats");
  const confirmerIOU = await tabs.open(confirmerIouSource, `${IOU_BASE}/pairs`);

  // 1. Open the direct chat on both OC sides; resolve both user ids from the URLs.
  await proposerOC.waitForTimeout(3000);
  await proposerOC.locator(".chat-summary, .chat_summary").filter({ hasText: new RegExp(CONFIRMER.user, "i") }).first().click({ timeout: 15000 });
  await proposerOC.waitForTimeout(2500);
  await armManualExtractForCurrentUrl(proposerOC);
  const confirmerId = /user\/([a-z0-9-]+)/.exec(proposerOC.url())?.[1];
  check(!!confirmerId, `${CONFIRMER.user} user id resolved (${confirmerId})`);

  await confirmerOC.waitForTimeout(3000);
  await confirmerOC.locator(".chat-summary, .chat_summary").filter({ hasText: new RegExp(PROPOSER.user, "i") }).first().click({ timeout: 15000 });
  await confirmerOC.waitForTimeout(2500);
  const proposerId = /user\/([a-z0-9-]+)/.exec(confirmerOC.url())?.[1];
  check(!!proposerId, `${PROPOSER.user} user id resolved (${proposerId})`);
  if (!confirmerId || !proposerId) throw new Error("could not resolve both user ids");

  // The selector is caller-private LocalUserIndex state. Resolve it only through Father's signed-in
  // IOU actor; never query another user's key through the public/global UserIndex surface.
  const confirmerBucket = await authenticatedInboxBucket(confirmerIOU);
  console.log(`[env] authenticated confirmer inbox=${confirmerBucket.canisterId}`);
  const beforeBucket = await bucketCount(a, confirmerBucket);
  console.log(`[inbox] confirmer bucket before: ${beforeBucket}`);

  const nonce = `${Date.now()}-${webcrypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const text = `Multi ${nonce}: two fees`;
  const expected: ExpectedEntry[] = [
    { kind: "iou", amount: 350, currency: "EGP", direction: "credit", note: `multi-a ${nonce}` },
    { kind: "iou", amount: 500, currency: "EGP", direction: "credit", note: `multi-b ${nonce}` },
  ];
  const extraction = JSON.stringify(expected);
  artifactScope = new OpenChatArtifactScope(proposerOC, "multi-entry end-to-end live proof");
  await artifactScope.begin();
  artifactScope.expectExactText(text);
  artifactScope.expectCardInputs(expected.map((entry) => entry.note));
  inboxScope = new ActionInboxArtifactScope(
    [{ label: PROPOSER.user, page: proposerIOU }],
    {
      shape: "batch",
      entries: expected.map((entry) => ({
        kind: entry.kind,
        amount: entry.amount,
        currency: entry.currency,
        direction: entry.direction,
        note: entry.note,
      })),
    },
    "multi-entry end-to-end live proof",
  );
  await inboxScope.begin();
  let dialogInstalled = false;
  let observerInstalled = false;
  let runCard: LoadedMultiCard | null = null;
  let confirmationAttempted = false;
  let deliveryObserved = false;
  let linkedSheet: string | null = null;
  let importAttempted = false;
  let bodyCompleted = false;
  const onDialog = (dialog: Dialog) => {
    const reply = /JSON/i.test(dialog.message()) ? extraction : "1";
    dialog.accept(reply).catch(() => {});
  };

  try {
    // 2. Propose with the deterministic two-element array seam.
    await installNewCardObserver(confirmerOC, `multi-${nonce}`);
    observerInstalled = true;
    proposerOC.on("dialog", onDialog);
    dialogInstalled = true;
    const composer = proposerOC.locator(".ProseMirror").first();
    await composer.waitFor({ timeout: 15_000 });
    await composer.click();
    await proposerOC.keyboard.type(text);
    await proposerOC.keyboard.press("Enter");
    await proposerOC.waitForTimeout(2_500);

    // The recipient's new card must first become directory-bound, then pass the explicit Load app
    // card gate. Its isolated inputs identify this exact nonce before any action is requested.
    for (let attempt = 1; attempt <= 3 && !runCard; attempt++) {
      try {
        const bubble = proposerOC.locator(".bubble-wrapper").filter({ hasText: text }).last();
        await bubble.scrollIntoViewIfNeeded().catch(() => {});
        await bubble.hover();
        await proposerOC.waitForTimeout(500);
        await bubble.locator(".menu-icon").first().click({ timeout: 12_000 });
        await proposerOC.getByText("Propose action", { exact: true }).click({ timeout: 12_000 });
        runCard = await findAndLoadMultiCard(confirmerOC, expected, 35_000);
      } catch (error) {
        console.log(`propose attempt ${attempt} failed: ${(error as Error).message.slice(0, 90)}`);
      }
      if (!runCard) {
        await proposerOC.keyboard.press("Escape").catch(() => {});
        await proposerOC.waitForTimeout(1_000);
      }
    }
    check(runCard !== null, "the exact multi-entry card loaded through OpenChat's app-card gate");
    if (!runCard) throw new Error("this run's card never posted");

    // 3. The iframe request is not the confirmation. Parse the host-owned canonical summary and
    // require both exact nonce-scoped rows before clicking OpenChat's final Confirm request button.
    confirmationAttempted = true;
    inboxScope.arm();
    await approveMultiCard(runCard, expected);
    await confirmerOC.waitForTimeout(6_000);
    const afterBucket = await bucketCount(a, confirmerBucket);
    deliveryObserved = afterBucket > beforeBucket;
    const oneDelivery = afterBucket === beforeBucket + 1;
    check(oneDelivery, `ONE deposit for the whole batch (${beforeBucket} -> ${afterBucket})`);
    if (!oneDelivery) throw new Error("host approval did not produce exactly one batch delivery");

  // 4. IOU side: the "Pending from chat" card shows "2 entries"; Review & add → Add all → 2 land.
  // The card is scoped to the sheet the producing chat is LINKED to (draftBelongsOnSheet). Obtain
  // the app-scoped chat handle only from this nonce's verified v4 inbox envelope, then resolve the
  // authenticated user's canister-backed mapping. Raw direct-chat ids and legacy v1 localStorage
  // keys are neither authoritative nor accepted by the current routing boundary.
  await confirmerIOU.goto(`${IOU_BASE}/pairs`, { waitUntil: "domcontentloaded" });
  let route: InboxBatchLookup = { found: false, linkedSheet: null, matched: 0, acknowledged: 0 };
  for (let attempt = 0; attempt < 10 && !route.found; attempt++) {
    route = await lookupInboxBatch(confirmerIOU, expected, false);
    if (!route.found) await confirmerIOU.waitForTimeout(2_000);
  }
  check(route.matched === 1, "exactly one verified envelope carries this run's two-entry payload");
  check(!!route.linkedSheet, "the envelope's opaque chat handle resolves to one IOU sheet");
  if (route.matched !== 1 || !route.linkedSheet) {
    throw new Error("the exact verified batch or authoritative chat-to-sheet route is unavailable");
  }
  linkedSheet = route.linkedSheet;
  await confirmerIOU.goto(`${IOU_BASE}/sheet/${linkedSheet}`, { waitUntil: "domcontentloaded" });
  await confirmerIOU.waitForTimeout(2500);

  // The pending card summary must read "2 entries: …" (batchSummary). Poll — the inbox polls at 15 s.
  const pendingSection = confirmerIOU.locator("section.card").filter({
    has: confirmerIOU.getByRole("heading", { name: /Pending from chat/i }),
  });
  const pendingCard = pendingSection.locator(":scope > ul > li")
    .filter({ hasText: /2 entr/i })
    .filter({ hasText: expected[0].note })
    .filter({ hasText: expected[1].note })
    .first();
  let sawCount = false;
  for (let i = 0; i < 12 && !sawCount; i++) {
    sawCount = await pendingCard.isVisible().catch(() => false);
    if (!sawCount) {
      await confirmerIOU.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await confirmerIOU.waitForTimeout(3000);
    }
  }
  check(sawCount, 'the IOU pending card shows "2 entries"');
  if (!sawCount) throw new Error("the exact two-entry pending card did not render");

  await pendingCard.getByRole("button", { name: /Review & add/ }).click({ timeout: 10_000 });
  const modal = confirmerIOU.getByRole("dialog");
  await modal.getByRole("heading", { name: /Add 2 entries\?/ }).waitFor({ timeout: 10_000 });
  const modalText = await modal.innerText();
  const modalIsExact = expected.every((entry) => modalText.includes(entry.note));
  check(modalIsExact, "BatchConfirmModal lists both nonce-scoped entries");
  if (!modalIsExact) throw new Error("BatchConfirmModal is not scoped to this run's exact payload");
  importAttempted = true;
  await modal.getByRole("button", { name: /Add all 2 entries/ }).click({ timeout: 10_000 });
  await modal.waitFor({ state: "hidden", timeout: 30_000 });

  const history = confirmerIOU.locator("section.history");
  const entryA = history.locator(":scope > ul > li").filter({ hasText: expected[0].note }).first();
  const entryB = history.locator(":scope > ul > li").filter({ hasText: expected[1].note }).first();
  await Promise.all([
    entryA.waitFor({ state: "visible", timeout: 30_000 }),
    entryB.waitFor({ state: "visible", timeout: 30_000 }),
  ]);
  check(await entryA.isVisible(), "this run's entry A landed in History");
  check(await entryB.isVisible(), "this run's entry B landed in History");
  check(!(await pendingCard.isVisible().catch(() => false)), "the pending card disappeared after Add all");
  bodyCompleted = true;
  } finally {
    if (dialogInstalled) proposerOC.off("dialog", onDialog);
    if (!deliveryObserved && runCard) {
      try {
        const cancelled = await cancelMultiCard(runCard);
        console.log(cancelled ? "[cleanup] cancelled only this run's pending card" : "[cleanup] card was no longer cancellable");
      } catch (error) {
        failures++;
        console.error(`[cleanup] exact OpenChat card cleanup failed: ${(error as Error).message}`);
      }
    }
    let cleanup: { deletedEntries: number; acknowledged: number } | undefined;
    if (confirmationAttempted || deliveryObserved || linkedSheet !== null) {
      try {
        cleanup = await cleanupIouBatch(confirmerIOU, expected, linkedSheet, importAttempted);
        console.log(`[cleanup] deleted=${cleanup.deletedEntries}, acknowledged=${cleanup.acknowledged}`);
      } catch (error) {
        failures++;
        console.error(`[cleanup] exact IOU batch cleanup failed: ${(error as Error).message}`);
      }
    }
    if (bodyCompleted) {
      check(cleanup?.deletedEntries === 2, "cleanup soft-deleted exactly this run's two History entries");
    }
    if (confirmationAttempted) {
      try {
        let finalBucket = await bucketCount(a, confirmerBucket);
        for (let attempt = 0; attempt < 8 && finalBucket !== beforeBucket; attempt++) {
          await confirmerIOU.waitForTimeout(1_000);
          finalBucket = await bucketCount(a, confirmerBucket);
        }
        check(finalBucket === beforeBucket, "cleanup returned the confirmer inbox to its pre-run count");
      } catch (error) {
        failures++;
        console.error(
          `[cleanup] confirmer inbox count verification failed: ${(error as Error).message}`,
        );
      }
    }
    if (observerInstalled) await removeNewCardObserver(confirmerOC);
  }

  if (failures > 0) {
    throw new Error(`MULTI-ENTRY VERIFY FAILED — ${failures} assertion(s)`);
  }
  console.log("\n🏁 MULTI-ENTRY LIVE VERIFY PASSED: array → 1 card '2 entries' → Add all → 2 entries, 1 messageId");
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    const primaryInFlight = primaryFailed || failures > failuresBefore;
    let cleanupFailure: unknown;
    try {
      await finalizeActionInboxArtifactCleanup(
        inboxScope,
        primaryInFlight,
        "multi-entry end-to-end live proof",
      );
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryInFlight || cleanupFailure !== undefined,
        "multi-entry end-to-end live proof",
      );
    } catch (error) {
      cleanupFailure ??= error;
    } finally {
      await tabs.close();
    }
    if (cleanupFailure !== undefined && !primaryInFlight) throw cleanupFailure;
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
  });
