// Cross-repository live acceptance for per-chat routing.
//
// Drives the correct OpenChat surface inside each direct chat's settings page:
//   Father <-> manager -> Father IOU House
//   Father <-> mother  -> Father IOU Family
//
// The test proves that an already-connected user sees Open setup (not Connect), each invocation
// opens Father's dedicated IOU browser profile, the launch token is scrubbed before settings render,
// and the two chats persist different sheet destinations. Bearer tokens are never printed or saved;
// only in-memory hashes are compared to prove that the two concrete launch URLs were distinct.
import { createHash } from "node:crypto";
import {
  chromium,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
} from "@playwright/test";
import { TemporaryTabScope } from "./temporaryBrowserTab";

const FATHER_OPENCHAT_PORT = Number(process.env.FATHER_OPENCHAT_PORT || 9222);
const FATHER_IOU_PORT = Number(process.env.FATHER_IOU_PORT || 9231);
const OPENCHAT_URL = process.env.OPENCHAT_URL || "http://localhost:5003";
const IOU_ORIGIN = process.env.IOU_ORIGIN || "http://127.0.0.1:3000";

const TARGETS = [
  {
    counterpart: process.env.IOU_ROUTE_HOUSE_COUNTERPART || "manager",
    sheetLabel: process.env.IOU_ROUTE_HOUSE_LABEL || "House",
  },
  {
    counterpart: process.env.IOU_ROUTE_FAMILY_COUNTERPART || "mother",
    sheetLabel: process.env.IOU_ROUTE_FAMILY_LABEL || "Family",
  },
] as const;

const SETUP = `window.__iouRoutingVerify = window.__iouRoutingVerify || (async () => {
  const secp = await import('/node_modules/.vite/deps/@dfinity_identity-secp256k1.js');
  const identity = secp.Secp256k1KeyIdentity.fromJSON(localStorage.getItem('iou:dev:identity:v1'));
  const auth = await import('/src/features/auth/AuthProvider.tsx');
  const decl = await import('/src/backend/declarations.ts');
  const agent = await auth.buildAgent(identity);
  return { actor: decl.createActor(agent) };
})();`;

function check(condition: boolean, label: string): void {
  if (!condition) throw new Error(label);
  console.log(`PASS - ${label}`);
}

function observeLaunchUrl(url: string, hashes: Set<string>): void {
  try {
    const parsed = new URL(url);
    const match = /^#openchat-routing\/([A-Za-z0-9_-]{43})$/.exec(parsed.hash);
    if (!match) return;
    hashes.add(createHash("sha256").update(match[1], "utf8").digest("hex"));
  } catch {
    // Ignore non-URL intermediate targets such as about:blank.
  }
}

function observeNewPages(context: BrowserContext, hashes: Set<string>): () => void {
  const navigationHandlers = new Map<Page, (frame: Frame) => void>();
  const onPage = (page: Page) => {
    observeLaunchUrl(page.url(), hashes);
    const onNavigation = (frame: Frame) => {
      if (frame === page.mainFrame()) observeLaunchUrl(frame.url(), hashes);
    };
    navigationHandlers.set(page, onNavigation);
    page.on("framenavigated", onNavigation);
  };
  context.on("page", onPage);
  return () => {
    context.off("page", onPage);
    for (const [page, onNavigation] of navigationHandlers) {
      page.off("framenavigated", onNavigation);
    }
    navigationHandlers.clear();
  };
}

async function openDirectChatSettings(openchat: Page, counterpart: string): Promise<Locator> {
  await openchat.goto(`${OPENCHAT_URL}/chats`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await openchat.waitForTimeout(2500);
  const row = openchat
    .locator(".chat-summary, .chat_summary")
    .filter({ hasText: new RegExp(`^\\s*${counterpart}\\b`, "i") })
    .first();
  await row.click({ timeout: 15000 });
  await openchat.waitForTimeout(1800);

  const masked = openchat.locator("#masked_overlay.active.visible");
  if (await masked.isVisible().catch(() => false)) {
    await masked.click({ position: { x: 5, y: 5 } }).catch(() => {});
    await openchat.waitForTimeout(400);
  }

  // Father runs the mobile/v2 desktop tree. Its chat-header title is the semantic route to the
  // direct-chat settings page (the message overflow menu is intentionally never touched).
  const headerName = openchat
    .locator(".container.section_header")
    .getByText(counterpart, { exact: true })
    .last();
  await headerName.click({ timeout: 10000 });
  const details = openchat.locator(".container.direct_chat_details");
  await details.waitFor({ timeout: 15000 });
  await openchat.waitForTimeout(1800);

  const openSetup = details.getByRole("button", { name: "Open setup", exact: true });
  if (!(await openSetup.isVisible().catch(() => false))) {
    await details.getByText("AI apps", { exact: true }).first().click({ timeout: 8000 });
    await openchat.waitForTimeout(500);
  }

  check(
    !(await details.getByRole("button", { name: "Connect", exact: true }).isVisible().catch(() => false)),
    `${counterpart} chat does not ask the already-connected Father account to connect again`,
  );
  await openSetup.waitFor({ timeout: 10000 });
  check(true, `${counterpart} chat settings exposes AI apps -> Open setup`);
  return details;
}

async function waitForRoutingPage(
  context: BrowserContext,
  pagesBefore: Set<Page>,
): Promise<Page> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const candidates = context.pages().filter((page) => !pagesBefore.has(page));
    for (const page of candidates) {
      if (!page.url().startsWith(`${IOU_ORIGIN}/settings`)) continue;
      const heading = page.getByRole("heading", { name: "Chat routing", exact: true });
      if (await heading.isVisible().catch(() => false)) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Open setup did not arrive in Father's dedicated IOU browser profile");
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function labelContainsWholePhrase(optionLabel: string, requestedLabel: string): boolean {
  const escaped = requestedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(optionLabel);
}

async function assignFocusedRoute(iou: Page, sheetLabel: string): Promise<string> {
  await iou.getByText(/This chat is ready\. Choose its account \/ sheet below\./i).waitFor({
    timeout: 30000,
  });
  const location = await iou.evaluate(() => ({ pathname: window.location.pathname, hash: window.location.hash }));
  check(
    location.pathname === "/settings" && location.hash === "#openchat-routing",
    "IOU scrubbed the one-time token before rendering chat settings",
  );

  const select = iou.locator("#openchat-routing select:focus");
  await select.waitFor({ timeout: 15000 });
  const options = await select.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      label: (node.textContent ?? "").trim().replace(/\s+/g, " "),
      value: (node as HTMLOptionElement).value,
    })),
  );
  const requested = normalizedLabel(sheetLabel);
  const candidates = options.filter((option) => {
    if (!option.value) return false;
    const visible = normalizedLabel(option.label);
    return visible === requested || visible.startsWith(`${requested} `) || labelContainsWholePhrase(visible, requested);
  });
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one current routing destination matching ${sheetLabel}; found ${candidates.length}`);
  }

  const sheetId = candidates[0].value;
  await select.selectOption({ value: sheetId });
  check((await select.inputValue()) === sheetId, `focused chat request selected the current ${sheetLabel} sheet`);
  const row = select.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' card ')][1]",
  );
  await row.getByRole("button", { name: /^(Link chat|Save destination)$/ }).click({ timeout: 10000 });
  await iou.getByText(/Chat destination saved\./i).waitFor({ timeout: 30000 });
  check(true, `saved this chat to ${sheetLabel}`);
  return sheetId;
}

async function linkedSheetState(iou: Page): Promise<{ binding: boolean; linkedSheetIds: string[] }> {
  return iou.evaluate(`(async () => {
    ${SETUP}
    const app = await window.__iouRoutingVerify;
    const binding = Boolean((await app.actor.get_openchat_binding())[0]);
    const routes = await app.actor.pending_chat_routes();
    const linkedSheetIds = routes.flatMap((route) => {
      const wire = Array.isArray(route.current_sheet_id) ? route.current_sheet_id[0] : route.current_sheet_id;
      if (wire == null || route.has_current_link !== true) return [];
      return [BigInt(wire).toString(16).padStart(16, '0')];
    });
    return { binding, linkedSheetIds };
  })()`);
}

async function main(): Promise<void> {
  const openchatBrowser = await chromium.connectOverCDP(
    `http://127.0.0.1:${FATHER_OPENCHAT_PORT}`,
  );
  const iouBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${FATHER_IOU_PORT}`);
  const openchatSource = openchatBrowser
    .contexts()[0]
    .pages()
    .find((page) => page.url().includes(":5003"));
  const iouContext = iouBrowser.contexts()[0];
  const existingIou = iouContext.pages().find((page) => page.url().includes(":3000"));
  if (!openchatSource || !existingIou) {
    throw new Error("Father OpenChat or IOU profile is unavailable");
  }

  const tabs = new TemporaryTabScope();
  const routingPages = new Set<Page>();
  let stopObservingLaunches = () => {};
  try {
    const openchat = await tabs.open(openchatSource, `${OPENCHAT_URL}/chats`);
    const launchHashes = new Set<string>();
    stopObservingLaunches = observeNewPages(iouContext, launchHashes);
    const before = await linkedSheetState(existingIou);
    check(before.binding, "Father IOU account is connected to OpenChat before chat routing");
    const selectedSheetIds: string[] = [];

    for (const target of TARGETS) {
      const details = await openDirectChatSettings(openchat, target.counterpart);
      const pagesBefore = new Set(iouContext.pages());
      await details.getByRole("button", { name: "Open setup", exact: true }).click({ timeout: 10000 });
      const modalOpen = openchat.getByRole("button", { name: "Open in browser", exact: true });
      await modalOpen.waitFor({ timeout: 15000 });
      await modalOpen.click();
      const routingPage = await waitForRoutingPage(iouContext, pagesBefore);
      routingPages.add(routingPage);
      try {
        check(true, `${target.counterpart} setup opened in Father's dedicated IOU browser profile`);
        selectedSheetIds.push(await assignFocusedRoute(routingPage, target.sheetLabel));
      } finally {
        await routingPage.close({ runBeforeUnload: false }).catch(() => {});
        routingPages.delete(routingPage);
      }
    }

    check(launchHashes.size === 2, "the two chats used two distinct one-time setup URLs");
    check(
      new Set(selectedSheetIds).size === 2,
      "House and Family resolved to two distinct current sheet IDs",
    );
    const after = await linkedSheetState(existingIou);
    check(after.binding, "per-chat setup preserved the existing OpenChat connection");
    check(
      selectedSheetIds.every((sheetId) => after.linkedSheetIds.includes(sheetId)),
      "Father's two chats persist two different sheet destinations",
    );
    console.log("PER-CHAT ROUTING LIVE VERIFY PASSED");
  } finally {
    stopObservingLaunches();
    for (const routingPage of routingPages) {
      await routingPage.close({ runBeforeUnload: false }).catch(() => {});
    }
    await tabs.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
