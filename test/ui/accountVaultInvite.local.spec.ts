import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createAccount, closeAndStartNewSheet, openSheet } from "./flows";

const ORIGIN = "http://localhost:4310";
const HOST = "http://127.0.0.1:49175";
const CANISTER = process.env.IOU_TEST_VAULT_CANISTER;
if (!CANISTER || Principal.fromText(CANISTER).toText() !== CANISTER || CANISTER === "2vxsx-fae") {
  throw new Error("IOU_TEST_VAULT_CANISTER must explicitly name the canonical isolated local canister principal");
}
const NAME = "Synthetic shared vault sheet";
const NOTE = "Synthetic shared vault invitation entry";
const NEXT_NOTE = "Synthetic second shared vault sheet entry";
const PAID = new Set(["acquire_account_root", "vetkd_wrap_consumer_key", "vetkd_wrap_sheet_key", "openchat_card_context", "openchat_private_match_context"]);

async function monitor(context: BrowserContext) {
  const paid: string[] = [], methods: string[] = [], blocked: string[] = [];
  await context.addInitScript(() => performance.setResourceTimingBufferSize(3000));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const allowed = (url.origin === ORIGIN || url.origin === HOST) &&
      (!url.pathname.includes("/canister/") || url.pathname.includes(`/canister/${CANISTER}/`));
    if (["http:", "https:"].includes(url.protocol) && !allowed) { blocked.push(url.origin); await route.abort(); return; }
    await route.continue();
  });
  context.on("request", request => {
    if (!request.url().startsWith(HOST + "/api/")) return;
    const data = request.postDataBuffer(); if (!data) return;
    try {
      const method = Cbor.decode<{ content?: { method_name?: string } }>(data).content?.method_name;
      if (method) { methods.push(method); if (PAID.has(method)) paid.push(method); }
    } catch { /* Not a canister method call. */ }
  });
  return { paid, methods, blocked };
}

async function bootstrap(page: Page) {
  await page.goto(ORIGIN + "/sign-in");
  expect(await page.evaluate(async ({ host, canister }) => {
    const path = "/src/features/auth/config.ts"; const config = await import(/* @vite-ignore */ path);
    return config.host === host && config.canisterId === canister;
  }, { host: HOST, canister: CANISTER })).toBe(true);
  await page.getByRole("button", { name: /Sign in \(dev/ }).click();
  await expect(page.getByRole("heading", { name: "Account encryption", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Set up account encryption", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Protect access on other devices" })).toBeVisible();
  await page.getByRole("button", { name: "Continue to IOU", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
}

async function addSyntheticEntry(page: Page, amount: string, note: string) {
  await page.getByRole("button", { name: "+ Add entry", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add entry", exact: true })).toBeVisible();
  await dialog.locator("select").first().selectOption("USD");
  await dialog.locator('input[type="number"]').first().fill(amount);
  await dialog.getByRole("radio", { name: "Owed to you", exact: true }).check();
  await dialog.getByRole("radio", { name: /IOU \(owed/ }).check();
  await dialog.locator('input[placeholder="lunch, taxi, etc."]').fill(note);
  await dialog.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** Run inside each synthetic browser; only booleans and public IDs leave it. */
async function inspectSheet(page: Page, sheetId: string, note: string) {
  return page.evaluate(async ({ sheetId, note }) => {
    const module = (path: string) => {
      const loaded = performance.getEntriesByType("resource").map(entry => entry.name).reverse().find(name => new URL(name).pathname === path);
      return import(/* @vite-ignore */ loaded ?? path);
    };
    const [identityModule, auth, declarations, sheets, cryptoModule, types] = await Promise.all([
      module("/node_modules/.vite/deps/@dfinity_identity-secp256k1.js"), module("/src/features/auth/AuthProvider.tsx"), module("/src/backend/declarations.ts"),
      module("/src/features/crypto/vaultSheets.ts"), module("/src/features/crypto/devVetkd.ts"), module("/src/features/entries/types.ts"),
    ]);
    const identity = identityModule.Secp256k1KeyIdentity.fromJSON(localStorage.getItem("iou:dev:identity:v1"));
    const actor = declarations.createActor(await auth.buildAgent(identity));
    if (await actor.get_vetkd_key_name() !== "dfx_test_key") throw new Error("Synthetic test refuses a production VetKD key");
    const sheet = (await actor.get_sheet(sheetId))[0];
    const info = await actor.get_sheet_key_info(sheetId);
    if (!sheet || !info.Ok) throw new Error("Synthetic shared sheet is unavailable");
    const key = await sheets.readVaultSheetKey(actor, identity.getPrincipal().toText(), sheetId);
    try {
      const result = await actor.list_entries(sheetId, [], 100);
      let found = false;
      for (const entry of result.entries) {
        if (new TextDecoder().decode(new Uint8Array(entry.ciphertext)).includes(note)) throw new Error("Ledger stored plaintext");
        const plaintext = await cryptoModule.decryptEntryPayload(new Uint8Array(entry.entry_key), new Uint8Array(entry.iv), new Uint8Array(entry.ciphertext), key);
        try { if (types.decodeEntry(plaintext).note === note) found = true; } finally { plaintext.fill(0); }
      }
      return { scheme: info.Ok.scheme, keyId: info.Ok.key_id, found,
        bothWrapped: sheet.wrapped_key_a.length > 0 && sheet.wrapped_key_b.length > 0 };
    } finally { key.fill(0); }
  }, { sheetId, note });
}

test("encrypted invite joins a second vault account and both recipients read the next random sheet without paid sheet recovery", async ({ browser }) => {
  const creatorContext = await browser.newContext({ baseURL: ORIGIN });
  const recipientContext = await browser.newContext({ baseURL: ORIGIN });
  try {
    const creatorCalls = await monitor(creatorContext), recipientCalls = await monitor(recipientContext);
    const creator = await creatorContext.newPage(), recipient = await recipientContext.newPage();
    await bootstrap(creator); await bootstrap(recipient);
    expect(creatorCalls.paid).toEqual(["acquire_account_root"]);
    expect(recipientCalls.paid).toEqual(["acquire_account_root"]);
    const firstId = await createAccount(creator, "Synthetic shared vault account", NAME);
    await addSyntheticEntry(creator, "12.50", NOTE);
    await expect(creator.getByText(NOTE, { exact: true })).toBeVisible();

    // The real modal invokes createVaultInvite. Transfer its fragment capability
    // only in memory; close the modal before assertions so it cannot enter artifacts.
    await creator.getByRole("button", { name: /Invite/ }).click();
    const inviteDialog = creator.getByRole("dialog");
    await expect(inviteDialog.getByRole("heading", { name: "Invite to this account" })).toBeVisible();
    let link = await inviteDialog.locator("textarea").inputValue();
    await inviteDialog.getByRole("button", { name: "Close", exact: true }).click();
    const parsed = new URL(link), fragment = new URLSearchParams(parsed.hash.slice(1));
    expect(parsed.origin === ORIGIN && parsed.pathname === "/pair/accept" && fragment.get("v") === "1" && fragment.has("u") && !fragment.has("k")).toBe(true);
    // Navigating in-page keeps the secret out of Playwright goto call-log URLs.
    await recipient.evaluate(url => { location.assign(url); }, link); link = "";
    await expect(recipient.getByRole("heading", { name: /You've been invited/ })).toBeVisible();
    await expect.poll(() => new URL(recipient.url()).hash.length).toBe(0);
    await recipient.getByRole("button", { name: /Accept invite/ }).click();
    await recipient.waitForURL("**/sheet/**");
    expect(new URL(recipient.url()).pathname).toBe(`/sheet/${firstId}`);
    await expect(recipient.getByText(NAME, { exact: true })).toBeVisible();
    await expect(recipient.getByText(NOTE, { exact: true })).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByText(NOTE, { exact: true })).toBeVisible();
    const first = await inspectSheet(recipient, firstId, NOTE);
    expect(first.scheme).toBe("random-v2"); expect(first.found && first.bothWrapped).toBe(true);
    expect(creatorCalls.methods).toContain("set_sheet_invite_envelope");
    expect(recipientCalls.methods).toContain("get_sheet_invite_envelope");
    expect(recipientCalls.methods).toContain("accept_invite");

    // Refresh creator membership, then exercise the actual close-and-start-new
    // flow. The archived first sheet remains intact and gets a distinct successor.
    await creator.reload();
    await expect(creator.getByText(NOTE, { exact: true })).toBeVisible();
    const nextId = await closeAndStartNewSheet(creator);
    expect(nextId === firstId).toBe(false);
    await addSyntheticEntry(creator, "2.75", NEXT_NOTE);
    await expect(creator.getByText(NEXT_NOTE, { exact: true })).toBeVisible();
    expect(await openSheet(recipient)).toBe(nextId);
    await expect(recipient.getByText(NEXT_NOTE, { exact: true })).toBeVisible();
    await recipient.reload();
    await expect(recipient.getByText(NEXT_NOTE, { exact: true })).toBeVisible();
    const nextCreator = await inspectSheet(creator, nextId, NEXT_NOTE);
    const nextRecipient = await inspectSheet(recipient, nextId, NEXT_NOTE);
    expect(nextCreator).toEqual(nextRecipient);
    expect(nextCreator.scheme).toBe("random-v2"); expect(nextCreator.found && nextCreator.bothWrapped).toBe(true);
    expect(nextCreator.keyId === first.keyId).toBe(false);
    expect((await inspectSheet(recipient, firstId, NOTE)).found).toBe(true);
    expect(creatorCalls.methods.filter(method => method === "create_sheet_v2")).toHaveLength(2);
    expect(creatorCalls.paid).toEqual(["acquire_account_root"]);
    expect(recipientCalls.paid).toEqual(["acquire_account_root"]);
    expect([...creatorCalls.blocked, ...recipientCalls.blocked]).toEqual([]);
  } finally { await creatorContext.close(); await recipientContext.close(); }
});
