import { test, expect, chromium, type BrowserContext, type Page, type Route, type Request } from "@playwright/test";
import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { mkdtempSync } from "node:fs";
import { createAccount } from "./flows";

// WebAuthn RP IDs are DNS names: localhost is secure, a bare IP is not a valid RP ID.
const ORIGIN = "http://localhost:4310";
const CANISTER = process.env.IOU_TEST_VAULT_CANISTER ?? "";
if (!CANISTER || Principal.fromText(CANISTER).toText() !== CANISTER || ["aaaaa-aa", "2vxsx-fae"].includes(CANISTER)) {
  throw new Error("Set IOU_TEST_VAULT_CANISTER to the canonical freshly installed local test canister ID");
}
const CONTROL = new URL(process.env.IOU_TEST_POCKETIC_CONTROL_URL ?? "");
const INSTANCE = process.env.IOU_TEST_POCKETIC_INSTANCE ?? "";
if (CONTROL.protocol !== "http:" || CONTROL.hostname !== "127.0.0.1" || !CONTROL.port || CONTROL.pathname !== "/" ||
  CONTROL.search || CONTROL.hash || CONTROL.username || CONTROL.password || !/^(0|[1-9][0-9]{0,5})$/.test(INSTANCE)) {
  throw new Error("Choose an explicit owned loopback PocketIC control URL and instance number");
}
const PAID = new Set(["acquire_account_root", "vetkd_wrap_consumer_key", "vetkd_wrap_sheet_key", "openchat_card_context", "openchat_private_match_context"]);
async function monitor(context: Pick<BrowserContext, "route"> & { on(event: "request", listener: (request: Request) => void): unknown }) {
  const paid: string[] = [], blocked: string[] = [], canisters = new Set<string>();
  await context.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && !(["localhost", "127.0.0.1"].includes(url.hostname) && ["4310", "4311", "49175"].includes(url.port))) {
      blocked.push(url.origin); await route.abort(); return;
    }
    const target = url.pathname.match(/\/canister\/([^/]+)\//)?.[1];
    if (target && target !== CANISTER) { blocked.push("unexpected local canister"); await route.abort(); return; }
    await route.continue();
  });
  context.on("request", request => {
    if (!request.url().includes("/api/")) return;
    const target = new URL(request.url()).pathname.match(/\/canister\/([^/]+)\//)?.[1];
    if (target) canisters.add(target);
    const bytes = request.postDataBuffer();
    if (!bytes) return;
    try {
      const body = Cbor.decode<{ content?: { method_name?: string } }>(bytes);
      const name = body.content?.method_name;
      if (name && PAID.has(name)) paid.push(name);
    } catch { /* Requests without CBOR are not canister calls. */ }
  });
  return { paid, blocked, canisters };
}
async function isolatedClock(method: "GET" | "POST", body?: string): Promise<Response> {
  const path = method === "GET" ? "read/get_time" : "update/set_time";
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(CONTROL.origin + "/instances/" + INSTANCE + "/" + path, {
      method, ...(body ? { headers: { "content-type": "application/json" }, body } : {}),
    });
    // PocketIC reports 409 while its local auto-progress operation owns the instance.
    // This retry is only for its clock administration, never for a paid canister call.
    if (response.status !== 409) {
      if (!response.ok) throw new Error("Isolated clock HTTP " + response.status + ": " + (await response.text()).slice(0, 250));
      return response;
    }
    await new Promise(resolve => setTimeout(resolve, 75 + attempt * 17));
  }
  throw new Error("The isolated PocketIC clock remained busy");
}
async function signIn(page: Page) {
  await page.goto(ORIGIN + "/sign-in");
  await page.getByRole("button", { name: /Sign in \(dev/ }).click();
  await expect(page.getByRole("heading", { name: "Account encryption", exact: true })).toBeVisible();
}
async function unlockCode(page: Page, identity: string, code: string) {
  await page.goto(ORIGIN + "/sign-in");
  await page.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Unlock account encryption", exact: true })).toBeVisible();
  await page.getByLabel("Recovery code", { exact: true }).fill(code);
  await page.getByRole("button", { name: "Unlock with recovery code", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
}
async function virtualPasskey(context: BrowserContext, page: Page) {
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true,
  } });
  return { session, authenticatorId };
}

test("real test-key bootstrap, reload/restart, code device, passkey, emergency and shared logout", async ({ browser }) => {
  if (process.env.IOU_TEST_ADVANCE_CLOCK !== "1") throw new Error("This isolated-only test requires explicit IOU_TEST_ADVANCE_CLOCK=1 permission to verify the 24-hour recovery cooldown");
  const profile = mkdtempSync("F:/Temp/OpenChat-IOU/account-vault-browser-");
  const options = { headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", baseURL: ORIGIN };
  let primary = await chromium.launchPersistentContext(profile, options);
  primary.setDefaultTimeout(25_000);
  let count = await monitor(primary);
  let page = primary.pages()[0] ?? await primary.newPage();
  page.on("pageerror", error => console.log("[local test page error]", error.message));
  console.log("[vault UI] sign in");
  await signIn(page);
  expect(count.paid).toEqual([]);
  await page.getByRole("button", { name: "Set up account encryption", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Protect access on other devices" })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  expect([...count.canisters]).toEqual([CANISTER]);
  console.log("[vault UI] verified latest local canister", CANISTER);
  console.log("[vault UI] real bootstrap completed");
  await page.getByRole("button", { name: "Create recovery code", exact: true }).click();
  const recoveryCode = await page.getByLabel("Recovery code — save privately").inputValue();
  expect(recoveryCode.length).toBeGreaterThan(30);
  await expect(page.getByText(/^Save the recovery code privately\./)).toBeVisible();
  await page.getByRole("button", { name: "I saved the code; hide it" }).click();
  const identity = await page.evaluate(() => localStorage.getItem("iou:dev:identity:v1"));
  expect(identity).toBeTruthy();
  const passkey = await virtualPasskey(primary, page);
  await page.getByRole("button", { name: "Add encryption passkey", exact: true }).click();
  await expect(page.getByText(/^Encryption passkey saved\./)).toBeVisible();
  console.log("[vault UI] code and PRF backups completed");
  await page.getByRole("button", { name: "Continue to IOU" }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
  const first = await createAccount(page, "Vault Alpha", "Vault First");
  console.log("[vault UI] first random-key sheet created");
  await page.getByRole("button", { name: "+ Add entry" }).click();
  const entry = page.getByRole("dialog");
  await entry.locator("select").first().selectOption("USD");
  await entry.locator('input[type="number"]').first().fill("37");
  await entry.getByRole("radio", { name: "Owed to you", exact: true }).check();
  await entry.getByRole("radio", { name: "IOU (owed, has due date)", exact: true }).check();
  await entry.locator('input[placeholder="lunch, taxi, etc."]').fill("encrypted vault acceptance");
  await entry.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await createAccount(page, "Vault Beta", "Vault Second");
  await page.goto(ORIGIN + "/sheet/" + first);
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  expect(count.blocked).toEqual([]);
  console.log("[vault UI] two sheets and entry reload completed");
  // The second device receives only synthetic authentication, NOT IndexedDB keys.
  const secondary = await browser.newContext();
  const secondaryCount = await monitor(secondary);
  const secondPage = await secondary.newPage();
  await unlockCode(secondPage, identity!, recoveryCode);
  await secondPage.goto(ORIGIN + "/sheet/" + first);
  await expect(secondPage.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(secondaryCount.paid).toEqual([]);
  console.log("[vault UI] clean second-device code unlock completed");
  await secondary.close();
  if (process.env.IOU_TEST_EMULATOR_CDP) {
    if (process.env.IOU_TEST_EMULATOR_CDP !== "http://127.0.0.1:49310") throw new Error("Only the scoped emulator debug port is allowed");
    const mobileBrowser = await chromium.connectOverCDP(process.env.IOU_TEST_EMULATOR_CDP);
    const mobileContext = mobileBrowser.contexts()[0];
    const mobile = await mobileContext.newPage();
    mobile.setDefaultTimeout(60_000);
    await mobile.bringToFront();
    const mobileSession = await mobileContext.newCDPSession(mobile);
    await mobileSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const mobileCount = await monitor(mobile);
    try {
      await unlockCode(mobile, identity!, recoveryCode);
      await mobile.goto(ORIGIN + "/sheet/" + first);
      await expect(mobile.getByText("encrypted vault acceptance", { exact: true })).toBeVisible({ timeout: 60_000 });
      await mobile.reload();
      await expect(mobile.getByText("encrypted vault acceptance", { exact: true })).toBeVisible({ timeout: 60_000 });
      await mobile.goto(ORIGIN + "/settings");
      await mobile.getByRole("button", { name: "Sign out", exact: true }).click();
      await mobile.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
      await mobile.goto(ORIGIN + "/pairs");
      await expect(mobile.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
      expect(mobileCount.paid).toEqual([]);
      expect(mobileCount.blocked).toEqual([]);
      console.log("[vault UI] Android emulator code unlock, cross-decrypt, reload and logout completed");
    } catch (error) {
      console.log("[vault mobile diagnostic]", JSON.stringify({ path: new URL(mobile.url()).pathname,
        headings: await mobile.locator("h1,h2,h3").allTextContents(), statuses: await mobile.getByRole("status").allTextContents() }));
      throw error;
    } finally {
      await mobileSession.detach();
      await mobile.close();
      // Never close the CDP browser: that would terminate unrelated emulator tabs.
    }
  }
  // Explicit signout erases the device vault. The same virtual passkey unlocks it without VetKD.
  await page.goto(ORIGIN + "/settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
  await page.getByRole("button", { name: "Unlock with encryption passkey", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  console.log("[vault UI] PRF unlock after explicit logout completed");
  await passkey.session.detach();
  await primary.close();
  primary = await chromium.launchPersistentContext(profile, options);
  primary.setDefaultTimeout(25_000);
  count = await monitor(primary);
  page = primary.pages()[0] ?? await primary.newPage();
  await page.goto(ORIGIN + "/sheet/" + first);
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual([]);
  console.log("[vault UI] actual browser restart restored encrypted entry");
  const anotherTab = await primary.newPage();
  await anotherTab.goto(ORIGIN + "/sheet/" + first);
  await expect(anotherTab.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  await page.goto(ORIGIN + "/settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(anotherTab.getByText("encrypted vault acceptance", { exact: true })).toHaveCount(0);
  await page.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
  expect(count.paid).toEqual([]);
  await page.getByText("Lost your encryption recovery methods?", { exact: true }).click();
  await page.getByRole("button", { name: "Recover encryption access (paid VetKD)", exact: true }).click();
  await expect(page.getByText("emergency root recovery is limited to once per 24 hours", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]); // Admission denied: no management derivation.
  const clock = await isolatedClock("GET");
  const currentTime = await clock.json() as { nanos_since_epoch: number };
  const advancedMilliseconds = Math.ceil(currentTime.nanos_since_epoch / 1_000_000) + 86_460_000;
  await isolatedClock("POST", '{"nanos_since_epoch":' + (BigInt(advancedMilliseconds) * 1_000_000n) + '}');
  // This is our dedicated desktop context, never the shared emulator context.
  await page.clock.setFixedTime(new Date(advancedMilliseconds));
  // No logout or reload: a definite rejection must permit a fresh explicit retry.
  await page.getByRole("button", { name: "Recover encryption access (paid VetKD)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
  await page.goto(ORIGIN + "/sheet/" + first);
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root", "acquire_account_root"]);
  expect(count.blocked).toEqual([]);
  console.log("[vault UI] cooldown denied without charge; explicit same-page retry after isolated +24h recovered the original ciphertext");
  await primary.close();
});
