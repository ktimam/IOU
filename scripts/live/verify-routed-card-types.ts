// Live private-card acceptance in Father's OpenChat desktop session.
//
// Prerequisites:
//   - Father <-> manager is routed to Father's House sheet.
//   - House has account-scoped type "Rent"; Family has "Family expense".
//
// The test proposes one fresh card in a disposable tab using OpenChat's explicit URL-only manual
// extraction seam, then deletes only that nonce-bound source/card and closes the disposable tab
// without changing Father's signed-in tab or installed model.
// It proves that the same sender card reconciles optimistic→verified/actionable in place, the
// trusted app UI loads automatically, durable host pairing hydrates only the routed account, and the
// unrelated Family type never reaches it.
import {
  chromium,
  type Frame,
  type FrameLocator,
  type Locator,
  type Page,
} from "@playwright/test";
import { webcrypto } from "node:crypto";
import { CDP_PORTS } from "./cdpPorts";
import {
  exactOpenChatMessageWrapper,
  finalizeOpenChatArtifactCleanup,
  type OpenChatMessageRef,
  OpenChatArtifactScope,
} from "./openChatArtifactCleanup";
import {
  armManualExtractForCurrentUrl,
  installManualPromptOverride,
  readManualPromptProbe,
  removeManualPromptOverride,
  TemporaryTabScope,
} from "./temporaryBrowserTab";

const FATHER_OPENCHAT_PORT = Number(
  process.env.FATHER_OPENCHAT_PORT || CDP_PORTS.fatherOpenChat,
);
const OPENCHAT_URL = process.env.OPENCHAT_URL || "http://localhost:5003";
// Public card fields render before a paired viewer completes two bounded private-context phases:
// the host capability mint and the IOU frame's redeem/decrypt/hydration acknowledgement.
const HOST_ADD_HYDRATION_TIMEOUT_MS = 65_000;

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
  console.log(`PASS - ${label}`);
}

type LoadedRunCard = {
  card: Locator;
  frame: FrameLocator;
  observerId: string;
  loadedAutomatically: boolean;
};

async function installNewCardObserver(page: Page, tag: string): Promise<void> {
  await page.evaluate(`((observerTag) => {
    const root = globalThis;
    root.__iouRoutedCardObserver?.observer.disconnect();
    const state = {
      tag: observerTag,
      nextId: 0,
      baseline: new Set(document.querySelectorAll(".action-card")),
      records: {},
      observer: undefined,
    };
    const sample = () => {
      for (const card of document.querySelectorAll(".action-card")) {
        if (state.baseline.has(card)) continue;
        let id = card.dataset.iouRoutedCardId;
        if (!id) {
          id = observerTag + "-" + state.nextId++;
          card.dataset.iouRoutedCardId = id;
        }
        const text = card.innerText.replace(/\\s+/g, " ").trim();
        const records = (state.records[id] ||= []);
        if (records.at(-1) !== text) records.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    state.observer = observer;
    root.__iouRoutedCardObserver = state;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    sample();
  })(${JSON.stringify(tag)})`);
}

async function observedTransitions(page: Page, observerId: string): Promise<string[]> {
  return page.evaluate(
    `(() => [...(globalThis.__iouRoutedCardObserver?.records[${JSON.stringify(observerId)}] ?? [])])()`,
  );
}

async function removeNewCardObserver(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const root = globalThis;
    const state = root.__iouRoutedCardObserver;
    state?.observer.disconnect();
    if (state) {
      for (const card of document.querySelectorAll(".action-card[data-iou-routed-card-id]")) {
        if (card.dataset.iouRoutedCardId?.startsWith(state.tag + "-")) {
          delete card.dataset.iouRoutedCardId;
        }
      }
    }
    delete root.__iouRoutedCardObserver;
  })()`).catch(() => {});
}

async function findAutoLoadedRunCard(page: Page, note: string): Promise<LoadedRunCard | null> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const actionFailures = await visibleMatches(
      page.locator(".toast").filter({ hasText: "Action failed" }),
    );
    if (actionFailures.length > 1) throw new Error("multiple action-failure notices are visible");
    if (actionFailures.length === 1) {
      const message = (await actionFailures[0].innerText()).replace(/\s+/g, " ").trim();
      throw new Error(`OpenChat rejected the proposed card: ${message}`);
    }
    const cards = page.locator(".action-card[data-iou-routed-card-id]");
    for (let index = 0; index < await cards.count().catch(() => 0); index++) {
      const card = cards.nth(index);
      const observerId = await card.getAttribute("data-iou-routed-card-id");
      if (!observerId || !(await card.isVisible().catch(() => false))) continue;
      const isIou =
        (await card.locator(".app-name").count().catch(() => 0)) === 1 &&
        (await card.locator(".app-name").innerText().catch(() => ""))
          .trim()
          .toLocaleLowerCase("en-US") === "iou";
      if (!isIou) continue;
      const untrusted = await card
        .getByText(/card content is untrusted|Untrusted card text/i)
        .first()
        .isVisible()
        .catch(() => false);
      if (untrusted) continue;
      if ((await card.locator("iframe").count()) === 0) {
        const obsoleteLoad = card.getByRole("button", { name: "Load app card", exact: true });
        if (await obsoleteLoad.isVisible().catch(() => false)) {
          throw new Error("manual Load app card gate is a regression");
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
      if (values.includes(note)) {
        return { card, frame, observerId, loadedAutomatically: true };
      }
    }
    await page.waitForTimeout(400);
  }
  return null;
}

async function dismissBlockingOpenChatOverlays(page: Page): Promise<void> {
  const hasBlockingOverlay = async (): Promise<boolean> =>
    Boolean(await page.evaluate(`(() => [...document.querySelectorAll(".overlay")].some((overlay) => {
      const rect = overlay.getBoundingClientRect();
      return getComputedStyle(overlay).pointerEvents !== "none" && rect.width > 0 && rect.height > 0;
    }))()`));
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await hasBlockingOverlay())) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  if (await hasBlockingOverlay()) {
    throw new Error("a fresh-tab OpenChat overlay still blocks chat selection");
  }
}

async function openDirectChat(page: Page, counterpart: string): Promise<void> {
  await page.goto(`${OPENCHAT_URL}/chats`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
  await dismissBlockingOpenChatOverlays(page);
  await page
    .locator(".chat-summary, .chat_summary")
    .filter({ hasText: new RegExp(`^\\s*${counterpart}\\b`, "i") })
    .first()
    .click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  const masked = page.locator("#masked_overlay.active.visible");
  if (await masked.isVisible().catch(() => false)) {
    await masked.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function optionLabels(select: ReturnType<Page["locator"]>): Promise<string[]> {
  return select.locator("option").allTextContents().then((values) => values.map((value) => value.trim()));
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const result: Locator[] = [];
  for (let index = 0; index < await locator.count(); index++) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) result.push(candidate);
  }
  return result;
}

async function exactlyOneVisible(locator: Locator, label: string): Promise<Locator> {
  const matches = await visibleMatches(locator);
  if (matches.length !== 1) throw new Error(`${label}: expected one visible match, found ${matches.length}`);
  return matches[0];
}

async function waitForExactCardCancellation(
  page: Page,
  message: OpenChatMessageRef,
  cancel: Locator,
): Promise<void> {
  const cancelled = exactOpenChatMessageWrapper(page, message).locator(
    ".action-card .state-cancelled",
  );

  // respondToActionCard commits before its promise settles, but the UI receives the new card state
  // through the chat-update poller. A disposable/background tab uses the one-minute idle interval,
  // so first wait for the host RPC to finish, then force one fresh chat load instead of timing out
  // against the foreground-only five-second poll cadence.
  const startedAt = Date.now();
  const settleDeadline = startedAt + 30_000;
  let sawBusy = false;
  let responseSettled = false;
  while (Date.now() < settleDeadline) {
    if (await cancelled.isVisible().catch(() => false)) return;
    if (!(await cancel.isVisible().catch(() => false))) {
      responseSettled = true;
      break;
    }
    if (!(await cancel.isEnabled().catch(() => false))) {
      sawBusy = true;
    } else if (sawBusy || Date.now() - startedAt >= 1_000) {
      responseSettled = true;
      break;
    }
    await page.waitForTimeout(100);
  }
  if (!responseSettled) {
    throw new Error("the exact card Cancel request did not settle");
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await cancelled.waitFor({ state: "visible", timeout: 30_000 });
}

async function waitForRoutedHostAddEnabled(
  loaded: LoadedRunCard,
  add: Locator,
  timeoutMs = HOST_ADD_HYDRATION_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await add.isEnabled().catch(() => false)) return;
    await loaded.card.page().waitForTimeout(Math.min(250, Math.max(1, deadline - Date.now())));
  }
  if (await add.isEnabled().catch(() => false)) return;

  const hostStatuses = await loaded.card.getByRole("status").allInnerTexts().catch(() => []);
  const hostAlerts = await loaded.card.getByRole("alert").allInnerTexts().catch(() => []);
  const appSignals = await loaded.frame
    .locator('[role="status"], [role="alert"]')
    .allInnerTexts()
    .catch(() => []);
  const restore = loaded.card.getByRole("button", { name: "Restore app data", exact: true });
  const restoreCount = await restore.count().catch(() => 0);
  const restoreState =
    restoreCount === 1
      ? `${(await restore.isVisible().catch(() => false)) ? "visible" : "hidden"}/${
          (await restore.isEnabled().catch(() => false)) ? "enabled" : "disabled"
        }`
      : `${restoreCount} matches`;
  const summarize = (values: string[]): string =>
    values.length === 0
      ? "none"
      : values
          .map((value) =>
            value
              .replace(/\s+/g, " ")
              .replace(/([?&](?:token|code|claim|credential)[^=]*)=[^\s&]+/gi, "$1=<redacted>")
              .replace(/\b[a-z0-9]{5}(?:-[a-z0-9]{3,5}){2,}\b/gi, "<id>")
              .slice(0, 160),
          )
          .slice(0, 4)
          .join(" | ");
  throw new Error(
    `paired host Add did not become ready within ${timeoutMs}ms; ` +
      `hostStatus=${summarize(hostStatuses)} hostAlert=${summarize(hostAlerts)} ` +
      `appSignals=${summarize(appSignals)} restore=${restoreState}`,
  );
}

async function cancelExactTrackedCardIfPending(
  page: Page,
  message: OpenChatMessageRef,
): Promise<boolean> {
  const wrapper = exactOpenChatMessageWrapper(page, message);
  if ((await wrapper.count()) !== 1) {
    throw new Error("the exact tracked card wrapper is unavailable or ambiguous during cleanup");
  }
  const card = wrapper.locator(".action-card");
  if ((await card.count()) !== 1) return false;
  if (await card.locator(".state-cancelled").isVisible().catch(() => false)) return false;
  const cancel = card.getByRole("button", { name: "Cancel", exact: true });
  if ((await cancel.count()) !== 1 || !(await cancel.isVisible().catch(() => false))) return false;
  const deadline = Date.now() + 10_000;
  while (!(await cancel.isEnabled().catch(() => false)) && Date.now() < deadline) {
    await page.waitForTimeout(100);
  }
  if (!(await cancel.isEnabled().catch(() => false))) return false;
  await cancel.click({ timeout: 10_000 });
  await waitForExactCardCancellation(page, message, cancel);
  return true;
}

async function openProposeAction(page: Page, message: OpenChatMessageRef): Promise<Locator> {
  const wrapper = exactOpenChatMessageWrapper(page, message);
  if ((await wrapper.count()) !== 1) throw new Error("exact source wrapper is unavailable");
  const classes = (await wrapper.getAttribute("class"))?.split(/\s+/) ?? [];
  const propose = page.getByRole("menuitem", { name: "Propose action", exact: true });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await page.keyboard.press("Escape").catch(() => {});
    if (classes.includes("message")) {
      const bubble = wrapper.locator(".bubble-wrapper");
      if ((await bubble.count()) !== 1) throw new Error("classic source bubble is ambiguous");
      await bubble.hover();
      await page.waitForTimeout(500);
      await (await exactlyOneVisible(bubble.locator(".menu-icon"), "classic source menu")).click({
        timeout: 10_000,
      });
    } else {
      const trigger = wrapper.locator(".message_bubble_wrapper > .menu-trigger");
      if ((await trigger.count()) !== 1) throw new Error("mobile source menu trigger is ambiguous");
      await trigger.scrollIntoViewIfNeeded();
      await trigger.dispatchEvent("click");
      await page.waitForTimeout(500);
      let menus = await visibleMatches(page.locator(".message_bubble_menu.second.me"));
      if (menus.length === 0) {
        const box = await trigger.boundingBox();
        if (!box) throw new Error("mobile source menu trigger has no bounds");
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
        menus = await visibleMatches(page.locator(".message_bubble_menu.second.me"));
      }
      if (menus.length !== 1) {
        throw new Error(`mobile source menu: expected one visible match, found ${menus.length}`);
      }
      await (
        await exactlyOneVisible(menus[0].locator(".menu-btn button"), "mobile source full menu")
      ).click({ timeout: 10_000 });
    }

    await page.waitForTimeout(250);
    const matches = await visibleMatches(propose);
    if (matches.length > 1) throw new Error("sender-owned Propose action is ambiguous");
    if (matches.length === 1) return matches[0];
    await page.waitForTimeout(750);
  }
  throw new Error("source message never became confirmed with an available Propose action");
}

async function proposeFreshRentCard(
  page: Page,
  message: string,
  artifactScope: OpenChatArtifactScope,
  promptOverride: Awaited<ReturnType<typeof installManualPromptOverride>>,
): Promise<void> {
  const composer = page.locator(".ProseMirror").first();
  await composer.waitFor({ timeout: 15000 });
  await composer.click();
  await page.keyboard.type(message);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(3200);
  const sourceMessage = await artifactScope.waitForExactTextMessage(message);
  await page.waitForTimeout(2500);
  const propose = await openProposeAction(page, sourceMessage);
  await propose.click();
  const promptDeadline = Date.now() + 10_000;
  let promptProbe = await readManualPromptProbe(page, promptOverride);
  while (promptProbe.promptCalls === 0 && Date.now() < promptDeadline) {
    await page.waitForTimeout(100);
    promptProbe = await readManualPromptProbe(page, promptOverride);
  }
  if (promptProbe.promptCalls !== 1) {
    throw new Error(
      `expected one manual-extraction prompt, found ${promptProbe.promptCalls}; prompts=${JSON.stringify(promptProbe.prompts)}`,
    );
  }
  check(true, "fresh IOU card proposal accepted one exact manual extraction");
}

async function main(): Promise<void> {
  const browser = await chromium.connectOverCDP(
    `http://127.0.0.1:${FATHER_OPENCHAT_PORT}`,
  );
  const source = browser.contexts()[0].pages().find((candidate) => candidate.url().includes(":5003"));
  if (!source) throw new Error("Father OpenChat desktop page is unavailable");
  const tabs = new TemporaryTabScope();
  let artifactScope: OpenChatArtifactScope | undefined;
  let primaryFailed = false;
  try {
  const page = await tabs.open(source, `${OPENCHAT_URL}/chats`, {
    manualExtract: true,
  });
  await openDirectChat(page, "manager");
  await armManualExtractForCurrentUrl(page);
  const nonce = `${Date.now()}-${webcrypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const message = `Rent live ${nonce}: 321 EGP due tomorrow`;
  const note = `rent live ${nonce}`;
  const extraction = JSON.stringify({
    kind: "iou",
    amount: 321,
    currency: "EGP",
    direction: "credit",
    date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    note,
    message,
  });
  artifactScope = new OpenChatArtifactScope(page, "routed-card private-type live proof");
  await artifactScope.begin();
  artifactScope.expectExactText(message);
  artifactScope.expectCardInputs([note]);
  const marker = `iou-routed-card-${Date.now()}`;
  let observerInstalled = false;
  let navigationListenerInstalled = false;
  let promptOverride: Awaited<ReturnType<typeof installManualPromptOverride>> | null = null;
  let mainFrameNavigations = 0;
  let cleanupCard: { loaded: LoadedRunCard; message: OpenChatMessageRef } | null = null;
  let innerSucceeded = false;
  const finalizePromptOverride = async (): Promise<void> => {
    if (!promptOverride) return;
    let failure: unknown;
    try {
      const finalPromptProbe = await readManualPromptProbe(page, promptOverride);
      if (finalPromptProbe.promptCalls !== 1) {
        throw new Error(
          `expected exactly one manual-extraction prompt at final teardown, found ${finalPromptProbe.promptCalls}: ${finalPromptProbe.prompts.join(" | ")}`,
        );
      }
    } catch (error) {
      failure = error;
    }
    try {
      await removeManualPromptOverride(page, promptOverride);
    } catch (error) {
      failure ??= error;
    }
    promptOverride = null;
    if (failure !== undefined) throw failure;
  };
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations++;
  };
  try {
    await installNewCardObserver(page, marker);
    observerInstalled = true;
    await page.evaluate(
      `globalThis.__iouRoutedDocumentMarker = ${JSON.stringify(marker)}`,
    );
    page.on("framenavigated", onNavigation);
    navigationListenerInstalled = true;
    promptOverride = await installManualPromptOverride(page, extraction);

    // A reused committed card cannot prove sender reconciliation. Always create one fresh card and
    // retain the same tagged DOM node from its optimistic state through verification and automatic loading.
    await proposeFreshRentCard(page, message, artifactScope, promptOverride);
    const loaded = await findAutoLoadedRunCard(page, note);
    check(loaded !== null, "the nonce-scoped sender card became directory-bound and loaded automatically");
    if (!loaded) throw new Error("this run's exact sender card never became actionable");
    const cardMessage = await artifactScope.trackExactCard(loaded.card, [note]);
    cleanupCard = { loaded, message: cardMessage };

    const transitions = await observedTransitions(page, loaded.observerId);
    const sawOptimistic = transitions.some((value) => value.includes("Unverified card binding"));
    const sawVerified = transitions.some((value) => /^iou\s+Add to IOU\b/i.test(value));
    const markerSurvived = Boolean(
      await page.evaluate(
        `globalThis.__iouRoutedDocumentMarker === ${JSON.stringify(marker)}`,
      ),
    );
    check(sawOptimistic, "the sender card was observed in its optimistic/unverified state");
    check(sawVerified, "the same sender card became directory-bound");
    check(loaded.loadedAutomatically, "that exact trusted card loaded without a manual gate");
    check(
      markerSurvived && mainFrameNavigations === 0,
      "sender optimistic-to-verified reconciliation completed in-place without navigation",
    );
    if (!sawOptimistic || !sawVerified || !loaded.loadedAutomatically || !markerSurvived || mainFrameNavigations !== 0) {
      throw new Error("sender card did not reconcile from optimistic to actionable in place");
    }

    const add = loaded.card.getByRole("button", { name: "Add to IOU", exact: true });
    await add.waitFor({ state: "visible", timeout: 20_000 });
    await waitForRoutedHostAddEnabled(loaded, add);
    check(await add.isEnabled(), "the verified sender card has one host-owned action without reload");
    check(
      (await loaded.frame.getByRole("button").count()) === 0,
      "the private card iframe exposes values but owns no confirmation button",
    );
    const logo = loaded.card.locator("img.app-icon");
    await logo.waitFor({ state: "visible", timeout: 10_000 });
    check(
      (await logo.getAttribute("src")) === "http://127.0.0.1:3000/favicon.svg",
      "trusted card renders the authoritative IOU logo",
    );
    const typeControl = loaded.frame.getByLabel("Type", { exact: true });
    const dateControl = loaded.frame.getByLabel("Date", { exact: true });
    await typeControl.waitFor({ timeout: 10_000 });
    await dateControl.waitFor({ timeout: 10_000 });
    check((await typeControl.inputValue()) === "iou", "the app card exposes its IOU Type from first render");
    check(/^\d{4}-\d{2}-\d{2}$/.test(await dateControl.inputValue()), "the app card exposes an editable Date");
    const accountType = loaded.frame.getByLabel("Saved type", { exact: true });
    await accountType.waitFor({ timeout: 10_000 });
    await accountType
      .locator("option", { hasText: "Rent" })
      .waitFor({ state: "attached", timeout: 30_000 });
    const after = await optionLabels(accountType);
    check(after.includes("Rent"), "House-routed IOU card displays the House Type Rent");
    check(
      !after.includes("Family expense"),
      "House-routed IOU card does not expose the Family account Type",
    );
    const selected = await accountType.locator("option:checked").textContent();
    check(selected?.trim() === "Rent", "the rent message auto-selects the routed Rent Type");
    check(
      !(await loaded.card.getByRole("button", { name: "Share app context", exact: true }).isVisible().catch(() => false)),
      "durable pairing hydrates routed private context without another consent click",
    );
    check(
      !(await loaded.card.getByRole("button", { name: "Load app card", exact: true }).isVisible().catch(() => false)),
      "trusted card does not show the obsolete manual load gate",
    );
    check(
      !(await loaded.card
        .getByText(/Loading contacts this external origin|If you separately grant private context|Capabilities never enter this URL/i)
        .first()
        .isVisible()
        .catch(() => false)),
      "trusted card hides protocol explanation text",
    );
    check(
      (await loaded.card.locator(".card-url").textContent().catch(() => ""))?.includes("/openchat/card") === true,
      "trusted card keeps the exact app URL visible",
    );
    check(
      !(await loaded.card.getByRole("button", { name: "Connect", exact: true }).isVisible().catch(() => false)),
      "loading private Type context does not ask Father to connect again",
    );
    check(mainFrameNavigations === 0, "private-context hydration also stayed in the same chat document");
    // No later step can legitimately ask for extraction. Verify the full proposal/card interval and
    // restore prompt before the cancellation fallback is allowed to reload this disposable tab.
    await finalizePromptOverride();
    const cancel = loaded.card.getByRole("button", { name: "Cancel", exact: true });
    await cancel.waitFor({ state: "visible", timeout: 10_000 });
    check(await cancel.isEnabled(), "the exact pending proof card exposes its host-owned Cancel action");
    await cancel.click();
    await waitForExactCardCancellation(page, cardMessage, cancel);
    check(true, "the exact proof card was cancelled before message cleanup");
    console.log("ROUTED CARD TYPE LIVE VERIFY PASSED");
    innerSucceeded = true;
  } finally {
    let promptTeardownFailure: unknown;
    await finalizePromptOverride().catch((error) => {
      promptTeardownFailure = error;
    });
    if (!innerSucceeded && cleanupCard !== null) {
      try {
        const cancelled = await cancelExactTrackedCardIfPending(page, cleanupCard.message);
        console.log(
          cancelled
            ? `[cleanup] cancelled exact pending routed card ${cleanupCard.message.messageId}`
            : `[cleanup] exact routed card ${cleanupCard.message.messageId} was no longer cancellable`,
        );
      } catch (error) {
        console.error(
          `[cleanup] exact routed-card cancellation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (navigationListenerInstalled) page.off("framenavigated", onNavigation);
    if (observerInstalled) await removeNewCardObserver(page);
    await page
      .evaluate(`(() => {
        if (globalThis.__iouRoutedDocumentMarker === ${JSON.stringify(marker)}) {
          delete globalThis.__iouRoutedDocumentMarker;
        }
      })()`)
      .catch(() => {});
    if (promptTeardownFailure !== undefined) throw promptTeardownFailure;
  }
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryFailed,
        "routed-card private-type live proof",
      );
    } finally {
      await tabs.close();
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
