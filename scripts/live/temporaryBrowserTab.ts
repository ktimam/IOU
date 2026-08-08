import type { Page } from "@playwright/test";

type TemporaryTabOptions = {
  manualExtract?: boolean;
  waitUntil?: "commit" | "domcontentloaded" | "load" | "networkidle";
};

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
  await page.evaluate(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("manualExtract", "1");
    window.history.replaceState(window.history.state, "", url);
  });
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
