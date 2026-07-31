// Live check: the app-rendered card SHOWS the transaction kind and the routed saved type, and hands
// the type back on confirm.
//
// Both were declared card rows that OpenChat's classic table used to draw (docs/openchat-registration.json:
// {"label":"Type","valueKey":"kind"} and {"label":"Template","valueKey":"template"}). The iframe
// replaced that table wholesale, and IOU's own card page never rendered either — so they vanished the
// day the app took over the pixels.
//
// The type is the half that MATTERS: the confirm payload REPLACES the stored extraction rather than
// merging with it, so a field the card drops is destroyed. SheetPage's resolveTemplateBase looks
// `template` up by name to seed the entry's fee %, due schedule and default currency/note/direction —
// dropping it meant every chat import silently landed without them.
//
//   pnpm exec tsx scripts/live/verify-card-type-row.ts [--port 9241]
import { chromium, type Page } from "@playwright/test";

const CARD_URL = "http://127.0.0.1:3000/openchat/card";

let failures = 0;
function check(ok: boolean, label: string, detail = "") {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

/** Post an init to the card and return what it rendered plus the payload its confirm hands back. */
async function driveCard(page: Page, data: Record<string, unknown>, confirmLabel: RegExp) {
  await page.goto(CARD_URL);
  await page.waitForSelector("button", { timeout: 20000 });
  // Opened top-level, so window.parent === window: the page's outbound confirm lands right back here,
  // which is how we read the payload without an OpenChat host.
  await page.evaluate((data) => {
    (window as unknown as { __confirm?: unknown }).__confirm = undefined;
    window.addEventListener("message", (e: MessageEvent) => {
      const m = e.data as { type?: string; payload?: unknown };
      if (m?.type === "oc:card:confirm") (window as unknown as { __confirm?: unknown }).__confirm = m.payload;
    });
    window.postMessage(
      { type: "oc:card:init", version: 1, data, context: { theme: "dark", readonly: false } },
      "*",
    );
  }, data);
  await page.waitForTimeout(1200);
  const text = (await page.evaluate(() => document.body.innerText)) as string;
  await page.locator("button").filter({ hasText: confirmLabel }).first().click();
  await page.waitForTimeout(600);
  const payload = await page.evaluate(() => (window as unknown as { __confirm?: unknown }).__confirm);
  return { text, payload };
}

async function main() {
  const i = process.argv.indexOf("--port");
  const port = i >= 0 ? Number(process.argv[i + 1]) : 9241;
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await b.contexts()[0].newPage();
  try {
    // ---- SINGLE, routed to a saved type.
    {
      const { text, payload } = await driveCard(
        page,
        {
          kind: "iou",
          amount: 1000,
          template: "Reservation",
          direction: "credit",
          note: "deposit",
          message: "Reservation deposit 1000",
        },
        /^Add to IOU$/i,
      );
      check(/\bType\b/.test(text) && /\bIOU\b/.test(text), "single: the Type row is shown");
      check(text.includes("Reservation"), "single: the routed saved type is shown");
      const p = payload as { template?: string; kind?: string };
      check(p?.template === "Reservation", "single: the type survives confirm", `template=${p?.template}`);
      check(p?.kind === "iou", "single: the kind survives confirm", `kind=${p?.kind}`);
    }

    // ---- SINGLE, no type routed: nothing new must appear.
    {
      const { text, payload } = await driveCard(
        page,
        { amount: 50, direction: "debt", note: "coffee", message: "coffee 50" },
        /^Add to IOU$/i,
      );
      check(!/\bTemplate\b/.test(text), "no type routed: no empty Template row appears");
      check(
        !("template" in (payload as Record<string, unknown>)),
        "no type routed: nothing new in the payload",
      );
    }

    // ---- MULTI: each row keeps its OWN type (a message can route entries differently).
    {
      const { text, payload } = await driveCard(
        page,
        {
          entries: [
            { kind: "iou", amount: 1000, template: "Reservation", note: "deposit" },
            { amount: 150, note: "food" },
          ],
        },
        /^Add all 2 entries$/i,
      );
      check(text.includes("Reservation"), "multi: entry 1 shows its own type");
      const rows = payload as { template?: string }[];
      check(Array.isArray(rows) && rows.length === 2, "multi: two payload rows");
      check(rows?.[0]?.template === "Reservation", "multi: entry 1 keeps its type", `got=${rows?.[0]?.template}`);
      check(rows?.[1]?.template === undefined, "multi: entry 2 gains no type it never had");
    }
  } finally {
    await page.close();
    await b.close();
  }

  if (failures > 0) {
    console.error(`\nCARD TYPE ROW VERIFY FAILED — ${failures}`);
    process.exit(1);
  }
  console.log("\n🏁 CARD TYPE ROW LIVE VERIFY PASSED: shown on the card, and carried through confirm");
  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e?.message ?? e);
  process.exit(1);
});
