// Phase 2/3 live proof: EDIT the values in IOU's in-chat app card, press "Add to IOU", and confirm
// the DEPOSITED payload is the EDITED values (not the frozen extraction).
//   propose (manual seam) extracts {amount 350, EGP, credit} → the card iframe is prefilled →
//   we change it to {amount 999, USD, debt} inside the iframe → "Add to IOU" → the bridge sends the
//   edited object → respond_to_action_card deposits confirm_payload_override → the confirmer's inbox
//   envelope decrypts to the EDITED object.
// Roles: proposer+confirmer manager OC :9241; deposit read on father IOU :9231 (fan-out gives both
// members the envelope). Exit 1 on any failed assertion.
import { chromium, type Locator, type Page } from "@playwright/test";
import {
  ActionInboxArtifactScope,
  finalizeActionInboxArtifactCleanup,
} from "./actionInboxArtifactCleanup";
import {
  finalizeOpenChatArtifactCleanup,
  OpenChatArtifactScope,
} from "./openChatArtifactCleanup";
import {
  armManualExtractForCurrentUrl,
  TemporaryTabScope,
} from "./temporaryBrowserTab";

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
  const sourceOc = await ocPage(9241);
  const sourceFatherIou = await iouPage(9231);
  const sourceManagerIou = sourceOc
    .context()
    .pages()
    .find((page) => page.url().includes("3000"));
  if (!sourceManagerIou) throw new Error("manager IOU page is unavailable");
  const tabs = new TemporaryTabScope();
  const failuresBefore = failures;
  let artifactScope: OpenChatArtifactScope | undefined;
  let inboxScope: ActionInboxArtifactScope | undefined;
  let primaryFailed = false;
  try {
  const oc = await tabs.open(sourceOc, "http://localhost:5003/chats", {
    manualExtract: true,
  });
  const fatherIou = await tabs.open(sourceFatherIou, "http://127.0.0.1:3000/pairs");
  const managerIou = await tabs.open(sourceManagerIou, "http://127.0.0.1:3000/pairs");
  await oc.waitForTimeout(2500);
  await oc.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 12000 });
  await oc.waitForTimeout(2500);
  await armManualExtractForCurrentUrl(oc);

  // 1. Propose — extraction 350 EGP credit
  const n = Date.now() % 100000;
  const note = `edit ${n}`;
  const sourceText = `${note}: cleaning 350 EGP`;
  artifactScope = new OpenChatArtifactScope(oc, "edited app-card live proof");
  await artifactScope.begin();
  artifactScope.expectExactText(sourceText);
  artifactScope.expectCardInputs([note]);
  const ex = JSON.stringify({
    kind: "iou",
    amount: 350,
    currency: "EGP",
    direction: "credit",
    note,
    message: sourceText,
  });
  const h = (d: import("@playwright/test").Dialog) => { void d.accept(/JSON/i.test(d.message()) ? ex : "1").catch(()=>{}); };
  oc.on("dialog", h);
  try {
    const composer = oc.locator(".ProseMirror").first();
    await composer.click({ timeout: 10000 }); await oc.keyboard.type(sourceText); await oc.keyboard.press("Enter");
    await oc.waitForTimeout(2500);
    const bubble = oc.locator(".bubble-wrapper").first();
    await bubble.hover().catch(()=>{}); await oc.waitForTimeout(400);
    await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(()=>{});
    await oc.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(()=>{});
    await oc.waitForTimeout(4000);
  } finally {
    oc.off("dialog", h);
  }

  // 2. Find THIS run's card among any stale pending ones — the one whose iframe prefills our note.
  await oc.waitForTimeout(2500);
  const candidates = await oc.locator(".action-card:not(.collapsed):has(iframe)").all();
  let card: Locator | undefined;
  for (const c of candidates) {
    const inputs = c.frameLocator("iframe").locator("input");
    const values: string[] = [];
    for (let index = 0; index < await inputs.count().catch(() => 0); index++) {
      values.push(await inputs.nth(index).inputValue().catch(() => ""));
    }
    if (values.includes(note)) { card = c; break; }
  }
  check(!!card, "this run's app-card iframe found (prefilled with our note)");
  if (!card) throw new Error("this run's app-card iframe was not found");
  await artifactScope.trackExactCard(card, [note]);
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
  inboxScope = new ActionInboxArtifactScope(
    [
      { label: "father", page: fatherIou },
      { label: "manager", page: managerIou },
    ],
    {
      shape: "single",
      entries: [
        {
          kind: "iou",
          amount: editAmount,
          currency: "USD",
          direction: "debt",
          note,
        },
      ],
    },
    "edited app-card live proof",
  );
  await inboxScope.begin();
  inboxScope.arm();
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

  if (failures > 0) throw new Error(`EDIT-DEPOSIT VERIFY FAILED — ${failures}`);
  console.log(`\n🏁 EDITED card values are DEPOSITED on-chain: extraction 350/EGP/credit → edited ${editAmount}/USD/debt`);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    const primaryInFlight = primaryFailed || failures > failuresBefore;
    let cleanupFailure: unknown;
    try {
      await finalizeActionInboxArtifactCleanup(
        inboxScope,
        primaryInFlight,
        "edited app-card live proof",
      );
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryInFlight || cleanupFailure !== undefined,
        "edited app-card live proof",
      );
    } catch (error) {
      cleanupFailure ??= error;
    } finally {
      await tabs.close();
    }
    if (cleanupFailure !== undefined && !primaryInFlight) throw cleanupFailure;
  }
}
main()
  .then(() => process.exit(0))
  .catch((e)=>{ console.error("FAILED:", e?.message ?? e); process.exit(1); });
