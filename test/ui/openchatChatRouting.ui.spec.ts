import { expect, test, type Page } from "@playwright/test";
import { createAccount, signInDev } from "./flows";

const HANDLE = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
const PENDING_ID = "ab".repeat(32);
const OLDER_PENDING_ID = "cd".repeat(32);
const TOKEN_FOR_RECENT = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
const TOKEN_FOR_OLDER = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";
const RAW_COORDINATE = /(?:group|channel|direct):/i;

async function withDevActor<T>(
  page: Page,
  operation: "set" | "remove" | "read",
  sheetId?: string,
): Promise<T> {
  return page.evaluate(
    async ({ handle, operation, sheetId: targetSheet }) => {
      const auth = await import("/src/features/auth/AuthProvider.tsx");
      const declarations = await import("/src/backend/declarations.ts");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("test page has no persisted dev identity");
      const actor = declarations.createActor(await auth.buildAgent(identity)) as any;
      if (operation === "set") {
        if (!targetSheet) throw new Error("set requires a sheet id");
        await actor.set_chat_sheet_link(handle, BigInt(`0x${targetSheet}`));
        return undefined as T;
      }
      if (operation === "remove") {
        await actor.remove_chat_sheet_link(handle);
        return undefined as T;
      }
      const links = (await actor.chat_sheet_links()) as Array<{
        chat_key: string;
        sheet_id: bigint;
      }>;
      return links.map((link) => ({
        chatHandle: link.chat_key,
        sheetId: link.sheet_id.toString(16).padStart(16, "0"),
      })) as T;
    },
    { handle: HANDLE, operation, sheetId },
  );
}

function expectRawFreeUrl(page: Page): void {
  const url = new URL(page.url());
  expect(url.search).toBe("");
  expect(url.hash).toBe("#openchat-routing");
  expect(page.url()).not.toContain(HANDLE);
  expect(page.url()).not.toContain(PENDING_ID);
  expect(page.url()).not.toMatch(RAW_COORDINATE);
}

test("two token-created pending chats route independently without exposing identifiers", async ({
  browser,
}) => {
  const fatherContext = await browser.newContext();
  const motherContext = await browser.newContext();
  await fatherContext.addInitScript(() =>
    sessionStorage.setItem("iou.test.chatRouting.viewer", "father"));
  await motherContext.addInitScript(() =>
    sessionStorage.setItem("iou.test.chatRouting.viewer", "mother"));
  const father = await fatherContext.newPage();
  const mother = await motherContext.newPage();

  try {
    await father.goto("/test/ui/chatRoutingHarness.html#openchat-routing");
    const routing = father.locator("#openchat-routing");
    await expect(routing.getByRole("heading", { name: "Chat routing" })).toBeVisible();
    const recentCard = routing.getByRole("heading", { name: "Most recent chat request" }).locator("..");
    const olderCard = routing.getByRole("heading", { name: "Earlier chat request 1" }).locator("..");
    await expect(recentCard).toBeVisible();
    await expect(olderCard).toBeVisible();
    await expect(olderCard.getByRole("combobox")).toBeEnabled();
    await olderCard.getByRole("combobox").selectOption({ label: "Child" });
    await olderCard.getByRole("button", { name: "Link chat" }).click();
    await expect(routing.getByText("Pending chat linked: Child")).toBeVisible();

    const pending = recentCard.getByLabel("Most recent chat request account or sheet");
    await pending.selectOption({ label: "House" });
    await recentCard.getByRole("button", { name: "Link chat" }).click();
    await expect(routing.getByText("Pending chat linked: House")).toBeVisible();

    const saved = recentCard.getByLabel("Most recent chat request account or sheet");
    await expect(saved).toHaveValue("1111111111111111");
    await expect(olderCard.getByRole("combobox")).toHaveValue("2222222222222222");
    await saved.selectOption({ label: "Child" });
    await recentCard.getByRole("button", { name: "Save destination" }).click();
    await expect(routing.getByText("Destination saved: Child")).toBeVisible();

    const visible = await routing.innerText();
    expect(visible).not.toContain(HANDLE);
    expect(visible).not.toContain(PENDING_ID);
    expect(visible).not.toContain(OLDER_PENDING_ID);
    expect(visible).not.toMatch(RAW_COORDINATE);
    expect(father.url()).not.toContain(HANDLE);
    expect(father.url()).not.toContain(PENDING_ID);
    expect(father.url()).not.toContain(OLDER_PENDING_ID);
    expect(father.url()).not.toMatch(RAW_COORDINATE);

    await olderCard.getByRole("button", { name: "Remove link" }).click();
    await expect(routing.getByText("Chat link removed.")).toBeVisible();
    await expect(recentCard.getByRole("combobox")).toHaveValue("2222222222222222");
    await olderCard.getByRole("button", { name: "Dismiss" }).click();
    await expect(routing.getByText("Chat request dismissed.")).toBeVisible();
    await expect(routing.getByRole("heading", { name: "Earlier chat request 1" })).toHaveCount(0);

    await recentCard.getByRole("button", { name: "Remove link" }).click();
    await expect(routing.getByText("Chat link removed.")).toBeVisible();
    await recentCard.getByRole("button", { name: "Dismiss" }).click();
    await expect(routing.getByText("Chat request dismissed.")).toBeVisible();
    await expect(routing.getByRole("heading", { name: "Most recent chat request" })).toHaveCount(0);

    await mother.goto("/test/ui/chatRoutingHarness.html#openchat-routing");
    const motherRouting = mother.locator("#openchat-routing");
    await expect(motherRouting.getByRole("heading", { name: "Chat routing" })).toBeVisible();
    await expect(
      motherRouting.getByRole("heading", { name: /Most recent chat request|Earlier chat request/ }),
    ).toHaveCount(0);
    expect(await motherRouting.innerText()).not.toContain(HANDLE);
    expect(await motherRouting.innerText()).not.toContain(PENDING_ID);
    expect(await motherRouting.innerText()).not.toContain(OLDER_PENDING_ID);
  } finally {
    await fatherContext.close();
    await motherContext.close();
  }
});

test("per-chat fragments are scrubbed and focus the exact claimed pending row", async ({ page }) => {
  await page.goto(`/test/ui/chatRoutingHarness.html#openchat-routing/${TOKEN_FOR_OLDER}`);
  await expect(page.locator("#openchat-routing")).toBeVisible();
  expectRawFreeUrl(page);
  await expect(page.getByLabel("Earlier chat request 1 account or sheet")).toBeFocused();
  expect(await page.locator("body").innerText()).not.toContain(TOKEN_FOR_OLDER);

  await page.goto(`/test/ui/chatRoutingHarness.html#openchat-routing/${TOKEN_FOR_RECENT}`);
  await expect(page.locator("#openchat-routing")).toBeVisible();
  expectRawFreeUrl(page);
  await expect(page.getByLabel("Most recent chat request account or sheet")).toBeFocused();
  expect(await page.locator("body").innerText()).not.toContain(TOKEN_FOR_RECENT);

  await page.goto("/test/ui/chatRoutingHarness.html#openchat-routing/not-a-token");
  await expect(page.locator("#openchat-routing")).toBeVisible();
  expectRawFreeUrl(page);
  expect(await page.locator("body").innerText()).not.toContain("not-a-token");
});

test("production claim is single-flight and keeps exact focus under React StrictMode", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("iou.test.chatRouting.productionClaim", "1"));
  await page.goto(`/test/ui/chatRoutingHarness.html#openchat-routing/${TOKEN_FOR_OLDER}`);

  const routing = page.locator("#openchat-routing");
  const refresh = routing.getByRole("button", { name: "Refresh" });
  await expect(routing.getByText("Verifying this chat setup link...")).toBeVisible();
  await expect(refresh).toBeDisabled();
  await refresh.evaluate((button: HTMLButtonElement) => button.click());
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __iouChatRoutingStats?: { claimCalls: number };
    }).__iouChatRoutingStats?.claimCalls,
  )).toBe(1);
  await page.evaluate(() =>
    (window as typeof window & { __iouReleaseChatRoutingClaim?: () => void })
      .__iouReleaseChatRoutingClaim?.());

  await expect(
    routing.getByText("This chat is ready. Choose its account / sheet below."),
  ).toBeVisible();
  const exactClaimedRow = routing.getByLabel("Earlier chat request 1 account or sheet");
  await expect(exactClaimedRow).toBeFocused();
  await expect(exactClaimedRow).toHaveValue("1111111111111111");
  expectRawFreeUrl(page);
  expect(await routing.innerText()).not.toContain(TOKEN_FOR_OLDER);
  expect(await page.evaluate(() =>
    (window as typeof window & {
      __iouChatRoutingStats?: { claimCalls: number; finishedCalls: number };
    }).__iouChatRoutingStats,
  )).toEqual({ claimCalls: 1, finishedCalls: 1 });
});

test("ambiguous claim retains the exact launch token until an idempotent manual retry succeeds", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("iou.test.chatRouting.ambiguousClaim", "1"));
  await page.goto(`/test/ui/chatRoutingHarness.html#openchat-routing/${TOKEN_FOR_OLDER}`);

  const routing = page.locator("#openchat-routing");
  await expect(
    routing.getByText("Chat setup could not be verified. Retry without copying or sharing the setup link."),
  ).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __iouAmbiguousChatRoutingStats?: {
        claimTokens: string[];
        finishedTokens: string[];
      };
    }).__iouAmbiguousChatRoutingStats,
  )).toEqual({ claimTokens: [TOKEN_FOR_OLDER], finishedTokens: [] });

  await routing.getByRole("button", { name: "Refresh" }).click();
  await expect(
    routing.getByText("This chat is ready. Choose its account / sheet below."),
  ).toBeVisible();
  await expect(
    routing.getByRole("heading", { name: "Most recent chat request" }),
  ).toHaveCount(1);
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & {
      __iouAmbiguousChatRoutingStats?: {
        claimTokens: string[];
        finishedTokens: string[];
      };
    }).__iouAmbiguousChatRoutingStats,
  )).toEqual({
    claimTokens: [TOKEN_FOR_OLDER, TOKEN_FOR_OLDER],
    finishedTokens: [TOKEN_FOR_OLDER],
  });
  expectRawFreeUrl(page);
  expect(await routing.innerText()).not.toContain(TOKEN_FOR_OLDER);
});

test("settings route is discoverable and caller-isolated while saved handles stay anonymous", async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const fatherContext = await browser.newContext();
  const motherContext = await browser.newContext();
  const father = await fatherContext.newPage();
  const mother = await motherContext.newPage();

  try {
    await signInDev(father);
    const houseSheet = await createAccount(father, "Routing House", "House sheet");

    await father.goto("/settings#openchat-routing", { waitUntil: "domcontentloaded" });
    const routing = father.locator("#openchat-routing");
    await expect(routing.getByRole("heading", { name: "Chat routing" })).toBeVisible();
    await expect(routing.getByText(/No chat is waiting for setup/i)).toBeVisible();
    await expect(routing.getByText(/connect again|reconnect/i)).toHaveCount(0);
    expectRawFreeUrl(father);

    await withDevActor(father, "set", houseSheet);
    await routing.getByRole("button", { name: "Refresh" }).click();
    await expect(routing.getByText(/No chat is waiting for setup/i)).toBeVisible();
    await expect(routing.getByRole("heading", { name: /Most recent chat request|Earlier chat request/ })).toHaveCount(0);
    await expect
      .poll(() =>
        withDevActor<Array<{ chatHandle: string; sheetId: string }>>(father, "read"))
      .toContainEqual({ chatHandle: HANDLE, sheetId: houseSheet });

    const visible = await routing.innerText();
    expect(visible).not.toContain(HANDLE);
    expect(visible).not.toContain(PENDING_ID);
    expect(visible).not.toMatch(RAW_COORDINATE);
    expectRawFreeUrl(father);

    await signInDev(mother);
    await mother.goto("/settings#openchat-routing", { waitUntil: "domcontentloaded" });
    const motherRouting = mother.locator("#openchat-routing");
    await expect(motherRouting.getByRole("heading", { name: "Chat routing" })).toBeVisible();
    await expect(motherRouting.getByRole("heading", { name: /Most recent chat request|Earlier chat request/ })).toHaveCount(0);
    await expect
      .poll(() =>
        withDevActor<Array<{ chatHandle: string; sheetId: string }>>(mother, "read"))
      .toEqual([]);
    expect(await motherRouting.innerText()).not.toContain(HANDLE);
    expectRawFreeUrl(mother);

    await withDevActor(father, "remove");
    await expect
      .poll(() =>
        withDevActor<Array<{ chatHandle: string; sheetId: string }>>(father, "read"))
      .not.toContainEqual(expect.objectContaining({ chatHandle: HANDLE }));
  } finally {
    await withDevActor(father, "remove").catch(() => undefined);
    await fatherContext.close();
    await motherContext.close();
  }
});
