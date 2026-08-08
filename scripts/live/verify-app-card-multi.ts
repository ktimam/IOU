// Multi-entry app-card live proof: a message with SEVERAL values → ONE app-card iframe that renders
// N editable entries → "Add all N entries" → N entries deposited on-chain under ONE messageId (the
// "several values, one message" feature working INSIDE IOU's app-owned card).
//   propose (manual seam) a 2-element ARRAY → the card iframe shows Entry 1 + Entry 2 (not one
//   flattened card) → edit entry 1's amount to a run-unique value → Add all → the inbox carries BOTH
//   entries (the unique-amount one proves the edit deposited; the other proves entry 2 wasn't lost).
// proposer+confirmer manager OC :9241; deposit read on father IOU :9231. Exit 1 on any failure.
import { chromium, type Dialog, type Locator, type Page } from "@playwright/test";
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

// Playwright AUTO-DISMISSES a dialog once no listener is attached, and that dismiss rejects with
// "No dialog is showing" if the page already closed it — an UNCAUGHT rejection that kills the run
// mid-assertion. Swallow those; every real failure is reported through check() and the exit code.
process.on("unhandledRejection", (e) => {
  const m = String((e as { message?: string })?.message ?? e);
  if (!/No dialog is showing|Target closed|handleJavaScriptDialog/i.test(m)) throw e;
});

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
    return (await inbox.pollActionInbox({ config: cfg, maxResults: 100 })).map(d => d.draft);
  })()`)) as Record<string, unknown>[];
}

async function main() {
  const sourceOc = await ocPage(9241);
  // Which IOU profile to read the deposit from. Fan-out delivers to EVERY paired chat member, so any
  // paired member's inbox proves the deposit; default to father, override when only another member is
  // paired (e.g. --iou 9241 to read the proposer/confirmer's own inbox).
  const iouArg = process.argv.indexOf("--iou");
  const iouPort = iouArg >= 0 && process.argv[iouArg + 1] ? Number(process.argv[iouArg + 1]) : 9231;
  const sourceFatherIou = await iouPage(9231);
  const sourceManagerIou = sourceOc
    .context()
    .pages()
    .find((page) => page.url().includes("3000"));
  if (!sourceManagerIou) throw new Error("manager IOU page is unavailable");
  const sourceReadIou =
    iouPort === 9231
      ? sourceFatherIou
      : iouPort === 9241
        ? sourceManagerIou
        : await iouPage(iouPort);
  console.log(`   reading deposits from IOU :${iouPort}`);

  const tabs = new TemporaryTabScope();
  const failuresBefore = failures;
  let artifactScope: OpenChatArtifactScope | undefined;
  let inboxScope: ActionInboxArtifactScope | undefined;
  let dialogPage: Page | undefined;
  let dialogHandler: ((dialog: Dialog) => void) | undefined;
  let primaryFailed = false;
  try {
  const oc = await tabs.open(sourceOc, "http://localhost:5003/chats", {
    manualExtract: true,
  });
  const fatherIou = await tabs.open(sourceFatherIou, "http://127.0.0.1:3000/pairs");
  const managerIou = await tabs.open(sourceManagerIou, "http://127.0.0.1:3000/pairs");
  const readIou =
    iouPort === 9231
      ? fatherIou
      : iouPort === 9241
        ? managerIou
        : await tabs.open(sourceReadIou, "http://127.0.0.1:3000/pairs");
  await oc.waitForTimeout(2500);
  await oc.locator(".chat-summary, .chat_summary").filter({ hasText: /father/i }).first().click({ timeout: 12000 });
  await oc.waitForTimeout(2500);
  await armManualExtractForCurrentUrl(oc);

  // 1. Propose a 2-element array. The EXTRACTED amounts are deliberately plain (350/500): the
  //    run-unique value is only ever typed INTO the card at step 2b, so a deposit carrying it can
  //    ONLY have come from the edited override.
  //    (This test previously put the unique amount in the extraction itself and asserted it came
  //    back — which passes even when the override is dropped and the FROZEN extraction is deposited.
  //    That blind spot hid a real bug: the host screened the inbound confirm with `isRecord`, which
  //    excludes arrays, so every multi-entry edit was silently discarded.)
  const n = Date.now() % 100000;
  const editAmt = 700000 + n;
  const noteA = `mA ${n}`;
  const noteB = `mB ${n}`;
  const sourceText = `multi ${n}: two fees`;
  artifactScope = new OpenChatArtifactScope(oc, "multi-entry app-card live proof");
  await artifactScope.begin();
  artifactScope.expectExactText(sourceText);
  artifactScope.expectCardInputs([noteA, noteB]);
  const arr = JSON.stringify([
    {
      kind: "iou",
      amount: 350,
      currency: "EGP",
      direction: "credit",
      note: noteA,
      message: sourceText,
    },
    {
      kind: "iou",
      amount: 500,
      currency: "USD",
      direction: "debt",
      note: noteB,
      message: sourceText,
    },
  ]);
  dialogHandler = (d: Dialog) => { void d.accept(/JSON/i.test(d.message()) ? arr : "1").catch(()=>{}); };
  dialogPage = oc;
  oc.on("dialog", dialogHandler);
  const composer = oc.locator(".ProseMirror").first();
  await composer.click({ timeout: 10000 }); await oc.keyboard.type(sourceText); await oc.keyboard.press("Enter");
  await oc.waitForTimeout(2500);
  const bubble = oc.locator(".bubble-wrapper").first();
  await bubble.hover().catch(()=>{}); await oc.waitForTimeout(400);
  await bubble.locator(".menu-icon").first().click({ timeout: 12000 }).catch(()=>{});
  await oc.getByText("Propose action", { exact: true }).click({ timeout: 12000 }).catch(()=>{});
  await oc.waitForTimeout(5000);
  // Keep the handler attached until the disposable tab closes; detaching early lets Playwright
  // auto-dismiss a late dialog and throw.

  // 2. Find THIS run's MULTI card: an app-card iframe with an "Add all N entries" button. Both the
  //    NOTES and the AMOUNTS are rendered in editable <input> fields, so they live in `.inputValue()`,
  //    NOT innerText — match on the collected input values (mA/mB notes + the unique amount).
  await oc.waitForTimeout(3000);
  const candidates = await oc.locator(".action-card:not(.collapsed):has(iframe)").all();
  let card: Locator | null = null;
  let frame: ReturnType<typeof oc.frameLocator> | null = null;
  let inputValues: string[] = [];
  let bodyText = "";
  for (const c of candidates) {
    const f = c.frameLocator("iframe");
    const hasAddAll = await f.getByRole("button", { name: /Add all \d+ entries/i }).count().catch(() => 0);
    if (!hasAddAll) continue;
    const inputs = f.locator("input");
    const cnt = await inputs.count().catch(() => 0);
    const vals: string[] = [];
    for (let i = 0; i < cnt; i++) vals.push(await inputs.nth(i).inputValue().catch(() => ""));
    if (vals.includes(noteA) && vals.includes(noteB)) {
      card = c; frame = f; inputValues = vals; bodyText = await f.locator("body").innerText().catch(() => ""); break;
    }
  }
  check(!!frame, "this run's MULTI-entry app-card iframe found ('Add all N' + both notes in inputs)");
  if (!frame) throw new Error("this run's multi-entry app-card iframe was not found");
  if (!card) throw new Error("this run's exact multi-entry card wrapper was not found");
  await artifactScope.trackExactCard(card, [noteA, noteB]);
  check(/entry\s*1\s*of\s*2/i.test(bodyText) || /2 entries/i.test(bodyText), "iframe renders TWO entry blocks");
  const amountsBefore = inputValues.filter((v) => /^\d+$/.test(v));
  console.log("   amount input values:", JSON.stringify(amountsBefore));
  check(amountsBefore.includes("350") && amountsBefore.includes("500"), "both extracted amounts present in the inputs (entry 2 not lost)");

  // 2b. EDIT entry 1's amount in the frame to a run-unique value. This is the load-bearing step: the
  //     value exists ONLY in the edited payload, so finding it in the deposit proves the override
  //     travelled (a dropped override deposits the frozen 350 instead).
  const amountInputs = frame.locator("input[type=number]");
  const amountCount = await amountInputs.count().catch(() => 0);
  let edited = false;
  for (let i = 0; i < amountCount; i++) {
    if ((await amountInputs.nth(i).inputValue().catch(() => "")) === "350") {
      await amountInputs.nth(i).fill(String(editAmt), { timeout: 10000 });
      edited = (await amountInputs.nth(i).inputValue().catch(() => "")) === String(editAmt);
      break;
    }
  }
  check(edited, `entry 1's amount edited in the card to ${editAmt}`);

  // 3. Add all 2 entries
  inboxScope = new ActionInboxArtifactScope(
    [
      { label: "father", page: fatherIou },
      { label: "manager", page: managerIou },
    ],
    {
      shape: "batch",
      entries: [
        {
          kind: "iou",
          amount: editAmt,
          currency: "EGP",
          direction: "credit",
          note: noteA,
        },
        {
          kind: "iou",
          amount: 500,
          currency: "USD",
          direction: "debt",
          note: noteB,
        },
      ],
    },
    "multi-entry app-card live proof",
  );
  await inboxScope.begin();
  inboxScope.arm();
  await frame.getByRole("button", { name: /Add all \d+ entries/i }).click({ timeout: 10000 });
  await oc.waitForTimeout(6000);

  // 4. BOTH entries deposited under ONE envelope: the design is "several entries, ONE message
  //    consumed" — the confirm deposits a single inbox envelope whose `draft` is the 2-element ARRAY
  //    (NOT two separate envelopes). Find that array envelope and assert both entries survived.
  let envelope: Record<string, unknown>[] | undefined;
  for (let i = 0; i < 8 && !envelope; i++) {
    await oc.waitForTimeout(2000);
    const drafts = await inboxDrafts(readIou);
    envelope = drafts.find(
      (d) => Array.isArray(d) && (d as unknown[]).some((e) => String((e as any).note ?? "").includes(`mB ${n}`)),
    ) as Record<string, unknown>[] | undefined;
  }
  check(!!envelope, "ONE inbox envelope carries this run's entries (single message consumed)");
  const e1 = envelope?.find((e) => String((e as any).note ?? "").includes(`mA ${n}`));
  const e2 = envelope?.find((e) => String((e as any).note).includes(`mB ${n}`));
  // THE assertion this test exists for: the deposited entry 1 must carry the EDITED amount, not the
  // extracted 350. If the override is dropped anywhere in the chain, this is what catches it.
  check(!!e1 && Number((e1 as any).amount) === editAmt,
    `entry 1 deposited with the EDITED amount ${editAmt} (not the extracted 350) — proves the array override travelled`);
  check(!!e2 && Number((e2 as any).amount) === 500, "entry 2 present (500) — NOT lost");
  check(!!envelope && envelope.length === 2, "envelope holds exactly 2 entries");
  if (e2) {
    check(String((e2 as any).currency).toUpperCase() === "USD" && String((e2 as any).direction) === "debt", "entry 2 kept its own currency/direction (USD/debt)");
  }

  if (failures > 0) throw new Error(`MULTI-ENTRY APP-CARD VERIFY FAILED — ${failures}`);
  console.log(`\n🏁 MULTI-ENTRY app-card: 2-value message → 2 editable entries → EDIT entry 1 (350 → ${editAmt}) → Add all → ONE envelope with the EDITED ${editAmt} EGP/credit + 500 USD/debt`);
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (dialogPage && dialogHandler) dialogPage.off("dialog", dialogHandler);
    const primaryInFlight = primaryFailed || failures > failuresBefore;
    let cleanupFailure: unknown;
    try {
      await finalizeActionInboxArtifactCleanup(
        inboxScope,
        primaryInFlight,
        "multi-entry app-card live proof",
      );
    } catch (error) {
      cleanupFailure = error;
    }
    try {
      await finalizeOpenChatArtifactCleanup(
        artifactScope,
        primaryInFlight || cleanupFailure !== undefined,
        "multi-entry app-card live proof",
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
