import { expect, test, type Page } from "@playwright/test";
import { createAccount, signInDev } from "./flows";

const HANDLE = "CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg";
const PENDING_ID = "ab".repeat(32);
const OLDER_PENDING_ID = "cd".repeat(32);
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

test("only the newest pending chat can be assigned, changed, and dismissed without exposing identifiers", async ({
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
    await expect(olderCard.getByRole("combobox")).toBeDisabled();
    await expect(olderCard.getByRole("button", { name: "Link chat" })).toBeDisabled();
    await expect(olderCard.getByText(/older anonymous requests cannot be reassigned/i)).toBeVisible();
    await olderCard.getByRole("button", { name: "Dismiss" }).click();
    await expect(routing.getByRole("heading", { name: "Earlier chat request 1" })).toHaveCount(0);

    const pending = recentCard.getByLabel("Most recent chat request account or sheet");
    await pending.selectOption({ label: "House" });
    await recentCard.getByRole("button", { name: "Link chat" }).click();
    await expect(routing.getByText("Pending chat linked: House")).toBeVisible();

    const saved = recentCard.getByLabel("Most recent chat request account or sheet");
    await expect(saved).toHaveValue("1111111111111111");
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

    await recentCard.getByRole("button", { name: "Remove link" }).click();
    await expect(routing.getByText("Chat link removed.")).toBeVisible();
    await recentCard.getByRole("button", { name: "Dismiss" }).click();
    await expect(routing.getByText("Recent chat request dismissed.")).toBeVisible();
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
