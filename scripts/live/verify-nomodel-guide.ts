// Live regression for the two opposite propose boundaries:
//
//   A. No model + seam OFF -> guidance, never a raw JSON prompt or a card.
//   B. Model ready + URL seam ON + JSON prompt Cancel -> stop immediately: no inference,
//      no failure toast, and no card.
//
// Every interaction runs in a disposable tab. Each phase sends one nonce-tagged source, captures its
// exact sender-owned stable coordinates, and deletes it through the exact artifact scope before the
// tab closes. The script does not touch localStorage/IndexedDB or attach/clear a model.
import { chromium, type Dialog, type Locator, type Page } from "@playwright/test";
import { webcrypto } from "node:crypto";
import {
  exactOpenChatMessageWrapper,
  finalizeOpenChatArtifactCleanup,
  type OpenChatMessageRef,
  OpenChatArtifactScope,
} from "./openChatArtifactCleanup";
import { armManualExtractForCurrentUrl, TemporaryTabScope } from "./temporaryBrowserTab";
import { CDP_PORTS } from "./cdpPorts";

const OPENCHAT_URL = process.env.OPENCHAT_URL ?? "http://localhost:5003/chats";
const NO_MODEL_CDP = process.env.OC_NO_MODEL_CDP ?? `http://127.0.0.1:${CDP_PORTS.mother}`;
const NO_MODEL_CHAT = process.env.OC_NO_MODEL_CHAT ?? "manager";
const MODEL_READY_CDP = process.env.OC_MODEL_READY_CDP ?? `http://127.0.0.1:${CDP_PORTS.manager}`;
const MODEL_READY_CHAT = process.env.OC_MODEL_READY_CHAT ?? "father";
const GUIDE = /on-device model/i;

type ModelReadiness = {
  canInfer: boolean;
  native: boolean;
  capabilityAvailable: boolean;
  selectedModelId?: string;
  webStatus: string;
};

type CancelProbe = {
  promptCalls: number;
  prompts: string[];
  toastKinds: string[];
  webModelEvents: string[];
  initialWebStatus: string;
};

let failures = 0;
function check(condition: boolean, label: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} ${label}`);
  if (!condition) failures++;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sourcePage(cdp: string, label: string): Promise<Page> {
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().includes("5003"));
  if (!page) throw new Error(`${label} OpenChat page is unavailable at ${cdp}`);
  return page;
}

async function openExistingChat(page: Page, preferredChatName: string): Promise<string> {
  await page.waitForTimeout(2500);
  const summaries = page.locator(".chat-summary, .chat_summary");
  await summaries.first().waitFor({ state: "visible", timeout: 15000 });
  const preferred = summaries.filter({
    hasText: new RegExp(escapeRegex(preferredChatName), "i"),
  });
  const summary = (await preferred.count()) > 0 ? preferred.first() : summaries.first();
  const selected = (await summary.innerText()).trim().replace(/\s+/g, " ").slice(0, 100);
  await summary.click({ timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.locator(".ProseMirror").first().waitFor({ state: "visible", timeout: 15000 });
  return selected;
}

async function readModelReadiness(page: Page): Promise<ModelReadiness> {
  return page.evaluate(
    async ({ inferenceUrl, webInferenceUrl }) => {
      const inference = await import(/* @vite-ignore */ inferenceUrl);
      const webInference = await import(/* @vite-ignore */ webInferenceUrl);
      let webStatus = "unknown";
      const unsubscribe = webInference.webModelStatus.subscribe(
        (value: { status?: unknown }) => (webStatus = String(value.status ?? "unknown")),
      );
      unsubscribe();
      const capability = inference.onDeviceInferenceCapability();
      return {
        canInfer: Boolean(inference.canInferOnDevice()),
        native: "__TAURI_INTERNALS__" in window,
        capabilityAvailable: capability.available === true,
        selectedModelId:
          typeof capability.selectedModelId === "string" ? capability.selectedModelId : undefined,
        webStatus,
      };
    },
    {
      inferenceUrl: "/src/utils/onDeviceInference.ts",
      webInferenceUrl: "/src/utils/webInference.ts",
    },
  );
}

async function waitForModelState(page: Page, expected: boolean): Promise<ModelReadiness> {
  let consecutive = 0;
  let last = await readModelReadiness(page);
  for (let i = 0; i < 40; i++) {
    last = await readModelReadiness(page);
    consecutive = last.canInfer === expected ? consecutive + 1 : 0;
    // Avoid mistaking the short restore-on-startup window for "no model".
    if (consecutive >= 4) return last;
    await page.waitForTimeout(500);
  }
  return last;
}

type FreshSource = { text: string; message: OpenChatMessageRef };

async function sendFreshSource(
  page: Page,
  artifactScope: OpenChatArtifactScope,
  phase: string,
): Promise<FreshSource> {
  const nonce = `${Date.now()}-${webcrypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
  const text = `Propose boundary ${phase} ${nonce}`;
  artifactScope.expectExactText(text);
  const composer = page.locator(".ProseMirror").first();
  await composer.click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  return { text, message: await artifactScope.waitForExactTextMessage(text) };
}

/** Open Propose only from this run's exact sender-owned stable message wrapper. */
async function proposeExactMessage(page: Page, source: FreshSource): Promise<string> {
  const wrapper = exactOpenChatMessageWrapper(page, source.message);
  if ((await wrapper.count()) !== 1) throw new Error("fresh source wrapper is not unique");
  if (!(await wrapper.evaluate((node) => node.classList.contains("me")))) {
    throw new Error("fresh source wrapper is not sender-owned");
  }
  const bubble = wrapper.locator(".bubble-wrapper");
  if ((await bubble.count()) !== 1) throw new Error("fresh source bubble is not unique");
  await bubble.scrollIntoViewIfNeeded();
  await bubble.hover();
  const menu = bubble.locator(".menu-icon");
  if ((await menu.count()) !== 1) throw new Error("fresh source menu is not unique");
  await menu.click({ timeout: 5000 });
  const actions = page.getByText("Propose action", { exact: true });
  const visible: Locator[] = [];
  for (let index = 0; index < (await actions.count()); index++) {
    const action = actions.nth(index);
    if (await action.isVisible().catch(() => false)) visible.push(action);
  }
  if (visible.length !== 1) throw new Error(`expected one visible Propose action, found ${visible.length}`);
  await visible[0].click({ timeout: 5000 });
  return source.text;
}

async function guideAppears(page: Page): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => document.body.innerText);
    if (GUIDE.test(text)) return true;
  }
  return false;
}

async function verifyNoModelGuide(): Promise<void> {
  const source = await sourcePage(NO_MODEL_CDP, "no-model profile");
  const tabs = new TemporaryTabScope();
  let page: Page | undefined;
  let onDialog: ((dialog: Dialog) => void) | undefined;
  let artifactScope: OpenChatArtifactScope | undefined;
  let primaryFailed = false;
  const failuresBefore = failures;
  try {
    page = await tabs.open(source, OPENCHAT_URL);
    await openExistingChat(page, NO_MODEL_CHAT);
    const readiness = await waitForModelState(page, false);
    check(readiness.canInfer === false, `[no model/seam off] ${NO_MODEL_CDP} is model-unavailable`);
    if (readiness.canInfer) {
      throw new Error(
        `no-model precondition failed at ${NO_MODEL_CDP}; select OC_NO_MODEL_CDP without changing its model`,
      );
    }

    let dialogFired = false;
    onDialog = (dialog) => {
      dialogFired = true;
      void dialog.dismiss().catch(() => undefined);
    };
    page.on("dialog", onDialog);
    artifactScope = new OpenChatArtifactScope(page, "no-model guide regression");
    await artifactScope.begin();
    const sourceMessage = await sendFreshSource(page, artifactScope, "no-model");
    const beforeCards = await page.locator(".action-card").count();
    const target = await proposeExactMessage(page, sourceMessage);
    const guided = await guideAppears(page);
    const afterCards = await page.locator(".action-card").count();
    check(guided, `[no model/seam off] guidance appeared for: ${target}`);
    check(!dialogFired, "[no model/seam off] no raw JSON dialog appeared");
    check(afterCards === beforeCards, `[no model/seam off] no card was posted (${beforeCards} -> ${afterCards})`);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (page && onDialog) page.off("dialog", onDialog);
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryFailed || failures > failuresBefore,
        "no-model guide regression",
      );
    } finally {
      await tabs.close();
    }
  }
}

async function installCancelProbe(page: Page): Promise<CancelProbe> {
  // Execute as browser-native JavaScript. tsx/esbuild otherwise injects its Node-side __name
  // helper into these nested store callbacks, where the browser cannot resolve it.
  return page.evaluate(
    [
      "(async () => {",
      "  const { toastStore } = await import('/src/stores/toast.ts');",
      "  const { webModelStatus } = await import('/src/utils/webInference.ts');",
      "  const originalPrompt = window.prompt;",
      "  const probe = {",
      "    promptCalls: 0, prompts: [], toastKinds: [], webModelEvents: [],",
      "    initialWebStatus: 'unknown',",
      "  };",
      "  let toastPrimed = false;",
      "  const unsubscribeToast = toastStore.subscribe((value) => {",
      "    if (!toastPrimed) toastPrimed = true;",
      "    else if (value !== undefined) probe.toastKinds.push(String(value.kind ?? 'unknown'));",
      "  });",
      "  let modelPrimed = false;",
      "  const unsubscribeModel = webModelStatus.subscribe((value) => {",
      "    const status = String(value.status ?? 'unknown');",
      "    if (!modelPrimed) { modelPrimed = true; probe.initialWebStatus = status; }",
      "    else probe.webModelEvents.push(status);",
      "  });",
      "  window.prompt = (message) => {",
      "    probe.promptCalls++; probe.prompts.push(String(message ?? '')); return null;",
      "  };",
      "  window.__iouCancelProbe = {",
      "    ...probe,",
      "    cleanup: () => {",
      "      window.prompt = originalPrompt;",
      "      unsubscribeToast(); unsubscribeModel(); delete window.__iouCancelProbe;",
      "    },",
      "  };",
      "  const state = window.__iouCancelProbe;",
      "  Object.defineProperties(state, {",
      "    promptCalls: { get: () => probe.promptCalls, enumerable: true },",
      "    initialWebStatus: { get: () => probe.initialWebStatus, enumerable: true },",
      "  });",
      "  return { ...probe };",
      "})()",
    ].join("\n"),
  ) as Promise<CancelProbe>;
}

async function readCancelProbe(page: Page): Promise<CancelProbe> {
  return page.evaluate(() => {
    const state = (
      window as Window & { __iouCancelProbe?: CancelProbe & { cleanup: () => void } }
    ).__iouCancelProbe;
    if (!state) throw new Error("cancel probe is not installed");
    return {
      promptCalls: state.promptCalls,
      prompts: [...state.prompts],
      toastKinds: [...state.toastKinds],
      webModelEvents: [...state.webModelEvents],
      initialWebStatus: state.initialWebStatus,
    };
  });
}

async function removeCancelProbe(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const state = (
        window as Window & { __iouCancelProbe?: CancelProbe & { cleanup: () => void } }
      ).__iouCancelProbe;
      state?.cleanup();
    })
    .catch(() => undefined);
}

async function verifyModelReadyCancel(): Promise<void> {
  const source = await sourcePage(MODEL_READY_CDP, "model-ready profile");
  const tabs = new TemporaryTabScope();
  let page: Page | undefined;
  let probeInstalled = false;
  let artifactScope: OpenChatArtifactScope | undefined;
  let primaryFailed = false;
  const failuresBefore = failures;
  try {
    page = await tabs.open(source, OPENCHAT_URL, { manualExtract: true });
    await openExistingChat(page, MODEL_READY_CHAT);
    // Chat navigation may replace the search string; re-arm only this disposable tab's current URL.
    await armManualExtractForCurrentUrl(page);
    const readiness = await waitForModelState(page, true);
    check(readiness.canInfer, `[model ready/seam on] ${MODEL_READY_CDP} can infer`);
    check(readiness.capabilityAvailable, "[model ready/seam on] model capability reports available");
    check(
      typeof readiness.selectedModelId === "string" && readiness.selectedModelId.length > 0,
      `[model ready/seam on] selected model is ${readiness.selectedModelId ?? "missing"}`,
    );
    // The manager browser is deliberate: an attached-but-unloaded web model makes an attempted
    // inference observable as a loading/loaded/error lifecycle transition without invoking it.
    check(!readiness.native, "[model ready/seam on] profile is a browser model fixture");
    check(
      readiness.webStatus === "attached",
      `[model ready/seam on] disposable tab restored an attached model (${readiness.webStatus})`,
    );
    if (
      !readiness.canInfer ||
      !readiness.capabilityAvailable ||
      !readiness.selectedModelId ||
      readiness.native ||
      readiness.webStatus !== "attached"
    ) {
      throw new Error(
        `model-ready browser precondition failed at ${MODEL_READY_CDP}; the test will not alter the profile to manufacture it`,
      );
    }
    check(
      new URL(page.url()).searchParams.get("manualExtract") === "1",
      "[model ready/seam on] manual extraction is scoped to this disposable URL",
    );

    const initialProbe = await installCancelProbe(page);
    probeInstalled = true;
    check(
      initialProbe.initialWebStatus === "attached",
      `[model ready/seam on] inference probe starts attached (${initialProbe.initialWebStatus})`,
    );
    artifactScope = new OpenChatArtifactScope(page, "model-ready Cancel regression");
    await artifactScope.begin();
    // Cleanup is intentionally limited to the exact nonce-bearing source. If Cancel regresses and an
    // unexpected card appears, the assertions fail but cleanup retains that unbound card for
    // diagnosis: freshness alone cannot prove it belongs to this tab rather than another sender tab.
    const sourceMessage = await sendFreshSource(page, artifactScope, "cancel");
    const beforeCards = await page.locator(".action-card").count();
    const target = await proposeExactMessage(page, sourceMessage);
    await page.waitForTimeout(6000);
    const afterCards = await page.locator(".action-card").count();
    const probe = await readCancelProbe(page);

    check(probe.promptCalls === 1, `[model ready/seam on] JSON prompt opened once (${probe.promptCalls})`);
    check(
      probe.prompts.length === 1 && /fields as JSON/i.test(probe.prompts[0]),
      "[model ready/seam on] the dismissed prompt was the extraction JSON prompt",
    );
    check(
      afterCards === beforeCards,
      `[model ready/seam on] Cancel posted zero new cards (${beforeCards} -> ${afterCards}) for: ${target}`,
    );
    check(
      !probe.toastKinds.includes("failure"),
      `[model ready/seam on] Cancel emitted no failure toast (${probe.toastKinds.join(", ") || "none"})`,
    );
    const inferenceTransitions = probe.webModelEvents.filter((status) =>
      ["loading", "loaded", "error"].includes(status),
    );
    check(
      inferenceTransitions.length === 0,
      `[model ready/seam on] Cancel never started inference (${inferenceTransitions.join(" -> ") || "no lifecycle transition"})`,
    );
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (page && probeInstalled) await removeCancelProbe(page);
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryFailed || failures > failuresBefore,
        "model-ready Cancel regression",
      );
    } finally {
      await tabs.close();
    }
  }
}

async function main(): Promise<void> {
  await verifyNoModelGuide();
  await verifyModelReadyCancel();
  if (failures > 0) throw new Error(`PROPOSE BOUNDARY LIVE VERIFY FAILED - ${failures}`);
  console.log("PROPOSE BOUNDARY LIVE VERIFY PASSED: no-model guidance and model-ready Cancel are isolated");
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error("FAILED:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
