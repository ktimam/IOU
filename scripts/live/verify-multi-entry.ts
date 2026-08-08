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
// ports from cdp-ports.json. Prereq: the manager↔father DM exists, both members are paired to IOU, and the
// chat is linked to a sheet (journey-fanout.ts establishes pairing; link the chat once via the IOU
// "Pending from chat" first-import "remember" checkbox or /openchat/link-chat). Both nonce-scoped
// entries are soft-deleted after the History assertions so they do not affect later balances.
//
//   pnpm exec tsx scripts/live/verify-multi-entry.ts
import {
  chromium,
  type ConsoleMessage,
  type Locator,
  type Page,
} from "@playwright/test";
import { Actor, HttpAgent } from "@dfinity/agent";
import { webcrypto } from "node:crypto";
import { CDP_PORTS } from "./cdpPorts";
import { isImmediateStableSuccessor, sameStableMessage } from "./journeySafety";
import {
  dismissBlockingOpenChatOverlays,
  exactOpenChatMessageWrapper,
  finalizeOpenChatArtifactCleanup,
  openExactOwnedClassicOpenChatMessageMenu,
  OpenChatArtifactScope,
  type OpenChatCardRowEvidence,
  type OpenChatMessageRef,
} from "./openChatArtifactCleanup";
import {
  armManualExtractForCurrentUrl,
  installManualPromptOverride,
  readManualPromptProbe,
  removeManualPromptOverride,
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
  kind: "iou" | "settlement";
  amount: number;
  currency: "EGP" | "USD";
  direction: "credit" | "debt";
  date: string;
  note: string;
  message: string;
};

type LoadedMultiCard = {
  card: Locator;
  message: OpenChatMessageRef;
};

type InboxBatchLookup = {
  found: boolean;
  linkedSheet: string | null;
  matched: number;
  acknowledged: number;
};

function expectedPublicRows(expected: ExpectedEntry[]): OpenChatCardRowEvidence[] {
  return expected.map((entry, index) => ({
    label: `Entry ${index + 1}`,
    value: [
      `Amount: ${entry.amount}`,
      `Currency: ${entry.currency}`,
      `Type: ${entry.kind}`,
      `Direction: ${entry.direction}`,
      `Date: ${entry.date}`,
      `Note: ${entry.note}`,
    ].join(" · "),
  }));
}

function normalized(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

async function exactlyOneVisible(locator: Locator, label: string): Promise<Locator> {
  const visible: Locator[] = [];
  for (let index = 0; index < await locator.count(); index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) visible.push(candidate);
  }
  if (visible.length !== 1) {
    throw new Error(`${label}: expected one visible control, found ${visible.length}`);
  }
  return visible[0];
}

async function visibleLocatorTexts(locator: Locator): Promise<string[]> {
  const visible: string[] = [];
  for (let index = 0; index < await locator.count(); index++) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const exactText = (await candidate.innerText().catch(() => "")).trim();
    visible.push(exactText.length > 0 ? exactText : "<empty>");
  }
  return visible;
}

async function throwVisibleProposalBlocker(page: Page): Promise<void> {
  // Do not guess which translation/error prefix a failed proposal will use. Any toast produced by
  // this otherwise-isolated tab after the one Propose click is terminal evidence for this run.
  const toastTexts = await visibleLocatorTexts(page.locator(".toast"));
  if (toastTexts.length > 0) {
    throw new Error(`proposal toast: ${toastTexts.join(" | ")}`);
  }

  const chooserTexts = await visibleLocatorTexts(page.locator(".ai-action-choices"));
  if (chooserTexts.length > 0) {
    throw new Error(`proposal stopped at action chooser: ${chooserTexts.join(" | ")}`);
  }

  const checkConnection = page.getByRole("button", { name: /Check connection/i });
  if ((await visibleLocatorTexts(checkConnection)).length > 0) {
    const modal = checkConnection.locator(
      'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " modal-content ")][1]',
    );
    const modalText = (await modal.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    throw new Error(
      `proposal stopped at app-link consent${modalText.length > 0 ? `: ${modalText}` : ""}`,
    );
  }
}

async function cardRows(card: Locator): Promise<OpenChatCardRowEvidence[]> {
  const rows = card.locator("table.rows tbody tr");
  const result: OpenChatCardRowEvidence[] = [];
  for (let index = 0; index < await rows.count().catch(() => 0); index++) {
    result.push({
      label: await rows.nth(index).locator("td.label").innerText().catch(() => ""),
      value: await rows.nth(index).locator("td.value").innerText().catch(() => ""),
    });
  }
  return result;
}

function sameRows(
  observed: OpenChatCardRowEvidence[],
  expected: OpenChatCardRowEvidence[],
): boolean {
  return (
    observed.length === expected.length &&
    observed.every(
      (row, index) =>
        normalized(row.label) === normalized(expected[index].label) &&
        normalized(row.value) === normalized(expected[index].value),
    )
  );
}

async function messageFromCard(card: Locator): Promise<OpenChatMessageRef> {
  const wrapper = card.locator(
    'xpath=ancestor::*[@data-id and @data-index and starts-with(@id,"event-")][1]',
  );
  if ((await wrapper.count()) !== 1) throw new Error("multi card message wrapper is not unique");
  const [messageId, rawIndex, rawEvent] = await Promise.all([
    wrapper.getAttribute("data-id"),
    wrapper.getAttribute("data-index"),
    wrapper.getAttribute("id"),
  ]);
  const event = /^event-(\d+)$/.exec(rawEvent ?? "");
  if (!/^\d+$/.test(messageId ?? "") || !/^\d+$/.test(rawIndex ?? "") || !event) {
    throw new Error("multi card has invalid stable message coordinates");
  }
  return {
    messageId: messageId!,
    messageIndex: Number(rawIndex),
    eventIndex: Number(event[1]),
  };
}

async function findClassicMultiCard(
  page: Page,
  expectedRows: OpenChatCardRowEvidence[],
  expectedMessage?: OpenChatMessageRef,
  timeoutMs = 40_000,
): Promise<LoadedMultiCard | null> {
  const deadline = Date.now() + timeoutMs;
  let firstFoundAt: number | undefined;
  let found: LoadedMultiCard | null = null;
  while (Date.now() < deadline) {
    await throwVisibleProposalBlocker(page);
    const cards = expectedMessage
      ? exactOpenChatMessageWrapper(page, expectedMessage).locator(".action-card")
      : page.locator(".action-card");
    const matches: LoadedMultiCard[] = [];
    for (let index = 0; index < await cards.count().catch(() => 0); index++) {
      const card = cards.nth(index);
      if (!(await card.isVisible().catch(() => false))) continue;
      const appName = normalized(await card.locator(".app-name").innerText().catch(() => ""));
      if (appName.toLocaleLowerCase("en-US") !== "iou") continue;
      if (
        await card
          .getByText(/card content is untrusted|Untrusted card text/i)
          .first()
          .isVisible()
          .catch(() => false)
      ) {
        continue;
      }
      if (!sameRows(await cardRows(card), expectedRows)) continue;
      if ((await card.locator("iframe").count()) !== 0) {
        throw new Error("multi-entry summary unexpectedly opened an app iframe");
      }
      matches.push({ card, message: await messageFromCard(card) });
    }
    if (matches.length > 1) {
      throw new Error("multiple exact two-entry cards were found; refusing ambiguous confirmation");
    }
    if (matches.length === 1) {
      found = matches[0];
      firstFoundAt ??= Date.now();
      if (Date.now() - firstFoundAt >= 800) return found;
    }
    await page.waitForTimeout(400);
  }
  await throwVisibleProposalBlocker(page);
  return found;
}

async function assertClassicMultiCard(
  loaded: LoadedMultiCard,
  expectedRows: OpenChatCardRowEvidence[],
): Promise<Locator> {
  const title = normalized(await loaded.card.locator(".title").innerText());
  if (title !== `Add to IOU (${expectedRows.length} entries)`) {
    throw new Error(`unexpected multi-card title: ${title}`);
  }
  const logo = loaded.card.locator("img.app-icon");
  await logo.waitFor({ state: "visible", timeout: 10_000 });
  if ((await logo.getAttribute("src")) !== `${IOU_BASE}/favicon.svg`) {
    throw new Error("multi card did not render the authoritative IOU logo");
  }
  const visibleUrl = loaded.card.locator(".card-url");
  if (
    (await visibleUrl.count()) !== 1 ||
    normalized(await visibleUrl.innerText()) !== `${IOU_BASE}/openchat/card`
  ) {
    throw new Error("multi card did not keep its exact registered card URL visible");
  }
  if ((await loaded.card.locator("iframe").count()) !== 0) {
    throw new Error("multi card must stay in the host-owned classic renderer");
  }
  if (!sameRows(await cardRows(loaded.card), expectedRows)) {
    throw new Error("multi card public rows do not exactly match the stored payload summary");
  }
  for (const obsolete of ["Load app card", "Share app context"] as const) {
    if (
      await loaded.card
        .getByRole("button", { name: obsolete, exact: true })
        .isVisible()
        .catch(() => false)
    ) {
      throw new Error(`classic multi card unexpectedly requires ${obsolete}`);
    }
  }
  if (
    await loaded.card
      .getByText(
        /Loading contacts this external origin|If you separately grant private context|Capabilities never enter this URL/i,
      )
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    throw new Error("classic multi card still renders obsolete protocol explanation text");
  }
  if ((await loaded.card.getByRole("checkbox").count()) !== 0) {
    throw new Error("classic IOU multi card unexpectedly requires a disclosure checkbox");
  }
  if ((await loaded.card.getByRole("group", { name: "Approve app card request" }).count()) !== 0) {
    throw new Error("classic stored-payload card unexpectedly added a second approval step");
  }
  const confirm = loaded.card.getByRole("button", { name: "Add to IOU", exact: true });
  if ((await confirm.count()) !== 1 || !(await confirm.isEnabled())) {
    throw new Error("classic stored-payload Add to IOU action is unavailable");
  }
  return confirm;
}

async function cancelMultiCard(card: LoadedMultiCard): Promise<boolean> {
  const cancel = card.card.getByRole("button", { name: "Cancel", exact: true });
  if (!(await cancel.isVisible().catch(() => false)) || !(await cancel.isEnabled())) return false;
  await cancel.click({ timeout: 8_000 });
  return true;
}

function expectedPendingBatchSummary(expected: ExpectedEntry[]): string {
  const summaries = expected.map((entry) =>
    `${entry.kind === "settlement" ? "Settlement" : "IOU"} ` +
    `${entry.amount.toFixed(2)} ${entry.currency} \u00b7 ` +
    `${entry.direction === "credit" ? "owed to you" : "you owe"} \u00b7 ` +
    `${entry.date}` +
    `${entry.note ? ` \u00b7 ${entry.note}` : ""}`,
  );
  return `${expected.length} entries: ${summaries.join(" \u00b7 ")}`;
}

async function exactPendingBatchRows(
  page: Page,
  exactSummary: string,
): Promise<Locator[]> {
  const section = page.locator("section.card").filter({
    has: page.getByRole("heading", { name: /Pending from chat/i }),
  });
  const rows = section.locator(":scope > ul > li");
  const matches: Locator[] = [];
  const normalizedExpected = normalized(exactSummary);
  for (let index = 0; index < await rows.count(); index++) {
    const row = rows.nth(index);
    const summary = row.locator(":scope > span.small");
    if ((await summary.count()) !== 1) continue;
    // The verified OpenChat provenance cue is nested. Compare only the direct text node emitted by
    // batchSummary so a similarly worded card, stale sibling, or button label cannot satisfy this.
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

async function waitForUniqueExactPendingBatch(
  page: Page,
  exactSummary: string,
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await exactPendingBatchRows(page, exactSummary);
    if (rows.length > 1) {
      throw new Error(
        `pending IOU batch: found ${rows.length} exact matches; refusing ambiguity`,
      );
    }
    if (rows.length === 1 && await rows[0].isVisible().catch(() => false)) return rows[0];
    await page.waitForTimeout(250);
  }
  return null;
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
            row.date === wanted.date &&
            row.note === wanted.note &&
            row.message === wanted.message
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

// Roles: proposer = manager (v1), confirmer = father (desktop OpenChat + separate IOU profile). The confirmer's
// IOU tab is where we drive the multi-entry import (its fan-out envelope carries the same messageId).
const PROPOSER = { user: "manager", ocPort: CDP_PORTS.manager, iouPort: CDP_PORTS.manager };
const CONFIRMER = {
  user: "father",
  ocPort: CDP_PORTS.fatherOpenChat,
  iouPort: CDP_PORTS.fatherIou,
};

async function main() {
  const a = await agent();

  const proposerSource = await attach(PROPOSER.ocPort, "localhost:5003");
  const proposerIouSource = await attach(PROPOSER.iouPort, "127.0.0.1:3000");
  const confirmerSource = await attach(CONFIRMER.ocPort, "localhost:5003");
  const confirmerIouSource = await attach(CONFIRMER.iouPort, "127.0.0.1:3000");
  const tabs = new TemporaryTabScope();
  const failuresBefore = failures;
  let artifactScope: OpenChatArtifactScope | undefined;
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
  await dismissBlockingOpenChatOverlays(proposerOC);
  await proposerOC.locator(".chat-summary, .chat_summary").filter({ hasText: new RegExp(CONFIRMER.user, "i") }).first().click({ timeout: 15000 });
  await proposerOC.waitForTimeout(2500);
  await armManualExtractForCurrentUrl(proposerOC);
  const confirmerId = /user\/([a-z0-9-]+)/.exec(proposerOC.url())?.[1];
  check(!!confirmerId, `${CONFIRMER.user} user id resolved (${confirmerId})`);

  await confirmerOC.waitForTimeout(3000);
  await dismissBlockingOpenChatOverlays(confirmerOC);
  await confirmerOC.locator(".chat-summary, .chat_summary").filter({ hasText: new RegExp(PROPOSER.user, "i") }).first().click({ timeout: 15000 });
  await confirmerOC.waitForTimeout(2500);
  const proposerId = /user\/([a-z0-9-]+)/.exec(confirmerOC.url())?.[1];
  check(!!proposerId, `${PROPOSER.user} user id resolved (${proposerId})`);
  if (!confirmerId || !proposerId) throw new Error("could not resolve both user ids");

  // Each selector is caller-private LocalUserIndex state. Resolve it only through that user's
  // signed-in IOU actor; never query another user's key through the public/global UserIndex surface.
  const proposerBucket = await authenticatedInboxBucket(proposerIOU);
  const confirmerBucket = await authenticatedInboxBucket(confirmerIOU);
  const before = {
    proposer: await bucketCount(a, proposerBucket),
    confirmer: await bucketCount(a, confirmerBucket),
  };
  console.log(`[env] authenticated inbox=${confirmerBucket.canisterId}`);
  console.log("[inbox] before:", before);

  const nonce = `${Date.now()}-${webcrypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const text = `Multi ${nonce}: two fees`;
  const expected: ExpectedEntry[] = [
    {
      kind: "iou",
      amount: 350,
      currency: "EGP",
      direction: "credit",
      date: "2026-08-08",
      note: `multi-a ${nonce}`,
      message: text,
    },
    {
      kind: "settlement",
      amount: 500,
      currency: "USD",
      direction: "debt",
      date: "2026-08-09",
      note: `multi-b ${nonce}`,
      message: text,
    },
  ];
  const extraction = JSON.stringify(expected);
  const publicRows = expectedPublicRows(expected);
  artifactScope = new OpenChatArtifactScope(proposerOC, "multi-entry end-to-end live proof");
  await artifactScope.begin();
  artifactScope.expectExactText(text);
  artifactScope.expectCardRows(publicRows);
  let promptOverride: Awaited<ReturnType<typeof installManualPromptOverride>> | null = null;
  let proposalListenersInstalled = false;
  let senderCard: LoadedMultiCard | null = null;
  let runCard: LoadedMultiCard | null = null;
  let confirmationAttempted = false;
  let deliveryObserved = false;
  let linkedSheet: string | null = null;
  let importAttempted = false;
  let bodyCompleted = false;
  let extractionPromptCalls = 0;
  const proposalDiagnostics: string[] = [];
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    if (proposalDiagnostics.length < 20) {
      proposalDiagnostics.push(`[console:${message.type()}] ${message.text()}`);
    }
  };
  const onPageError = (error: Error) => {
    if (proposalDiagnostics.length < 20) {
      proposalDiagnostics.push(`[pageerror] ${error.message}`);
    }
  };
  try {
    // 2. Propose exactly once from the fresh, sender-owned source message. A slow backend extends
    // observation; it never causes another mutating click or a duplicate card.
    promptOverride = await installManualPromptOverride(proposerOC, extraction);
    proposerOC.on("console", onConsole);
    proposerOC.on("pageerror", onPageError);
    proposalListenersInstalled = true;
    const composer = proposerOC.locator(".ProseMirror").first();
    await composer.waitFor({ timeout: 15_000 });
    await composer.click();
    await proposerOC.keyboard.type(text);
    await proposerOC.keyboard.press("Enter");
    const sourceMessage = await artifactScope.waitForExactTextMessage(text);
    const sourceWrapper = exactOpenChatMessageWrapper(proposerOC, sourceMessage);
    const senderOwned = await sourceWrapper.evaluate(
      (node) => node.classList.contains("message") && node.classList.contains("me"),
    );
    if (!senderOwned) throw new Error("multi source is not a sender-owned classic message");
    await openExactOwnedClassicOpenChatMessageMenu(proposerOC, sourceWrapper);
    const propose = await exactlyOneVisible(
      proposerOC.getByRole("menuitem", { name: "Propose action", exact: true }),
      "multi Propose action",
    );
    await propose.click({ timeout: 12_000 });

    const extractionPromptDeadline = Date.now() + 10_000;
    let promptProbe = await readManualPromptProbe(proposerOC, promptOverride);
    while (promptProbe.promptCalls === 0 && Date.now() < extractionPromptDeadline) {
      await throwVisibleProposalBlocker(proposerOC);
      await proposerOC.waitForTimeout(100);
      promptProbe = await readManualPromptProbe(proposerOC, promptOverride);
    }
    extractionPromptCalls = promptProbe.promptCalls;
    await throwVisibleProposalBlocker(proposerOC);
    console.log(
      `[diag] multi JSON extraction prompt count after Propose=${extractionPromptCalls}`,
    );
    if (promptProbe.promptCalls !== 1) {
      throw new Error(
        `multi Propose expected exactly one JSON extraction prompt, observed ${promptProbe.promptCalls}: ${promptProbe.prompts.join(" | ")}`,
      );
    }

    senderCard = await findClassicMultiCard(proposerOC, publicRows, undefined, 60_000);
    if (!senderCard) {
      throw new Error(
        `sender's exact classic multi card never posted (JSON extraction prompt count: ${extractionPromptCalls}); proposal diagnostics: ${proposalDiagnostics.join(" || ") || "none"}`,
      );
    }
    await artifactScope.trackExactCardRows(senderCard.card, publicRows);
    if (!isImmediateStableSuccessor(sourceMessage, senderCard.message)) {
      throw new Error("multi card is not the immediate stable successor of this run's source");
    }

    runCard = await findClassicMultiCard(confirmerOC, publicRows, senderCard.message, 35_000);
    if (!runCard || !sameStableMessage(senderCard.message, runCard.message)) {
      throw new Error("recipient did not resolve the sender's exact stable multi card");
    }
    check(extractionPromptCalls === 1, "multi propose requested deterministic JSON exactly once");
    check(true, "one exact two-entry classic card reached both participants");

    // 3. This is the immutable, backend-attested stored-payload path: OpenChat owns the visible rows
    // and its single Add to IOU button is the final confirmation. No iframe or second approval exists.
    const confirm = await assertClassicMultiCard(runCard, publicRows);
    confirmationAttempted = true;
    await confirm.click({ timeout: 10_000 });
    check(true, "ONE host-owned confirmation submitted the stored batch");
    await confirmerOC.waitForTimeout(6_000);
    const after = {
      proposer: await bucketCount(a, proposerBucket),
      confirmer: await bucketCount(a, confirmerBucket),
    };
    deliveryObserved = after.confirmer > before.confirmer;
    const oneDelivery =
      after.proposer === before.proposer && after.confirmer === before.confirmer + 1;
    check(
      oneDelivery,
      `ONE confirmer-only deposit for the whole batch (${JSON.stringify(before)} -> ${JSON.stringify(after)})`,
    );
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

  // Let SheetPage finish its replicated ActionInbox fetch, signature verification, and decryption.
  // Repeated short reloads unmount the page and mark every in-flight load cancelled; that can starve
  // a healthy inbox forever. Wait uninterrupted, then allow one fallback reload for a missed mount.
  const pendingSummary = expectedPendingBatchSummary(expected);
  let pendingCard = await waitForUniqueExactPendingBatch(
    confirmerIOU,
    pendingSummary,
    30_000,
  );
  if (pendingCard === null) {
    await confirmerIOU.reload({ waitUntil: "domcontentloaded" });
    pendingCard = await waitForUniqueExactPendingBatch(
      confirmerIOU,
      pendingSummary,
      30_000,
    );
  }
  check(pendingCard !== null, 'the IOU pending card shows one exact "2 entries" summary');
  if (pendingCard === null) throw new Error("the exact two-entry pending card did not render");

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
    if (proposalListenersInstalled) {
      proposerOC.off("console", onConsole);
      proposerOC.off("pageerror", onPageError);
    }
    if (promptOverride) {
      try {
        const finalPromptProbe = await readManualPromptProbe(proposerOC, promptOverride);
        extractionPromptCalls = finalPromptProbe.promptCalls;
        if (finalPromptProbe.promptCalls !== 1) {
          failures++;
          console.error(
            `[teardown] multi Propose expected exactly one JSON extraction prompt, observed ${finalPromptProbe.promptCalls}: ${finalPromptProbe.prompts.join(" | ")}`,
          );
        } else {
          console.log("[teardown] multi JSON extraction prompt count remained exactly one");
        }
      } catch (error) {
        failures++;
        console.error(
          `[teardown] manual prompt probe read failed: ${(error as Error).message}`,
        );
      } finally {
        await removeManualPromptOverride(proposerOC, promptOverride).catch((error) => {
          failures++;
          console.error(`[teardown] manual prompt restore failed: ${(error as Error).message}`);
        });
      }
    }
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
      try {
        const proposerCleanup = await cleanupIouBatch(proposerIOU, expected, null, false);
        console.log(
          `[cleanup] proposer deleted=${proposerCleanup.deletedEntries}, acknowledged=${proposerCleanup.acknowledged}`,
        );
      } catch (error) {
        failures++;
        console.error(`[cleanup] proposer leak cleanup failed: ${(error as Error).message}`);
      }
    }
    if (bodyCompleted) {
      check(cleanup?.deletedEntries === 2, "cleanup soft-deleted exactly this run's two History entries");
    }
    if (confirmationAttempted) {
      try {
        let final = {
          proposer: await bucketCount(a, proposerBucket),
          confirmer: await bucketCount(a, confirmerBucket),
        };
        for (
          let attempt = 0;
          attempt < 8 &&
          (final.proposer !== before.proposer || final.confirmer !== before.confirmer);
          attempt++
        ) {
          await confirmerIOU.waitForTimeout(1_000);
          final = {
            proposer: await bucketCount(a, proposerBucket),
            confirmer: await bucketCount(a, confirmerBucket),
          };
        }
        check(
          final.proposer === before.proposer && final.confirmer === before.confirmer,
          "cleanup returned both inbox buckets to their pre-run counts",
        );
      } catch (error) {
        failures++;
        console.error(
          `[cleanup] inbox count verification failed: ${(error as Error).message}`,
        );
      }
    }
  }

  if (failures > 0) {
    throw new Error(`MULTI-ENTRY VERIFY FAILED — ${failures} assertion(s)`);
  }
  console.log("\n🏁 MULTI-ENTRY LIVE VERIFY PASSED: exact array → 1 classic card → 1 Add to IOU → 2 History entries");
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    const primaryInFlight = primaryFailed || failures > failuresBefore;
    let cleanupFailure: unknown;
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryInFlight,
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
