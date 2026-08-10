// Cross-repository live acceptance for per-chat routing.
//
// Drives the correct OpenChat surface inside each direct chat's settings page:
//   Father <-> mother  -> preserve the existing FatherMother destination
//   Father <-> manager -> explicitly choose Father IOU House
//
// The test proves that an already-connected user sees Open setup (not Connect), each invocation
// hands the launch URL from the OS-default browser to Father's already-authenticated IOU profile,
// scrubs the token before settings render, and persists different sheet destinations. Bearer tokens
// are never printed or saved; only in-memory hashes prove that the two launch URLs were distinct.
import { createHash } from "node:crypto";
import {
  chromium,
  type Locator,
  type Page,
} from "@playwright/test";

const FATHER_OPENCHAT_PORT = Number(process.env.FATHER_OPENCHAT_PORT || 19222);
const FATHER_IOU_PORT = Number(process.env.FATHER_IOU_PORT || 19231);
const OPENCHAT_URL = process.env.OPENCHAT_URL || "http://localhost:5003";
const IOU_ORIGIN = process.env.IOU_ORIGIN || "http://127.0.0.1:3000";

const TARGETS = [
  {
    counterpart: process.env.IOU_ROUTE_EXISTING_COUNTERPART || "mother",
    sheetLabel: process.env.IOU_ROUTE_EXISTING_LABEL || "FatherMother",
    preserveExisting: true,
  },
  {
    counterpart: process.env.IOU_ROUTE_HOUSE_COUNTERPART || "manager",
    sheetLabel: process.env.IOU_ROUTE_HOUSE_LABEL || "House",
    preserveExisting: false,
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

async function installNativeOpenCapture(openchat: Page): Promise<void> {
  await openchat.evaluate(`(() => {
    const scopedWindow = window;
    const iouOrigin = ${JSON.stringify(IOU_ORIGIN)};
    if (scopedWindow.__iouRoutingNativeOpenCapture !== undefined) {
      throw new Error("native setup capture is already installed");
    }
    const state = { urls: [], originalFetch: window.fetch };
    const recordUrl = (candidate) => {
      if (typeof candidate !== "string") return;
      try {
        const parsed = new URL(candidate);
        if (
          parsed.origin === iouOrigin &&
          /^#openchat-routing\\/[A-Za-z0-9_-]{43}$/.test(parsed.hash) &&
          !state.urls.includes(parsed.toString())
        ) state.urls.push(parsed.toString());
      } catch {
        // Ignore non-URL payload fields.
      }
    };
    const inspectPayload = (value) => {
      if (value == null) return;
      if (typeof value === "string") {
        try {
          inspectPayload(JSON.parse(value));
        } catch {
          recordUrl(value);
        }
        return;
      }
      if (value instanceof ArrayBuffer) {
        inspectPayload(new TextDecoder().decode(value));
        return;
      }
      if (ArrayBuffer.isView(value)) {
        inspectPayload(new TextDecoder().decode(value));
        return;
      }
      if (value instanceof Blob) {
        void value.text().then(inspectPayload).catch(() => undefined);
        return;
      }
      if (typeof value !== "object") return;
      const record = value;
      recordUrl(record.url);
      inspectPayload(record.payload);
    };

    window.fetch = function (...args) {
      inspectPayload(args[1]?.body);
      return state.originalFetch.apply(window, args);
    };

    const webview = window.chrome?.webview;
    if (webview !== undefined) {
      const originalPostMessage = webview.postMessage;
      webview.postMessage = function (message) {
        inspectPayload(message);
        return originalPostMessage.call(webview, message);
      };
      state.webview = { target: webview, originalPostMessage };
    }
    scopedWindow.__iouRoutingNativeOpenCapture = state;
  })()`);
}

async function takeNativeOpenUrl(openchat: Page): Promise<string> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const captured = await openchat.evaluate(
      `window.__iouRoutingNativeOpenCapture?.urls.shift()`,
    );
    if (typeof captured === "string") return captured;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Open setup did not invoke the native browser handoff");
}

async function removeNativeOpenCapture(openchat: Page): Promise<void> {
  await openchat.evaluate(`(() => {
    const scopedWindow = window;
    const state = scopedWindow.__iouRoutingNativeOpenCapture;
    if (state === undefined) return;
    window.fetch = state.originalFetch;
    if (state.webview !== undefined) {
      state.webview.target.postMessage = state.webview.originalPostMessage;
    }
    delete scopedWindow.__iouRoutingNativeOpenCapture;
  })()`).catch(() => undefined);
}

async function openDirectChatSettings(openchat: Page, counterpart: string): Promise<Locator> {
  await openchat.goto(`${OPENCHAT_URL}/chats`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await openchat.waitForTimeout(2500);
  await openchat.keyboard.press("Escape").catch(() => {});
  await openchat.waitForTimeout(500);
  const blockingOverlay = openchat.locator(".overlay").filter({ visible: true }).last();
  if (await blockingOverlay.isVisible().catch(() => false)) {
    const blocksPointer = await blockingOverlay.evaluate((element) =>
      getComputedStyle(element).pointerEvents !== "none" &&
      element.getBoundingClientRect().width > 0 &&
      element.getBoundingClientRect().height > 0,
    );
    if (blocksPointer) throw new Error("OpenChat chat list is still covered by an active overlay");
  }
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
  const headerName = openchat.getByRole("button", { name: counterpart, exact: true }).first();
  await headerName.click({ timeout: 10000 });
  await openchat.waitForTimeout(1800);

  const details = openchat.locator("body");
  const openSetup = openchat.getByRole("button", { name: "Open setup", exact: true });
  const loadedExpanded = await openSetup
    .waitFor({ state: "visible", timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  if (!loadedExpanded) {
    const aiApps = openchat.getByText("AI apps", { exact: true }).last();
    if (!(await aiApps.isVisible().catch(() => false))) {
      const diagnostic = await openchat.evaluate(() => ({
        url: location.href,
        buttons: [...document.querySelectorAll<HTMLElement>("button,[role=button]")]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .map((element) => (element.innerText || element.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 24),
        body: document.body.innerText.replace(/\s+/g, " ").slice(0, 300),
      }));
      throw new Error(`OpenChat details did not expose AI apps: ${JSON.stringify(diagnostic)}`);
    }
    await aiApps.click({ timeout: 5000 });
    await openchat.waitForTimeout(500);
  }

  check(
    !(await details.getByRole("button", { name: "Connect", exact: true }).isVisible().catch(() => false)),
    `${counterpart} chat does not ask the already-connected Father account to connect again`,
  );
  await openSetup.waitFor({ timeout: 10000 });
  check((await openSetup.count()) === 1, `${counterpart} exposes exactly one Open setup action`);
  check(true, `${counterpart} chat settings exposes AI apps -> Open setup`);
  return details;
}

async function waitForRoutingPage(page: Page): Promise<Page> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (page.url().startsWith(`${IOU_ORIGIN}/settings`)) {
      const heading = page.getByRole("heading", { name: "Chat routing", exact: true });
      const claimed = page.getByText(/This chat is ready\. Choose its account \/ sheet below\./i);
      if (
        await heading.isVisible().catch(() => false) &&
        await claimed.isVisible().catch(() => false)
      ) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Open setup was not redeemed in Father's authenticated IOU profile");
}

function normalizedLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function labelContainsWholePhrase(optionLabel: string, requestedLabel: string): boolean {
  const escaped = requestedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "iu").test(optionLabel);
}

async function verifyOrAssignFocusedRoute(
  iou: Page,
  counterpart: string,
  sheetLabel: string,
  preserveExisting: boolean,
): Promise<string> {
  await iou.getByText(/This chat is ready\. Choose its account \/ sheet below\./i).waitFor({
    timeout: 30000,
  });
  const location = await iou.evaluate(() => ({ pathname: window.location.pathname, hash: window.location.hash }));
  check(
    location.pathname === "/settings" && location.hash === "#openchat-routing",
    "IOU scrubbed the one-time token before rendering chat settings",
  );

  const select = iou.getByRole("combobox", {
    name: new RegExp(`^${counterpart} account or sheet$`, "i"),
  });
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
  if (preserveExisting) {
    check(
      (await select.inputValue()) === sheetId,
      `${counterpart} still points to the existing ${sheetLabel} destination`,
    );
    return sheetId;
  }
  check(
    (await select.inputValue()) === "",
    `${counterpart} starts with no destination selected`,
  );
  await select.selectOption({ value: sheetId });
  check((await select.inputValue()) === sheetId, `${counterpart} selected the current ${sheetLabel} sheet`);
  const row = select.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' card ')][1]",
  );
  await row.getByRole("button", { name: new RegExp(`^Link ${counterpart}$`, "i") }).click({ timeout: 10000 });
  await iou
    .getByText(new RegExp(`${counterpart} now routes to .*${sheetLabel}.*Other OpenChat chat links were not changed`, "i"))
    .waitFor({ timeout: 30000 });
  check(true, `saved only ${counterpart} to ${sheetLabel}`);
  return sheetId;
}

async function linkedSheetState(iou: Page): Promise<{
  binding: boolean;
  routes: Array<{ chatName: string | null; sheetId: string }>;
}> {
  return iou.evaluate(`(async () => {
    ${SETUP}
    const app = await window.__iouRoutingVerify;
    const binding = Boolean((await app.actor.get_openchat_binding())[0]);
    const routes = await app.actor.pending_chat_routes();
    const linkedRoutes = routes.flatMap((route) => {
      const wire = Array.isArray(route.current_sheet_id) ? route.current_sheet_id[0] : route.current_sheet_id;
      if (wire == null || route.has_current_link !== true) return [];
      const chatNameWire = Array.isArray(route.chat_name) ? route.chat_name[0] : route.chat_name;
      return [{
        chatName: typeof chatNameWire === 'string' ? chatNameWire : null,
        sheetId: BigInt(wire).toString(16).padStart(16, '0'),
      }];
    });
    return { binding, routes: linkedRoutes };
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

  try {
    await existingIou.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await existingIou.waitForTimeout(1500);
    const openchat = openchatSource;
    await openchat.goto(`${OPENCHAT_URL}/chats`, { waitUntil: "domcontentloaded" });
    await openchat.waitForTimeout(2000);
    const launchHashes = new Set<string>();
    const before = await linkedSheetState(existingIou);
    check(before.binding, "Father IOU account is connected to OpenChat before chat routing");
    check(before.routes.length === 1, "Father starts with exactly one existing linked chat");
    const existingMotherSheetId = before.routes[0].sheetId;
    const selectedSheetIds: string[] = [];

    for (const target of TARGETS) {
      const details = await openDirectChatSettings(openchat, target.counterpart);
      await installNativeOpenCapture(openchat);
      let launchUrl: string;
      try {
        await details.getByRole("button", { name: "Open setup", exact: true }).click({ timeout: 10000 });
        const modalOpen = openchat.getByRole("button", { name: /^Open (?:iou|in browser)$/i });
        await modalOpen.waitFor({ timeout: 15000 });
        await modalOpen.click();
        launchUrl = await takeNativeOpenUrl(openchat);
      } finally {
        await removeNativeOpenCapture(openchat);
      }
      const token = /^#openchat-routing\/([A-Za-z0-9_-]{43})$/.exec(new URL(launchUrl).hash)?.[1];
      if (token === undefined) throw new Error("native handoff returned an invalid setup URL");
      launchHashes.add(createHash("sha256").update(token, "utf8").digest("hex"));
      await existingIou.goto(launchUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const routingPage = await waitForRoutingPage(existingIou);
      check(true, `${target.counterpart} setup redeemed in Father's authenticated IOU profile`);
      selectedSheetIds.push(await verifyOrAssignFocusedRoute(
        routingPage,
        target.counterpart,
        target.sheetLabel,
        target.preserveExisting,
      ));
    }

    check(launchHashes.size === 2, "mother and manager used two distinct one-time setup URLs");
    check(
      new Set(selectedSheetIds).size === 2,
      "FatherMother and House resolved to two distinct current sheet IDs",
    );
    const after = await linkedSheetState(existingIou);
    check(after.binding, "per-chat setup preserved the existing OpenChat connection");
    check(
      after.routes.length === 2,
      "Father now has exactly two linked OpenChat chats",
    );
    const mother = after.routes.find((route) => route.chatName?.toLocaleLowerCase() === "mother");
    const manager = after.routes.find((route) => route.chatName?.toLocaleLowerCase() === "manager");
    check(mother?.sheetId === existingMotherSheetId, "mother kept the original FatherMother destination");
    check(manager?.sheetId === selectedSheetIds[1], "manager alone routes to House");
    console.log("PER-CHAT ROUTING LIVE VERIFY PASSED");
  } finally {
    await removeNativeOpenCapture(openchatSource);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
