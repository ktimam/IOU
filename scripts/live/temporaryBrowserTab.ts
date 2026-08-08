import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";

type TemporaryTabOptions = {
  manualExtract?: boolean;
  waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
};

export type ManualPromptProbe = { promptCalls: number; prompts: string[] };
export type ManualPromptOverrideHandle = { ownerToken: string };

/**
 * Replaces window.prompt only inside a disposable QC tab. Returning the exact response
 * synchronously avoids Playwright's native-dialog auto-dismiss race, where a dialog event is seen
 * but the product receives null and correctly treats it as Cancel.
 */
export async function installManualPromptOverride(
  page: Page,
  exactResponse: string | null,
): Promise<ManualPromptOverrideHandle> {
  const ownerToken = randomUUID();
  const encodedOwnerToken = JSON.stringify(ownerToken);
  const response = JSON.stringify(exactResponse);
  // Browser-native source avoids tsx/esbuild injecting Node-only helpers into the callback.
  await page.evaluate(`(() => {
    const root = globalThis;
    if (root.__iouJourneyPromptProbe) {
      throw new Error("manual prompt override is already installed");
    }
    const state = {
      ownerToken: ${encodedOwnerToken},
      originalPrompt: window.prompt,
      replacementPrompt: undefined,
      promptCalls: 0,
      prompts: [],
    };
    const replacementPrompt = (message) => {
      state.promptCalls++;
      state.prompts.push(String(message ?? ""));
      return ${response};
    };
    state.replacementPrompt = replacementPrompt;
    root.__iouJourneyPromptProbe = state;
    window.prompt = replacementPrompt;
    if (window.prompt !== replacementPrompt) {
      delete root.__iouJourneyPromptProbe;
      throw new Error("manual prompt override could not be installed");
    }
  })()`);
  return { ownerToken };
}

export async function readManualPromptProbe(
  page: Page,
  handle: ManualPromptOverrideHandle,
): Promise<ManualPromptProbe> {
  const ownerToken = JSON.stringify(handle.ownerToken);
  return page.evaluate(`(() => {
    const state = globalThis.__iouJourneyPromptProbe;
    if (!state) throw new Error("manual prompt override is not installed");
    const ownerToken = ${ownerToken};
    if (state.ownerToken !== ownerToken || window.prompt !== state.replacementPrompt) {
      throw new Error("manual prompt override ownership changed");
    }
    return { promptCalls: state.promptCalls, prompts: [...state.prompts] };
  })()`);
}

export async function removeManualPromptOverride(
  page: Page,
  handle: ManualPromptOverrideHandle,
): Promise<void> {
  const ownerToken = JSON.stringify(handle.ownerToken);
  await page.evaluate(`(() => {
    const root = globalThis;
    const state = root.__iouJourneyPromptProbe;
    if (!state) throw new Error("manual prompt override is not installed");
    const ownerToken = ${ownerToken};
    if (state.ownerToken !== ownerToken || window.prompt !== state.replacementPrompt) {
      throw new Error("manual prompt override ownership changed");
    }
    window.prompt = state.originalPrompt;
    if (window.prompt !== state.originalPrompt) {
      throw new Error("manual prompt override could not restore original prompt");
    }
    delete root.__iouJourneyPromptProbe;
  })()`);
}

/**
 * Opens a disposable tab in the same signed-in browser context without navigating or mutating the
 * user's existing tab. The manual extraction seam is URL-scoped, so it cannot survive the tab.
 */
export async function openTemporaryTab(
  source: Page,
  targetUrl = source.url(),
  options: TemporaryTabOptions = {},
): Promise<Page> {
  const url = new URL(targetUrl);
  if (options.manualExtract) url.searchParams.set("manualExtract", "1");

  const page = await source.context().newPage();
  try {
    await page.goto(url.toString(), {
      waitUntil: options.waitUntil ?? "domcontentloaded",
    });
    return page;
  } catch (error) {
    await page.close({ runBeforeUnload: false }).catch(() => {});
    throw error;
  }
}

/** Re-adds the URL-only seam after an SPA navigation drops the search parameters. */
export async function armManualExtractForCurrentUrl(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("manualExtract", "1");
    window.history.replaceState(window.history.state, "", url);
  })()`);
}

export async function closeTemporaryTab(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.close({ runBeforeUnload: false }).catch(() => {});
}

/** Owns every disposable tab opened during a harness run and closes them in reverse order. */
export class TemporaryTabScope {
  private readonly pages: Page[] = [];

  async open(
    source: Page,
    targetUrl = source.url(),
    options: TemporaryTabOptions = {},
  ): Promise<Page> {
    const page = await openTemporaryTab(source, targetUrl, options);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    for (const page of this.pages.splice(0).reverse()) {
      await closeTemporaryTab(page);
    }
  }
}
