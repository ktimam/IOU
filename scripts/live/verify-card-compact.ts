// Live check: the card got SMALLER without becoming harder to tap, and Type/Template are really
// editable — not read-only text dressed up as fields.
//
// The two halves pull against each other, which is why both are asserted here. Shrinking the type and
// the padding alone would have dragged the hit areas down with them (8px padding on a 0.875rem font is
// a ~33px control); instead `minHeight: TOUCH_TARGET` pins every interactive control at 44px — the
// WCAG 2.5.5 / Apple HIG target — while the font and the gaps do the shrinking. So the card lost
// height while GAINING two controls per entry.
//
// Baselines below are measured, not guessed: the same script was run against a stash of the change.
//
//   pnpm exec tsx scripts/live/verify-card-compact.ts [--port 9241]
import { chromium, type Page } from "@playwright/test";

const CARD_URL = "http://127.0.0.1:3000/openchat/card";

// The WCAG 2.5.5 / Apple HIG target size, and the floor inputStyle/btnStyle pin themselves to.
const TOUCH_TARGET = 44;

// Measured on the PREVIOUS build (read-only meta line, 1rem type, 12px gaps) at a 420px viewport.
// The new card must come in under these while carrying MORE controls.
const BASELINE = { single: 433, multi: 1038 };

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

const SINGLE = {
  kind: "iou",
  amount: 1000,
  currency: "EGP",
  template: "Reservation",
  direction: "credit",
  note: "deposit",
  message: "Reservation deposit 1000 EGP",
};
const MULTI = {
  entries: [
    { kind: "iou", amount: 1000, template: "Reservation", note: "deposit" },
    { amount: 150, note: "food" },
    { amount: 300, note: "fee" },
  ],
};

async function load(page: Page, data: unknown) {
  await page.goto(CARD_URL);
  await page.waitForSelector("button", { timeout: 20000 });
  await page.evaluate((d) => {
    (window as unknown as { __confirm?: unknown }).__confirm = undefined;
    window.addEventListener("message", (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: unknown };
      if (m?.type === "oc:card:confirm") (window as unknown as { __confirm?: unknown }).__confirm = m.payload;
    });
    window.postMessage(
      { type: "oc:card:init", version: 1, data: d, context: { theme: "dark", readonly: false } },
      "*",
    );
  }, data);
  await page.waitForTimeout(1500);
}

/** Every interactive control's height, plus the height the card ASKS the host for. */
async function measure(page: Page) {
  return (await page.evaluate(() => {
    const controls = [...document.querySelectorAll("input, select, button")] as HTMLElement[];
    const heights = controls.map((c) => Math.round(c.getBoundingClientRect().height));
    return {
      height: ((window as unknown as { __h?: number[] }).__h ?? []).slice(-1)[0] ?? 0,
      count: controls.length,
      min: heights.length ? Math.min(...heights) : 0,
      distinct: [...new Set(heights)].sort((a, b) => a - b),
    };
  })) as { height: number; count: number; min: number; distinct: number[] };
}

async function main() {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 9241;
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await b.contexts()[0].newPage();
  // At document start: the first resize fires on mount, before any in-page evaluate could attach.
  await page.addInitScript(() => {
    (window as unknown as { __h: number[] }).__h = [];
    window.addEventListener("message", (e: MessageEvent) => {
      const m = e.data as { type?: string; height?: number };
      if (m?.type === "oc:card:resize" && typeof m.height === "number") {
        (window as unknown as { __h: number[] }).__h.push(m.height);
      }
    });
  });
  await page.setViewportSize({ width: 420, height: 900 });

  try {
    for (const [name, data] of [["single", SINGLE], ["multi", MULTI]] as const) {
      await load(page, data);
      const m = await measure(page);
      const base = BASELINE[name];
      check(
        m.height > 0 && m.height < base,
        `${name}: shorter than the previous build`,
        `${m.height}px vs ${base}px (${Math.round(((base - m.height) / base) * 100)}% smaller, ${m.count} controls)`,
      );
      check(
        m.min >= TOUCH_TARGET,
        `${name}: every control still meets the ${TOUCH_TARGET}px touch target`,
        `min=${m.min}px heights=${JSON.stringify(m.distinct)}`,
      );
    }

    // ---- Editable, not decorative: change both and confirm they reach the payload.
    {
      await load(page, SINGLE);
      // By LABEL, not by index: Template and Note are both type="text", so a positional selector
      // silently edits the wrong field (it did, on the first run of this harness).
      await page.getByLabel("Type", { exact: true }).selectOption("settlement");
      await page.getByLabel("Template", { exact: true }).fill("Manager expense");
      await page.locator("button").filter({ hasText: /^Add to IOU$/i }).first().click();
      await page.waitForTimeout(600);
      const p = (await page.evaluate(() => (window as unknown as { __confirm?: unknown }).__confirm)) as {
        kind?: string;
        template?: string;
      };
      check(p?.kind === "settlement", "single: an edited Type reaches the payload", `kind=${p?.kind}`);
      check(
        p?.template === "Manager expense",
        "single: an edited Template reaches the payload",
        `template=${p?.template}`,
      );
    }

    // ---- The routed type is offered as a suggestion to the rows that lack one.
    {
      await load(page, MULTI);
      const suggestions = await page.evaluate(() =>
        [...document.querySelectorAll("datalist option")].map((o) => (o as HTMLOptionElement).value),
      );
      check(
        suggestions.includes("Reservation"),
        "multi: the routed type is suggested to every row",
        `options=${JSON.stringify([...new Set(suggestions)])}`,
      );
      // Row 2 had no type; give it the suggested one and confirm only that row changed.
      await page.getByLabel("Template", { exact: true }).nth(1).fill("Reservation");
      await page.locator("button").filter({ hasText: /^Add all 3 entries$/i }).first().click();
      await page.waitForTimeout(600);
      const rows = (await page.evaluate(() => (window as unknown as { __confirm?: unknown }).__confirm)) as {
        template?: string;
      }[];
      check(
        rows?.[0]?.template === "Reservation" && rows?.[1]?.template === "Reservation",
        "multi: the edited row carries the type it was given",
        `got=${JSON.stringify(rows?.map((r) => r.template))}`,
      );
      check(rows?.[2]?.template === undefined, "multi: an untouched row gains nothing");
    }
  } finally {
    await page.close();
    await b.close();
  }

  if (failures > 0) {
    console.error(`\nCARD COMPACT VERIFY FAILED — ${failures}`);
    process.exit(1);
  }
  console.log("\n🏁 CARD COMPACT LIVE VERIFY PASSED: smaller, still tappable, Type + Template editable");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
