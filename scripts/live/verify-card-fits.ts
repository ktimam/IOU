// SUPERSEDED IN CI: every assertion here now lives in test/ui/openchatCard.ui.spec.ts ("D3 …:
// buttons stay inside the card at every width, idle and cancelling"), where it runs on `pnpm test:ui`
// against both single- and multi-entry cards and measures BOTH edges against the .card box rather
// than only the row's start edge. Nothing in this file ever needed a live OpenChat — it was hand-run
// only because it was written while chasing one. Keep it as an eyeball probe against a real browser
// session (a real bubble, a real host-applied frame width); put NEW assertions in test/ui.
//
// Live check: the app-rendered card's buttons stay INSIDE the frame at every width, in every phase.
//
// The host sizes IOU's card iframe with `width: 420px; max-width: 100%`, so in a narrow bubble the
// frame is far below its preference — a v2/mobile bubble measured ~250px. A flex row cannot shrink a
// button below its own text, and the row uses `justify-content: flex-end`, so the excess overflows the
// START edge: the buttons slide out of the card to the LEFT, where `scrollWidth` cannot even see them
// (which is why this kept being reported as "outside the window" while every scroll metric looked
// clean). It is worst while CANCELLING, because that is the one label that GROWS — "Cancel" becomes a
// spinner plus "Cancelling…" — whereas the confirm label shrinks to "Adding…".
//
// Measured before the fix: 69px outside at a 240px frame. Guard: flex-wrap on the row, plus
// minWidth:0 + ellipsis on the buttons for frames too narrow to fit even one.
//
// Usage: pnpm exec tsx scripts/live/verify-card-fits.ts [--port 9243]
import { chromium, type Page } from "@playwright/test";

const WIDTHS = [420, 300, 240, 200, 160];

type Shot = { label: string; spill: number; buttons: string[] };

async function measure(page: Page, label: string): Promise<Shot> {
  return page.evaluate((label) => {
    const rows = Array.from(document.querySelectorAll("div")).filter((d) => {
      const s = getComputedStyle(d);
      return s.display === "flex" && s.justifyContent === "flex-end" && d.querySelector("button");
    });
    const row = rows[rows.length - 1] as HTMLElement | undefined;
    if (!row) return { label, spill: 0, buttons: [] };
    const rr = row.getBoundingClientRect();
    const btns = Array.from(row.querySelectorAll("button"));
    // Overflow past the START edge — invisible to scrollWidth under justify-content: flex-end.
    const spill = Math.max(0, ...btns.map((b) => Math.round(rr.left - b.getBoundingClientRect().left)));
    return { label, spill, buttons: btns.map((b) => (b as HTMLElement).innerText.trim().slice(0, 24)) };
  }, label);
}

async function main() {
  const i = process.argv.indexOf("--port");
  const port = Number(i >= 0 ? process.argv[i + 1] : 9243);
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const ctx = b.contexts()[0];

  const fails: string[] = [];
  for (const width of WIDTHS) {
    const page = await ctx.newPage();
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("http://127.0.0.1:3000/openchat/card");
      await page.waitForSelector("select", { timeout: 20000 });
      await page.evaluate(() => {
        window.postMessage(
          {
            type: "oc:card:init",
            version: 1,
            data: {
              entries: [
                { amount: 300, note: "uber" },
                { amount: 150, note: "food" },
                { amount: 500, note: "movies" },
              ],
            },
            context: { chatKey: "direct:probe", theme: "dark", readonly: false },
          },
          "*",
        );
      });
      await page.waitForTimeout(1200);

      const idle = await measure(page, "idle");
      // Clicking Cancel puts the card in its widest state (spinner + "Cancelling…").
      await page.getByRole("button", { name: /^Cancel$/ }).click().catch(() => {});
      await page.waitForTimeout(600);
      const cancelling = await measure(page, "cancelling");

      for (const shot of [idle, cancelling]) {
        const ok = shot.spill === 0;
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${String(width).padStart(3)}px ${shot.label.padEnd(10)} ` +
            `${ok ? "inside" : `${shot.spill}px OUTSIDE the card`}  [${shot.buttons.join(", ")}]`,
        );
        if (!ok) fails.push(`${width}px ${shot.label}`);
      }
    } finally {
      await page.close();
    }
  }
  await b.close();
  console.log(
    fails.length === 0
      ? "\nOK — the card's buttons stay inside the frame at every width, idle and cancelling."
      : `\nFAILED: ${fails.join("; ")}`,
  );
  process.exitCode = fails.length === 0 ? 0 : 1;
}

void main();
