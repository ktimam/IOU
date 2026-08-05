// Phase 2/3 live proof: EDIT the values in IOU's in-chat app card, press "Add to IOU", and confirm
// the DEPOSITED payload is the EDITED values (not the frozen extraction).
//   propose (manual seam) extracts {amount 350, EGP, credit} → the card iframe is prefilled →
//   we change it to {amount 999, USD, debt} inside the iframe → "Add to IOU" → the bridge sends the
//   edited object → respond_to_action_card deposits confirm_payload_override → the confirmer's inbox
//   envelope decrypts to the EDITED object.
// Roles: proposer+confirmer manager OC :9241; deposit read on father IOU :9231 (fan-out gives both
// members the envelope). Exit 1 on any failed assertion.
import { chromium, type Page } from "@playwright/test";

let failures = 0;
function check(c: boolean, l: string): void { console.log(`${c ? "✅" : "❌"} ${l}`); if (!c) failures++; }

async function ocPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return b.contexts()[0].pages().find((x) => x.url().includes("5003"))!;
}
async function iouPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return b.contexts()[0].pages().find((x) => x.url().includes("3000"))!;
}

async function inboxDrafts(p: Page): Promise<Record<string, unknown>[]> {
  await p.goto("http://127.0.0.1:3000/pairs", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2000);
  return (await p.evaluate(`(async () => {
    const inbox = await import('/src/features/openchat/actionInboxClient.ts');
    const auth = await import('/src/features/auth/AuthProvider.tsx');
    const declarations = await import('/src/backend/declarations.ts');
    const identity = auth.loadDevIdentityForDiagnostics();
    if (!identity) throw new Error('signed-in local development identity is required');
    const actor = declarations.createActor(await auth.buildAgent(identity));
    const cfg = await inbox.getActionInboxConfig(actor);
    if (!cfg) throw new Error('OpenChat binding is not configured');
    const drafts = await inbox.pollActionInbox({ config: cfg, maxResults: 80 });
    return drafts.map(d => d.draft);
  })()`)) as Record<string, unknown>[];
}

async function main() {
  const oc = await ocPage(9241);
  const fatherIou = await iouPage(9231);

  // Fresh code + no model + manual seam
  await oc.evaluate(`(async () => { try { const w = await import('/src/utils/webInference.ts'); if (w.clearWebModel) await w.clearWebModel(); } catch {} localStorage.removeItem('openchat_web_model_url'); try{indexedDB.deleteDatabase('openchat_web_model');}catch{} localStorage.setItem('oc:manualExtract','1'); })()`).catch(()=>{});
  await oc.reload({ waitUntil: "domcontentloaded" }); await oc.waitForTimeout(3000);
  await oc.goto("http://localhost:5003/chats", { waitUntil: "domcontentloaded" }); await oc.waitForTimeout(2500);
  await oc.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 12000 });
  await oc.waitForTimeout(2500);
  await oc.evaluate(`localStorage.setItem("oc:manualExtract","1")`);

  // 1. Propose — extraction 350 EGP credit
  const n = Date.now() % 100000;
  const ex = JSON.stringify({ kind: "iou", amount: 350, currency: "EGP", direction: "credit", note: `edit ${n}` });
  const h = (d: import("@playwright/test").Dialog) => { void d.accept(/JSON/i.test(d.message()) ? ex : "1").catch(()=>{}); };
  oc.on("dialog", h);
  const composer = oc.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 }); await oc.keyboard.type(`edit ${n}: cleaning 350 EGP`); await oc.keyboard.press("Enter");
  await oc.waitForTimeout(2500);
  const bubble = oc.locator(".bubble-wrapper").first();
  await bubble.hover().catch(()=>{}); await oc.waitForTimeout(400);
  await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(()=>{});
  await oc.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(()=>{});
  await oc.waitForTimeout(4000);
  oc.off("dialog", h);

  // 2. Find THIS run's card among any stale pending ones — the one whose iframe prefills our note.
  await oc.waitForTimeout(2500);
  const candidates = await oc.locator(".action-card:not(.collapsed):has(iframe)").all();
  let card = candidates[candidates.length - 1];
  for (const c of candidates) {
    const body = await c.frameLocator("iframe").locator("body").innerText().catch(() => "");
    if (body.includes(`edit ${n}`)) { card = c; break; }
  }
  check(!!card, "this run's app-card iframe found (prefilled with our note)");
  const frame = card.frameLocator("iframe");
  // Edit to a RUN-UNIQUE amount so the deposit is unambiguously identifiable.
  const editAmount = 700000 + n; // e.g. 722034 — recognizably not the 350 extraction
  const amount = frame.locator("input").first();
  await amount.fill(String(editAmount), { timeout: 10000 });
  // currency + direction are the two <select>s (order: currency, direction)
  await frame.locator("select").first().selectOption("USD").catch(async()=>{ await frame.locator("select").first().selectOption({ label: "USD" }); });
  await frame.locator("select").nth(1).selectOption("debt").catch(async()=>{ await frame.locator("select").nth(1).selectOption({ label: "You owe" }); });
  await oc.waitForTimeout(500);
  const amtNow = await amount.inputValue().catch(()=>"");
  check(amtNow === String(editAmount), `amount edited to ${editAmount} in the card (got "${amtNow}")`);

  // 3. Add to IOU (confirm) inside the iframe
  await frame.getByRole("button", { name: /Add to IOU/i }).click({ timeout: 10000 });
  await oc.waitForTimeout(6000);
  // the card should flip to confirmed (or at least leave pending)
  const stillPending = await oc.locator(".action-card:not(.collapsed):has(iframe)").filter({ hasText: "" }).count();
  console.log(`   [oc] pending app-cards after confirm: ${stillPending}`);

  // 4. The deposited payload = EDITED values — search the inbox for our UNIQUE edited amount.
  let mine: Record<string, unknown> | undefined;
  for (let i=0;i<8 && !mine;i++){
    await oc.waitForTimeout(2000);
    const drafts = await inboxDrafts(fatherIou);
    mine = drafts.find(d => Number((d as any).amount) === editAmount);
  }
  console.log("   [deposit] the draft carrying our unique edited amount:", JSON.stringify(mine ?? null));
  check(!!mine, `a deposit with the EDITED amount ${editAmount} exists (proves the override deposited, not the frozen 350)`);
  if (mine) {
    check(String((mine as any).currency).toUpperCase() === "USD", `its currency = EDITED USD (not EGP) — got ${(mine as any).currency}`);
    check(String((mine as any).direction) === "debt", `its direction = EDITED debt (not credit) — got ${(mine as any).direction}`);
  }

  if (failures > 0) { console.error(`\nEDIT-DEPOSIT VERIFY FAILED — ${failures}`); process.exit(1); }
  console.log(`\n🏁 EDITED card values are DEPOSITED on-chain: extraction 350/EGP/credit → edited ${editAmount}/USD/debt`);
  process.exit(0);
}
main().catch((e)=>{ console.error("FAILED:", e?.message ?? e); process.exit(1); });
