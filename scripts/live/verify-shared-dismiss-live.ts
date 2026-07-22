// Live verification of always-shared types + dismiss-for-all on the FatherMother account:
//   A. father adds a personal type on the sheet (no Share CONTROL exists — informational copy may
//      mention "shared") → the slot mirror publishes → mother's "+ Add ▾" picker shows it with the
//      "· partner" badge after a plain reload. Cleanup: father removes every LiveT* type; after
//      mother reloads they're gone from her picker too (delete-mirror, absence not tombstone).
//   B. a fan-out pending card present on BOTH sides (same context.messageId in the ✦ OpenChat title)
//      is ✕-dismissed by father → mother's copy disappears after reload; her unrelated cards stay.
//      Generate a fresh common card first if needed:
//        pnpm exec tsx scripts/live/journey-fanout.ts --proposer mother:9242:9242 --confirmer father:9222:9231
// Exit 1 on any failed assertion. Roles: father IOU chrome :9231, mother :9242 (tab :3000).
import { chromium, type Page } from "@playwright/test";

let failures = 0;
function check(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) failures++;
}

async function iouPage(port: number): Promise<Page> {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const p = b.contexts()[0].pages().find((x) => x.url().includes("3000"));
  if (!p) throw new Error(`no :3000 tab on :${port}`);
  return p;
}

async function openFMSheet(p: Page): Promise<void> {
  await p.goto("http://127.0.0.1:3000/pairs", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2000);
  await p.locator("a", { hasText: /FatherMother/i }).first().click({ timeout: 10000 });
  await p.waitForTimeout(3500); // sheet load: entries + pair slots + inbox poll
}

/** Close any open modal: Close button, then Escape, until no backdrop remains. */
async function closeModal(p: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open = await p.locator(".modal-backdrop").isVisible().catch(() => false);
    if (!open) return;
    await p.getByRole("button", { name: "Close" }).last().click({ timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(500);
    if (!(await p.locator(".modal-backdrop").isVisible().catch(() => false))) return;
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(500);
  }
}

/** Text of the "+ Add ▾" template picker dropdown (opens it; leaves it open). */
async function pickerText(p: Page): Promise<string> {
  await p.getByRole("button", { name: "+ Add ▾" }).click({ timeout: 10000 });
  await p.waitForTimeout(600);
  return (await p.evaluate(`(() => {
    const blank = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Blank entry');
    return blank && blank.parentElement ? blank.parentElement.innerText.replace(/\\s+/g,' ') : '';
  })()`)) as string;
}

/** Pending cards as {mid, summary} — the mid comes from the ✦ OpenChat title attribute. */
async function pendingCards(p: Page): Promise<{ mid: string; summary: string }[]> {
  return (await p.evaluate(`(() => {
    const out = [];
    for (const cue of document.querySelectorAll('.lock-cue[title]')) {
      const m = /message (\\S+)\\)/.exec(cue.getAttribute('title') || '');
      const li = cue.closest('li');
      if (m && li) out.push({ mid: m[1], summary: li.textContent.replace(/\\s+/g,' ').trim().slice(0, 80) });
    }
    return out;
  })()`)) as { mid: string; summary: string }[];
}

async function stageA_alwaysSharedTypes(father: Page, mother: Page): Promise<void> {
  console.log("\n── A. always-shared types (father authors → mother sees; delete mirrors) ──");
  const typeName = `LiveT${Date.now() % 100000}`;

  await openFMSheet(father);
  await father.getByRole("button", { name: "Add type" }).first().click({ timeout: 10000 });
  await father.waitForTimeout(800);
  // No Share CONTROL anywhere: no button/checkbox/label whose own text is Share/Shared.
  const shareControls = (await father.evaluate(`(() => {
    const ctl = Array.from(document.querySelectorAll('button, label, input[type=checkbox]'));
    return ctl.filter(el => /^\\s*Shared?( type| with partner)?\\s*$/i.test(el.textContent || el.getAttribute('aria-label') || '')).length;
  })()`)) as number;
  check(shareControls === 0, "no Share control in the types UI (types are always shared)");
  await father.getByPlaceholder("Name (e.g. Reservation)").first().fill(typeName);
  await father.getByPlaceholder("reservation, deposit, booking").first().fill("livecheck");
  await father.getByRole("button", { name: /^(Add type|Save changes)$/ }).last().click({ timeout: 8000 });
  await father.waitForTimeout(1500);
  await closeModal(father);
  await father.waitForTimeout(6000); // mirror reconcile → set_pair_templates + manifest sync

  const fPicker = await pickerText(father);
  check(fPicker.includes(typeName), `father's picker lists "${typeName}"`);
  await father.keyboard.press("Escape").catch(() => {});

  // Mother: plain reload, then the picker must show the type with the partner badge.
  let mPicker = "";
  for (let i = 0; i < 3; i++) {
    await openFMSheet(mother);
    mPicker = await pickerText(mother);
    if (mPicker.includes(typeName)) break;
    await mother.keyboard.press("Escape").catch(() => {});
    await mother.waitForTimeout(3000);
  }
  check(mPicker.includes(typeName), `mother's picker lists father's "${typeName}" after a plain reload`);
  check(new RegExp(`${typeName}\\s*· partner`).test(mPicker), "the type carries the '· partner' badge for mother");
  await mother.keyboard.press("Escape").catch(() => {});

  // Cleanup + delete-mirror: father removes every LiveT* type; mother stops seeing them.
  await openFMSheet(father);
  await father.getByRole("button", { name: "Add type" }).first().click({ timeout: 10000 });
  await father.waitForTimeout(800);
  const acceptDialogs = (d: import("@playwright/test").Dialog) => void d.accept().catch(() => {});
  father.on("dialog", acceptDialogs); // Remove is guarded by window.confirm
  for (let i = 0; i < 10; i++) {
    const btn = father.locator("li").filter({ hasText: /LiveT/ }).locator("button", { hasText: "Remove" }).first();
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 8000, force: true });
    await father.waitForTimeout(1500);
  }
  father.off("dialog", acceptDialogs);
  await closeModal(father);
  await father.waitForTimeout(6000); // mirror publishes the drops
  const fAfter = await pickerText(father).catch(() => "");
  check(!/LiveT/.test(fAfter), "father's picker has no LiveT* types after removal");
  await father.keyboard.press("Escape").catch(() => {});
  await openFMSheet(mother);
  const mAfter = await pickerText(mother).catch(() => "");
  check(!/LiveT/.test(mAfter), "mother's picker drops the removed types too (delete mirrors, no tombstone)");
  await mother.keyboard.press("Escape").catch(() => {});
}

async function stageB_dismissForAll(father: Page, mother: Page): Promise<void> {
  console.log("\n── B. ✕ dismiss syncs to ALL members ──");
  await openFMSheet(father);
  await openFMSheet(mother);
  const fCards = await pendingCards(father);
  const mCards = await pendingCards(mother);
  console.log(`[B] father cards: ${JSON.stringify(fCards)}`);
  console.log(`[B] mother cards: ${JSON.stringify(mCards)}`);
  const common = fCards.find((f) => mCards.some((m) => m.mid === f.mid));
  if (!common) {
    check(false, "a fan-out card with the same messageId exists on both sides (run the journey per the header first)");
    return;
  }
  const control = mCards.find((m) => m.mid !== common.mid);
  console.log(`[B] dismissing mid=${common.mid} on father's side; mother control card: ${control?.mid ?? "none"}`);

  await father
    .locator(`li:has(.lock-cue[title*="message ${common.mid}"])`)
    .getByRole("button", { name: "✕" })
    .click({ timeout: 10000 });
  await father.waitForTimeout(5000); // local echo is instant; the slot publish needs a beat

  const fAfter = await pendingCards(father);
  check(!fAfter.some((c) => c.mid === common.mid), "father's own card hidden immediately (local echo)");

  await openFMSheet(mother); // fresh load pulls the pair slots → merged dismissed union
  const mAfter = await pendingCards(mother);
  check(!mAfter.some((c) => c.mid === common.mid), "mother's copy of the SAME card is gone after reload (dismiss synced)");
  if (control) {
    check(mAfter.some((c) => c.mid === control.mid), "mother's unrelated card survives (control)");
  }
}

async function main() {
  const father = await iouPage(9231);
  const mother = await iouPage(9242);
  for (const p of [father, mother]) {
    await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await p.waitForTimeout(2000);
  }
  await stageA_alwaysSharedTypes(father, mother);
  await stageB_dismissForAll(father, mother);

  if (failures > 0) {
    console.error(`\nLIVE VERIFY FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 ALWAYS-SHARED TYPES + DISMISS-FOR-ALL LIVE VERIFY PASSED");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
