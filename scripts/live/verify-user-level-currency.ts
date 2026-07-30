// Live check: ONE user-level default currency, no per-sheet default.
//
// Runs against a signed-in IOU profile and asserts, on the real UI:
//   1. the entry form pre-selects the USER's default currency (prefs.defaultCurrency) even when the
//      sheet was created with a DIFFERENT one — the case that used to show the sheet's currency;
//   2. the entry-form currency picker offers the full ISO list, not the sheet's list;
//   3. the sheet header no longer advertises a per-sheet currency;
//   4. the "New sheet" page has no currency picker at all.
//
// Usage: pnpm exec tsx scripts/live/verify-user-level-currency.ts --port 9243
import { chromium, type Page } from "@playwright/test";

async function main() {
  const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const port = Number(arg("port", "9243"));

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes(":3000")) as Page | undefined;
  if (!page) throw new Error("no IOU tab open on :3000 for this profile");

  const fails: string[] = [];
  const check = (ok: boolean, label: string, detail: string) => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) fails.push(label);
  };

  const prefs = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("iou:prefs:v1") ?? "{}") as { defaultCurrency?: string };
    } catch {
      return {};
    }
  });
  const myDefault = prefs.defaultCurrency ?? "USD";
  console.log(`this user's default currency: ${myDefault}\n`);

  // Always reach the sheet from /pairs — never trust where the tab was left (a previous run may
  // have parked it on /sheet/new, which also matches "/sheet/").
  await page.goto("http://127.0.0.1:3000/pairs");
  await page.waitForTimeout(2000);
  const sheetLink = page.locator('a[href*="/sheet/"]').first();
  if ((await sheetLink.count()) === 0) throw new Error("no sheet reachable from /pairs");
  await sheetLink.click();
  await page.waitForSelector("text=Balances", { timeout: 20000 });
  const sheetUrl = page.url();

  // 3. Header must not carry a per-sheet currency.
  const header = (await page.locator("header").first().innerText()).replace(/\n/g, " | ");
  check(!/·\s*[A-Z]{3}\b/.test(header), "sheet header has no per-sheet currency", `header="${header}"`);

  // 1 + 2. Entry form defaults to the USER's currency and offers every ISO code.
  await page.getByRole("button", { name: /Add entry/i }).first().click();
  const sel = page.locator("select").first();
  await sel.waitFor({ timeout: 20000 });
  const selected = await sel.inputValue();
  const options = await sel.locator("option").allInnerTexts();
  check(selected === myDefault, "entry form pre-selects the USER default", `got=${selected} want=${myDefault}`);
  check(options.length > 100, "picker offers the full ISO list", `${options.length} options`);
  check(options[0]?.trim() === myDefault, "the user default is listed first", `first=${options[0]}`);

  // 4. New-sheet page has no currency picker.
  const pairHref = await page.locator('a[href*="/pair/"]').first().getAttribute("href");
  const pairId = pairHref?.split("/pair/")[1]?.split(/[/?#]/)[0];
  if (!pairId) {
    check(false, "found a pairId to open New sheet with", "");
  } else {
    await page.goto(`http://127.0.0.1:3000/sheet/new?pairId=${pairId}`);
    await page.waitForSelector("text=Closing window", { timeout: 20000 });
    const body = await page.evaluate(() => document.body.innerText);
    check(!/Currencies/i.test(body), "New sheet page has no currency picker", "");
    check(/Sheet name/i.test(body), "New sheet page still renders its other fields", "");
  }

  // Leave the tab back on the sheet so a later run (or the user) finds it where it was.
  await page.goto(sheetUrl);
  await b.close();
  console.log(fails.length === 0 ? "\nOK — one user-level default currency, no per-sheet default." : `\nFAILED: ${fails.join("; ")}`);
  process.exitCode = fails.length === 0 ? 0 : 1;
}

void main();
