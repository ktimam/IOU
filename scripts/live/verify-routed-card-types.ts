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
  type Dialog,
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
  OPENCHAT_MESSAGE_TEXT_SELECTOR,
  OpenChatArtifactScope,
} from "./openChatArtifactCleanup";
import {
  armManualExtractForCurrentUrl,
  TemporaryTabScope,
} from "./temporaryBrowserTab";

const FATHER_OPENCHAT_PORT = Number(
  process.env.FATHER_OPENCHAT_PORT || CDP_PORTS.fatherOpenChat,
);
const OPENCHAT_URL = process.env.OPENCHAT_URL || "http://localhost:5003";

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
  await page.evaluate((observerTag) => {
    type ObserverState = {
      observer: MutationObserver;
      tag: string;
      nextId: number;
      baseline: Set<Element>;
      records: Record<string, string[]>;
    };
    const root = globalThis as typeof globalThis & { __iouRoutedCardObserver?: ObserverState };
    root.__iouRoutedCardObserver?.observer.disconnect();
    const state = {
      tag: observerTag,
      nextId: 0,
      baseline: new Set(document.querySelectorAll(".action-card")),
      records: {},
    } as Omit<ObserverState, "observer"> & { observer?: MutationObserver };
    const sample = () => {
      for (const card of document.querySelectorAll<HTMLElement>(".action-card")) {
        if (state.baseline.has(card)) continue;
        let id = card.dataset.iouRoutedCardId;
        if (!id) {
          id = `${observerTag}-${state.nextId++}`;
          card.dataset.iouRoutedCardId = id;
        }
        const text = card.innerText.replace(/\s+/g, " ").trim();
        const records = (state.records[id] ??= []);
        if (records.at(-1) !== text) records.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    state.observer = observer;
    root.__iouRoutedCardObserver = state as ObserverState;
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    sample();
  }, tag);
}

async function observedTransitions(page: Page, observerId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const root = globalThis as typeof globalThis & {
      __iouRoutedCardObserver?: { records: Record<string, string[]> };
    };
    return [...(root.__iouRoutedCardObserver?.records[id] ?? [])];
  }, observerId);
}

async function removeNewCardObserver(page: Page): Promise<void> {
  await page.evaluate(() => {
    const root = globalThis as typeof globalThis & {
      __iouRoutedCardObserver?: { observer: MutationObserver; tag: string };
    };
    const state = root.__iouRoutedCardObserver;
    state?.observer.disconnect();
    if (state) {
      for (const card of document.querySelectorAll<HTMLElement>(
        ".action-card[data-iou-routed-card-id]",
      )) {
        if (card.dataset.iouRoutedCardId?.startsWith(`${state.tag}-`)) {
          delete card.dataset.iouRoutedCardId;
        }
      }
    }
    delete root.__iouRoutedCardObserver;
  }).catch(() => {});
}

async function findAutoLoadedRunCard(page: Page, note: string): Promise<LoadedRunCard | null> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
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

async function openDirectChat(page: Page, counterpart: string): Promise<void> {
  await page.goto(`${OPENCHAT_URL}/chats`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2500);
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

async function proposeFreshRentCard(
  page: Page,
  message: string,
  note: string,
  artifactScope: OpenChatArtifactScope,
): Promise<void> {
  const beforeCards = await page.locator(".action-card").count();
  const extraction = JSON.stringify({
    kind: "iou",
    amount: 321,
    currency: "EGP",
    direction: "credit",
    note,
  });
  const onDialog = (dialog: Dialog) => {
    const response = /JSON/i.test(dialog.message()) ? extraction : "1";
    void dialog.accept(response).catch(() => {});
  };
  page.on("dialog", onDialog);
  try {
    const composer = page.locator(".ProseMirror").first();
    await composer.waitFor({ timeout: 15000 });
    await composer.click();
    await page.keyboard.type(message);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3200);
    const sourceMessage = await artifactScope.waitForExactTextMessage(message);
    const sourceText = exactOpenChatMessageWrapper(page, sourceMessage)
      .locator(OPENCHAT_MESSAGE_TEXT_SELECTOR)
      .first();

    const propose = page.locator('button:has(path[d^="M7.5,5.6"])').first();
    let sheetOpen = false;
    for (let attempt = 0; attempt < 3 && !sheetOpen; attempt++) {
      await page.waitForTimeout(2500);
      await sourceText.scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      await sourceText.click({ button: "right", timeout: 8000 }).catch(() => {});
      sheetOpen = await propose
        .waitFor({ state: "visible", timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      if (!sheetOpen) {
        const box = await sourceText.boundingBox();
        if (!box) continue;
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.waitForTimeout(900);
        await page.mouse.up();
        sheetOpen = await propose
          .waitFor({ state: "visible", timeout: 4000 })
          .then(() => true)
          .catch(() => false);
      }
      if (!sheetOpen) {
        await page.keyboard.press("Escape").catch(() => {});
        await page
          .locator("#masked_overlay")
          .click({ position: { x: 5, y: 5 }, timeout: 1500 })
          .catch(() => {});
      }
    }
    if (!sheetOpen) throw new Error("message action sheet did not expose Propose action");
    await propose.click();

    await page.waitForFunction(
      (count) => document.querySelectorAll(".action-card").length > count,
      beforeCards,
      { timeout: 45000 },
    );
    check(true, "fresh IOU card was proposed without reconnecting Father");
  } finally {
    page.off("dialog", onDialog);
  }
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
  artifactScope = new OpenChatArtifactScope(page, "routed-card private-type live proof");
  await artifactScope.begin();
  artifactScope.expectExactText(message);
  artifactScope.expectCardInputs([note]);
  const marker = `iou-routed-card-${Date.now()}`;
  let observerInstalled = false;
  let navigationListenerInstalled = false;
  let mainFrameNavigations = 0;
  const onNavigation = (frame: Frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations++;
  };
  try {
    await installNewCardObserver(page, marker);
    observerInstalled = true;
    await page.evaluate((value) => {
      (globalThis as typeof globalThis & { __iouRoutedDocumentMarker?: string })
        .__iouRoutedDocumentMarker = value;
    }, marker);
    page.on("framenavigated", onNavigation);
    navigationListenerInstalled = true;

    // A reused committed card cannot prove sender reconciliation. Always create one fresh card and
    // retain the same tagged DOM node from its optimistic state through verification and automatic loading.
    await proposeFreshRentCard(page, message, note, artifactScope);
    const loaded = await findAutoLoadedRunCard(page, note);
    check(loaded !== null, "the nonce-scoped sender card became directory-bound and loaded automatically");
    if (!loaded) throw new Error("this run's exact sender card never became actionable");
    await artifactScope.trackExactCard(loaded.card, [note]);

    const transitions = await observedTransitions(page, loaded.observerId);
    const sawOptimistic = transitions.some((value) => value.includes("Unverified card binding"));
    const sawVerified = transitions.some((value) => /^iou\s+Add to IOU\b/i.test(value));
    const markerSurvived = await page.evaluate((value) =>
      (globalThis as typeof globalThis & { __iouRoutedDocumentMarker?: string })
        .__iouRoutedDocumentMarker === value, marker);
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
    console.log("ROUTED CARD TYPE LIVE VERIFY PASSED");
  } finally {
    if (navigationListenerInstalled) page.off("framenavigated", onNavigation);
    if (observerInstalled) await removeNewCardObserver(page);
    await page.evaluate((value) => {
      const root = globalThis as typeof globalThis & { __iouRoutedDocumentMarker?: string };
      if (root.__iouRoutedDocumentMarker === value) delete root.__iouRoutedDocumentMarker;
    }, marker).catch(() => {});
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
