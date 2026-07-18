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
  await page.locator("#accountName").fill(accountName);
  await page.locator("#sheetName").fill(sheetName);
  await page.getByRole("button", { name: "Create account" }).click();
  // create_pair + first-sheet creation + name publish is ~5 update calls + crypto; under
  // multi-context replica contention this can stall for a while, so give it generous room.
  await page.waitForURL("**/sheet/**", { timeout: T * 4 });
  return page.url().split("/sheet/")[1];
}

/** From a solo /sheet/<id> page, open the Invite modal and read the shareable invite link.
 * The "🔗 Invite" button only shows while the sheet is solo (no partner yet). */
export async function inviteLinkFromSheet(page: Page): Promise<string> {
  await page.getByRole("button", { name: /Invite/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Invite to this account" }).waitFor({ timeout: T });
  const link = await dialog.locator("textarea").inputValue();
  await dialog.getByRole("button", { name: "Close" }).click();
  if (!/\/pair\/accept#/.test(link)) throw new Error(`invite link looks wrong: ${link}`);
  return link;
}

/** Accept an invite LINK as the current profile: sign in (idempotent), open the link, click Accept,
 * and land immediately on the shared sheet — no creator grant. Returns the sheet id. */
export async function acceptInvite(page: Page, link: string): Promise<string> {
  await signInDev(page); // ensure authenticated first, so the fragment survives (no sign-in bounce)
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /You've been invited/ }).waitFor({ timeout: T });
  await page.getByRole("button", { name: /Accept invite/ }).click();
  await page.waitForURL("**/sheet/**", { timeout: T * 3 }).catch(async () => {
    const errs = (await page.locator("p.err").allInnerTexts().catch(() => [])).join(" | ");
    throw new Error(`accept invite failed (still on ${new URL(page.url()).pathname}): ${errs || "no error shown"}`);
  });
  return page.url().split("/sheet/")[1];
}

/** Navigate to an account's DETAILS page (/pair/<id>), where the lifecycle controls live.
 * Active accounts open their sheet first (→ click Details); archived accounts open details directly. */
async function openAccountDetails(page: Page, accountName?: string): Promise<void> {
  await openAccount(page, accountName);
  if (/\/sheet\//.test(page.url())) {
    await page.getByRole("link", { name: /Details/ }).click();
    await page.waitForURL("**/pair/**", { timeout: T });
  }
}

/** Leave a 2-member account (Pair page → Leave → confirm). Lands back on /pairs. */
export async function leaveAccount(page: Page, accountName?: string): Promise<void> {
  await openAccountDetails(page, accountName);
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Leave this account?" }).waitFor({ timeout: T });
  await dialog.getByRole("button", { name: "Leave account" }).click();
  await page.waitForURL("**/pairs", { timeout: T });
}

/** Archive an account (Pair page → Archive). Lands back on /pairs (now in the Archived section). */
export async function archiveAccount(page: Page, accountName?: string): Promise<void> {
  await openAccountDetails(page, accountName);
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.waitForURL("**/pairs", { timeout: T });
}

/** Unarchive an archived account (Pair page → Unarchive). Stays on the details page. */
export async function unarchiveAccount(page: Page, accountName?: string): Promise<void> {
  await openAccountDetails(page, accountName);
  await page.getByRole("button", { name: "Unarchive", exact: true }).click();
  await page.getByText(/unarchived/i).first().waitFor({ timeout: T });
}

/** Permanently delete a solo, archived account (Pair page → Delete forever → type DELETE → confirm). */
export async function deleteAccount(page: Page, accountName?: string): Promise<void> {
  await openAccountDetails(page, accountName);
  await page.getByRole("button", { name: "Delete forever" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Delete this account forever?" }).waitFor({ timeout: T });
  await dialog.locator("input").fill("DELETE");
  await dialog.getByRole("button", { name: "Delete forever" }).click();
  await page.waitForURL("**/pairs", { timeout: T });
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

/** Set the global username in Settings; it eagerly publishes to every existing account. */
export async function setUsername(page: Page, username: string): Promise<void> {
  await page.goto("/settings", { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Username", exact: true }).waitFor({ timeout: T });
  const input = page.locator('input[placeholder="e.g. Alice"]');
  await input.fill(username);
  await page.getByRole("button", { name: /Save username/ }).click();
  // Status line confirms local save + eager publish ("Saved…" / "…published to N of M…").
  await page.getByText(/Saved|published|Cleared/i).first().waitFor({ timeout: T });
}

/** From a /sheet/<id> page, "Close & start new": archive this sheet, carry the balance forward
 * to a fresh sheet, and land on it. Returns the NEW sheet id. Requires ≥1 entry (button is
 * disabled on an empty sheet). */
export async function closeAndStartNewSheet(page: Page): Promise<string> {
  const oldId = page.url().split("/sheet/")[1];
  await page.getByRole("button", { name: /Close .* start new/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Close this sheet?" }).waitFor({ timeout: T });
  await dialog.getByRole("button", { name: /Yes, close & start new/ }).click();
  // Close + fresh-sheet creation + carry-forward entries = several canister calls + crypto,
  // then a replace-nav to the NEW sheet. We're already on /sheet/<old>, so wait for the id
  // to actually CHANGE (not just any /sheet/ URL, which is already true).
  await page
    .waitForURL((url) => /\/sheet\//.test(url.pathname) && !url.pathname.endsWith(oldId), {
      timeout: T * 2,
    })
    .catch(async () => {
      const err = (await page.locator("[role='alert'], .toast").allInnerTexts().catch(() => [])).join(" | ");
      throw new Error(`close & start did not rotate the sheet (still ${oldId})${err ? ": " + err : ""}`);
    });
  await page.getByRole("heading", { name: "Balances" }).waitFor({ timeout: T });
  return page.url().split("/sheet/")[1];
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
