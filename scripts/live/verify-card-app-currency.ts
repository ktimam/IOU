// Live check: the DEPLOYMENT-wide card currency (Config.card_currency) is what IOU's app-rendered
// card pre-selects — the same code for BOTH members of a chat, with zero OpenChat changes.
//
// Why app-level and not per user: the card renders in an iframe OpenChat storage-partitions, so it has
// no IOU session and cannot tell one viewer from another (measured: no localStorage / IndexedDB /
// caches / BroadcastChannel / Storage Access), and a value keyed by the chat is contested between
// users (an OpenChat direct-chat key names only the COUNTERPARTY, so everyone chatting with the same
// person shares it). One global value read through the ANONYMOUS get_config query is the only thing
// every viewer resolves identically. Both members therefore see — and import — the same code.
//
// Usage:
//   pnpm exec tsx scripts/live/verify-card-app-currency.ts --set EGP --ports 9243,9231
//     --set    the code to save (through the real Settings UI on the FIRST port)
//     --ports  every profile whose card should then show it
import { chromium, type BrowserContext, type Page } from "@playwright/test";

const CARD_URL = "http://127.0.0.1:3000/openchat/card";

async function cardCurrencyFor(ctx: BrowserContext, note: string, sentCurrency?: string) {
  const page = await ctx.newPage();
  try {
    await page.goto(CARD_URL);
    await page.waitForSelector("select", { timeout: 20000 });
    await page.evaluate(
      ({ note, sentCurrency }) => {
        window.postMessage(
          {
            type: "oc:card:init",
            version: 1,
            data: {
              amount: 300,
              direction: "debt",
              note,
              ...(sentCurrency ? { currency: sentCurrency } : {}),
            },
            // A linked chat key, so a resurrected per-chat channel would also be exercised.
            context: { chatKey: "direct:wrjd4-zp777-77774-qaanq-cai", theme: "dark", readonly: false },
          },
          "*",
        );
      },
      { note, sentCurrency },
    );
    await page.waitForTimeout(4000);
    return await page.locator("select").first().inputValue();
  } finally {
    await page.close();
  }
}

async function main() {
  const arg = (n: string, d?: string) => {
    const i = process.argv.indexOf(`--${n}`);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const code = (arg("set", "EGP") as string).toUpperCase();
  const ports = (arg("ports", "9243") as string).split(",").map((p) => Number(p.trim()));

  const fails: string[] = [];
  const check = (ok: boolean, label: string, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
    if (!ok) fails.push(label);
  };

  // Save a value through the real Settings UI on the first profile. "" selects "Not set", which
  // CLEARS it on the canister and restores per-user deferral.
  async function saveInSettings(value: string) {
    const b = await chromium.connectOverCDP(`http://127.0.0.1:${ports[0]}`);
    try {
      const page = b.contexts()[0].pages().find((p) => p.url().includes(":3000")) as Page;
      if (!page) throw new Error(`no IOU tab on port ${ports[0]}`);
      const back = page.url();
      await page.goto("http://127.0.0.1:3000/settings");
      await page.waitForSelector("text=Chat card currency", { timeout: 30000 });
      // Two currency pickers on this page: the personal default, then the chat-card one.
      const sel = page.locator("select").nth(1);
      await sel.selectOption(value);
      await page.waitForTimeout(2500);
      check((await sel.inputValue()) === value, `Settings saved ${value || '"Not set"'}`);
      await page.goto(back);
    } finally {
      await b.close();
    }
  }

  // Assert what every listed profile's card pre-selects. `want` "" = per-user deferral.
  async function expectCards(want: string, phase: string) {
    for (const port of ports) {
      const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      try {
        const ctx = b.contexts()[0];
        const invented = await cardCurrencyFor(ctx, "Owe 300 uber", "USD");
        const absent = await cardCurrencyFor(ctx, "Owe 300 uber");
        const stated = await cardCurrencyFor(ctx, "Owe 300 USD uber", "USD");
        const w = want || "(defer)";
        check(invented === want, `${phase} [${port}] invented currency`, `got=${invented || "(defer)"} want=${w}`);
        check(absent === want, `${phase} [${port}] absent currency `, `got=${absent || "(defer)"} want=${w}`);
        check(stated === "USD", `${phase} [${port}] a STATED currency still wins`, `got=${stated}`);
      } finally {
        await b.close();
      }
    }
  }

  // 1. Set it: every member's card must pre-select the SAME code.
  await saveInSettings(code);
  await expectCards(code, "set  ");

  // 2. Clear it: every card must go back to deferring to whoever imports.
  await saveInSettings("");
  await expectCards("", "clear");

  // 3. Leave the deployment on the requested value.
  await saveInSettings(code);

  console.log(
    fails.length === 0
      ? `
OK — with ${code} set, every member's card pre-selects it; cleared, they all defer. A stated currency always wins.`
      : `
FAILED: ${fails.join("; ")}`,
  );
  process.exitCode = fails.length === 0 ? 0 : 1;
}

void main();
