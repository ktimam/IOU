import { chromium } from "@playwright/test";
let failures = 0;
function check(c: boolean, l: string) { console.log(`${c ? "✅" : "❌"} ${l}`); if (!c) failures++; }
async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9241");
  const p = b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
  const netFails: string[] = [];
  p.on("requestfailed", (r) => { if (/openchat\/card/.test(r.url())) netFails.push(String(r.failure()?.errorText)); });
  await p.reload({ waitUntil: "domcontentloaded" }); await p.waitForTimeout(3000);
  await p.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }); await p.waitForTimeout(2500);
  await p.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 12000 });
  await p.waitForTimeout(4000);
  const card = p.locator(".action-card:not(.collapsed):has(iframe)").last();
  check(await card.count() > 0, "pending app-card with iframe exists");
  const frame = card.frameLocator("iframe");
  await p.waitForTimeout(3000);
  const body = await frame.locator("body").innerText().catch((e)=>"FAIL:"+e.message.slice(0,50));
  console.log("iframe body:", body.replace(/\s+/g," ").slice(0,160));
  check(!/refused to connect/i.test(body), "iframe LOADED (not 'refused to connect')");
  check(/Add to IOU/i.test(body), "IOU card renders inside the frame ('Add to IOU')");
  const amt = await frame.locator("input").first().inputValue().catch(()=>"");
  check(/350/.test(amt), `amount prefilled 350 (got "${amt}")`);
  const sels: string[] = [];
  const sc = await frame.locator("select").count().catch(()=>0);
  for (let i=0;i<sc;i++) sels.push(await frame.locator("select").nth(i).inputValue().catch(()=>""));
  console.log("selects:", JSON.stringify(sels));
  check(sels.some(v=>/EGP/i.test(v)), "currency prefilled EGP");
  check(sels.some(v=>/credit|debt/i.test(v)), "direction select present");
  console.log("card-page net failures:", JSON.stringify(netFails.slice(0,2)));
  if (failures>0){ console.error(`\nFAILED — ${failures}`); process.exit(1); }
  console.log("\n🏁 IOU's OWN CARD renders + prefills INSIDE the OpenChat chat (COEP fixed)");
  process.exit(0);
}
main().catch((e)=>{ console.error("FAILED:", e?.message ?? e); process.exit(1); });
