// Shared UI-flow actions for the IOU app, used by BOTH the Playwright spec
// (multiUser.ui.spec.ts) and the persistent-windows demo (scripts/ui-multiuser-demo.ts).
// Pure actions (no assertions) driving the real app at http://127.0.0.1:3000; each
// browser context/profile is a distinct dev identity (localStorage-scoped Secp256k1).
//
// NAV NOTE: guarded pages redirect to /sign-in while auth is still "loading", so a
// fresh navigation to a deep page (/pair/:id, /sheet/:id, /pair/new) bounces back to
// /pairs. Only /pairs and /sign-in are safe landing spots. So we always land on /pairs
// (gotoHome) and reach deep pages via in-app (SPA) clicks, which keep auth authenticated.

import type { Page } from "@playwright/test";

const T = 45_000;

/** Land on the accounts list (safe: a bounce from a guarded page settles here; data is fresh). */
export async function gotoHome(page: Page): Promise<void> {
  await page.goto("/pairs", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Your accounts" }).waitFor({ timeout: T });
}

/** Sign in via the DEV local-identity button (Vite dev build only). Lands on /pairs. */
export async function signInDev(page: Page): Promise<string> {
  await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
  const dev = page.getByRole("button", { name: /Sign in \(dev/ });
  if (!/\/pairs\b/.test(page.url())) {
    await dev.click({ timeout: T }).catch(() => {}); // already authed → /sign-in bounced to /pairs
  }
  await page.waitForURL("**/pairs", { timeout: T });
  await page.getByRole("heading", { name: "Your accounts" }).waitFor({ timeout: T });
  return page.url();
}

/** Click an account card (a <Link>) by its visible title, or the only one. Lands on its sheet/pair. */
async function openAccount(page: Page, name?: string): Promise<void> {
  await gotoHome(page);
  const links = page.locator("div.col > a");
  const target = name ? links.filter({ hasText: name }).first() : links.first();
  await target.click({ timeout: T });
  await page.waitForURL(/\/(sheet|pair)\//, { timeout: T });
}

/** Create a new account (pair + auto first sheet). Returns the new sheet id (lands on /sheet/<id>). */
export async function createAccount(page: Page, accountName: string, sheetName: string): Promise<string> {
  await gotoHome(page);
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByRole("heading", { name: "New account" }).waitFor({ timeout: T });
  await page.getByRole("button", { name: "Create", exact: true }).click(); // ensure Create mode
  await page.locator("#accountName").fill(accountName);
  await page.locator("#sheetName").fill(sheetName);
  await page.getByRole("button", { name: "Create account" }).click();
  // create_pair + first-sheet creation is several canister calls + crypto; give it room.
  await page.waitForURL("**/sheet/**", { timeout: T * 2 });
  return page.url().split("/sheet/")[1];
}

/** From a /sheet/<id> page, open the pair detail and read {pairId, inviteCode}. */
export async function readInviteFromSheet(page: Page): Promise<{ pairId: string; code: string }> {
  await page.getByRole("link", { name: /Details/ }).click();
  await page.waitForURL("**/pair/**", { timeout: T });
  const pairId = page.url().split("/pair/")[1];
  const codeEl = page.locator("h2").filter({ hasText: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/ }).first();
  await codeEl.waitFor({ timeout: T });
  const code = (await codeEl.innerText()).trim();
  return { pairId, code };
}

const isRealPair = (u: URL) => /\/pair\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith("/pair/new");

/** Join an existing account with an invite code (SPA: /pairs → + New account → Join). Returns pairId. */
export async function joinAccount(page: Page, code: string): Promise<string> {
  await gotoHome(page);
  await page.getByRole("button", { name: "+ New account" }).click();
  await page.getByRole("heading", { name: "New account" }).waitFor({ timeout: T });
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await page.locator("#invite").fill(code);
  await page.getByRole("button", { name: "Join account" }).click();
  // Success navigates to /pair/<id>; a failed join stays on /pair/new with an error → surface it
  // instead of falsely matching the loose "**/pair/**".
  await page.waitForURL(isRealPair, { timeout: T }).catch(async () => {
    const errs = (await page.locator("p").filter({ hasText: /error|invalid|not found|already|expired/i }).allInnerTexts().catch(() => [])).join(" | ");
    throw new Error(`join failed with code "${code}" (still on ${new URL(page.url()).pathname}): ${errs || "no error shown"}`);
  });
  return page.url().split("/pair/")[1];
}

/** As the creator, grant the partner access to the active sheet (rewraps the key). By account name.
 * The grant button only shows once the pair reads as active (partner joined); a fresh pair-page load
 * can race that propagation, so re-fetch (re-navigate) until it appears. */
export async function grantPartnerAccess(page: Page, accountName: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await openAccount(page, accountName); // → the active sheet (fresh data)
    if (/\/sheet\//.test(page.url())) {
      await page.getByRole("link", { name: /Details/ }).click();
      await page.waitForURL("**/pair/**", { timeout: T });
    }
    const grant = page.getByRole("button", { name: "Grant partner access" });
    try {
      // Give this page load time for get_pair to resolve and render the button (it only shows once
      // the pair reads as active). If it never renders, re-fetch — the join may not be reflected yet.
      await grant.waitFor({ state: "visible", timeout: 10_000 });
    } catch {
      continue;
    }
    await grant.click();
    await page.getByText(/now has access/i).first().waitFor({ timeout: T });
    return;
  }
  throw new Error(`grant button never appeared for "${accountName}" (partner join not reflected)`);
}

/** Open a user's sheet by account name (creator) or the only account (joiner). Returns sheet id. */
export async function openSheet(page: Page, accountName?: string): Promise<string> {
  await openAccount(page, accountName);
  if (/\/pair\//.test(page.url())) {
    await page.locator("a, button").filter({ hasText: /Open active sheet/ }).first().click();
    await page.waitForURL("**/sheet/**", { timeout: T });
  }
  await page.getByRole("heading", { name: "Balances" }).waitFor({ timeout: T });
  return page.url().split("/sheet/")[1];
}

export type EntryInput = {
  currency: string;
  amount: number | string;
  direction: "credit" | "debt";
  type: "settlement" | "iou";
  note?: string;
};

/** Add an entry through the real EntryForm modal on /sheet/<id>. Structural selectors: the wrapping
 * <label><span>…</span><control></label> markup doesn't resolve via getByLabel, so target by position/
 * placeholder/text. Currency = first <select>; Amount = first number input (both precede the fee card). */
export async function addEntry(page: Page, e: EntryInput): Promise<void> {
  await page.getByRole("button", { name: "+ Add entry" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Add entry" }).waitFor({ timeout: T });
  await dialog.locator("select").first().selectOption(e.currency);
  await dialog.locator('input[type="number"]').first().fill(String(e.amount));
  await dialog.getByText(e.direction === "credit" ? "Credit (Incoming)" : "Debit (Outgoing)").click();
  await dialog.getByText(e.type === "iou" ? /IOU \(owed/ : /Settlement \(paid/).click();
  if (e.note) await dialog.locator('input[placeholder="lunch, taxi, etc."]').fill(e.note);
  await dialog.getByRole("button", { name: "Add entry" }).click();
  await dialog.waitFor({ state: "detached", timeout: T });
}

/** Link an OpenChat chat key to a sheet (by the sheet's display name) via /openchat/link-chat. */
export async function linkChatToSheet(page: Page, chatKey: string, sheetName: string): Promise<void> {
  await page.goto(`/openchat/link-chat?chat=${encodeURIComponent(chatKey)}`, { waitUntil: "domcontentloaded" });
  // LinkChatPage renders inline (no redirect). If it shows the anon prompt, sign in in place.
  const dev = page.getByRole("button", { name: /Sign in \(dev/ });
  if (await dev.isVisible().catch(() => false)) await dev.click();
  await page.getByRole("heading", { name: "Link this chat to a sheet" }).waitFor({ timeout: T });
  const row = page.locator("label").filter({ hasText: sheetName }).first();
  await row.locator('input[name="link-chat-sheet"]').check();
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText(/will be imported into/i).first().waitFor({ timeout: T });
}

/** Read the visible text of the Balances section (for assertions / logging). */
export async function balancesText(page: Page): Promise<string> {
  const section = page.locator("section.balances");
  await section.waitFor({ timeout: T });
  return (await section.innerText()).replace(/\s+/g, " ").trim();
}

// ── OpenChat / chat-bridge helpers ──────────────────────────────────────────────────────────────

/** Open Settings and wait for the OpenChat action-inbox card. */
export async function openSettings(page: Page): Promise<void> {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /OpenChat action inbox/i }).waitFor({ timeout: T });
}

/** The per-account consumer-key fingerprint shown on the OpenChat settings card. */
export async function consumerFingerprint(page: Page): Promise<string> {
  const fp = page.getByText(/fingerprint:/i).first();
  await fp.waitFor({ timeout: T });
  return (await fp.innerText()).trim();
}

/** Enter a code in the "Connect to OpenChat" box and submit. */
export async function connectWithCode(page: Page, code: string): Promise<void> {
  await page.locator('input[placeholder="6-digit code"]').fill(code);
  await page.getByRole("button", { name: /^Connect$/ }).click();
}

/** Unlink a chat→sheet mapping via the link-chat page. */
export async function unlinkChat(page: Page, chatKey: string): Promise<void> {
  await page.goto(`/openchat/link-chat?chat=${encodeURIComponent(chatKey)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Unlink this chat" }).click();
  await page.getByText(/no longer linked/i).first().waitFor({ timeout: T });
}

/** Import a chat-bridge draft (paste JSON → Review in form → confirm) into the open sheet. */
export async function importDraft(page: Page, json: string): Promise<void> {
  await page.getByRole("button", { name: /Import/ }).click();
  await page.getByRole("dialog").getByRole("heading", { name: "Import" }).waitFor({ timeout: T });
  await page.getByRole("dialog").locator("textarea").fill(json);
  await page.getByRole("dialog").getByRole("button", { name: "Review in form" }).click();
  // The Import modal closes and the pre-filled EntryForm ("Add entry") opens — confirm it.
  await page.getByRole("dialog").getByRole("heading", { name: "Add entry" }).waitFor({ timeout: T });
  await page.getByRole("dialog").getByRole("button", { name: "Add entry" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached", timeout: T });
}
