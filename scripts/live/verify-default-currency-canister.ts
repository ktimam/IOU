// Live check: the user's ONE default currency is canister-backed, not browser-only.
//
// The default used to live only in localStorage ("iou:prefs:v1"), so it did not follow the user to
// another device — a fresh browser silently fell back to USD. It is now stored per principal on the
// canister (UserRecord.default_currency) with localStorage as a cache, reconciled on load by
// DefaultCurrencySync.
//
// This proves it the only way that counts: it deletes ONLY the cached prefs key (never the whole
// localStorage — that would destroy the profile's dev identity, which has no recovery path), reloads,
// and asserts the default comes back from the canister instead of reverting to USD.
//
// Usage: pnpm exec tsx scripts/live/verify-default-currency-canister.ts --port 9243 [--expect EGP]
import { chromium } from "@playwright/test";

const PREFS_KEY = "iou:prefs:v1";

async function main() {
  const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const port = Number(arg("port", "9243"));
  const expected = arg("expect");
  // A code to CHOOSE through the UI first (so it is written to the canister) before wiping the cache.
  // Pass one that is NOT the "USD" fallback, otherwise a pass proves nothing: the fallback alone
  // would produce USD even if the canister had no value at all.
  const setTo = arg("set");
  const restoreTo = arg("restore");

  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = b.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes(":3000"));
  if (!page) throw new Error("no IOU tab open on :3000");

  const fails: string[] = [];
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) fails.push(label);
  };
  const readPref = () =>
    page.evaluate((k) => {
      try {
        return (JSON.parse(localStorage.getItem(k) ?? "{}") as { defaultCurrency?: string })
          .defaultCurrency;
      } catch {
        return undefined;
      }
    }, PREFS_KEY);

  // 1. Load the app so DefaultCurrencySync runs and pushes the browser value up (the migration).
  await page.goto("http://127.0.0.1:3000/settings");
  await page.waitForSelector("text=Default currency", { timeout: 30000 });
  await page.waitForTimeout(3000);

  // 1b. Optionally CHOOSE a distinctive code through the real UI, which persists it to the canister.
  if (setTo) {
    await page.locator("select").first().selectOption(setTo);
    await page.waitForTimeout(2500);
    check((await readPref()) === setTo, `chose ${setTo} in the UI`, `cache=${await readPref()}`);
  }

  const before = await readPref();
  const want = expected ?? setTo ?? before;
  console.log(`cached default before: ${before}  (expecting the canister to hold ${want})\n`);
  check(!!want, "the profile has a default currency to test with", String(before));

  // 2. Delete ONLY the cached prefs key — the dev identity and every other key stay untouched.
  const keysAfterDelete = await page.evaluate((k) => {
    localStorage.removeItem(k);
    return Object.keys(localStorage);
  }, PREFS_KEY);
  check(!keysAfterDelete.includes(PREFS_KEY), "prefs cache deleted", `${keysAfterDelete.length} other keys kept`);
  check(
    keysAfterDelete.some((k) => k.startsWith("iou:dev:identity") || k.startsWith("iou.dev")),
    "the dev identity survived the targeted delete",
  );

  // 3. Reload with an empty cache: the value can now come from ONE place only — the canister.
  await page.goto("http://127.0.0.1:3000/settings");
  await page.waitForSelector("text=Default currency", { timeout: 30000 });
  await page.waitForTimeout(4000);
  const after = await readPref();
  check(after === want, "the default came back from the canister after the cache was wiped", `got=${after} want=${want}`);
  check(after !== undefined && after !== "USD" || want === "USD", "it is the user's own value, not the USD fallback", `got=${after}`);

  // 4. The UI reflects it too (the select is what the user actually sees).
  const shown = await page.locator("select").first().inputValue();
  check(shown === want, "the Settings picker shows it", `shown=${shown} want=${want}`);

  // 5. Put the profile back the way we found it (this drives the real UI, so it persists too).
  if (restoreTo) {
    await page.locator("select").first().selectOption(restoreTo);
    await page.waitForTimeout(2500);
    check((await readPref()) === restoreTo, `restored to ${restoreTo}`, `cache=${await readPref()}`);
  }

  await b.close();
  console.log(
    fails.length === 0
      ? "\nOK — the default currency is canister-backed and survives a wiped browser cache."
      : `\nFAILED: ${fails.join("; ")}`,
  );
  process.exitCode = fails.length === 0 ? 0 : 1;
}

void main();
