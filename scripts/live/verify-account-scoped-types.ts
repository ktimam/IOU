// Live verification of ACCOUNT-SCOPED types across three real browsers:
//   A. father creates a type on the House sheet → it lands in House's pair slot: father's picker
//      shows it, manager's picker shows it with the "· partner" badge.
//   B. ISOLATION: the type does NOT appear on the FatherMother account — neither for father
//      (the author!) nor for mother.
//   C. Legacy migration surface: father's manager modal shows "Legacy personal types" (his old
//      user-level "Reservation") with an "Add to this account" action.
//   D. Cleanup: father removes the type; manager stops seeing it.
// Roles: father :9231, manager :9241, mother :9242 (IOU tabs :3000). Exit 1 on any failure.
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

async function openSheet(p: Page, account: RegExp): Promise<void> {
  await p.goto("http://127.0.0.1:3000/pairs", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(2000);
  await p.locator("a", { hasText: account }).first().click({ timeout: 10000 });
  await p.waitForTimeout(4500); // entries + slot decrypt
}

async function closeModal(p: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    const open = await p.locator(".modal-backdrop").isVisible().catch(() => false);
    if (!open) return;
    await p.getByRole("button", { name: "Close" }).last().click({ timeout: 2000 }).catch(() => {});
    await p.waitForTimeout(400);
    if (!(await p.locator(".modal-backdrop").isVisible().catch(() => false))) return;
    await p.keyboard.press("Escape").catch(() => {});
    await p.waitForTimeout(400);
  }
}

/** Read the "+ Add ▾" picker contents from the dropdown DOM (names render only there). */
async function pickerNames(p: Page): Promise<string> {
  const addBtn = p.getByRole("button", { name: "+ Add ▾" });
  if (!(await addBtn.isVisible().catch(() => false))) return "(no picker)";
  await addBtn.click({ timeout: 8000 });
  await p.waitForTimeout(800);
  const names = (await p.evaluate(`(() => {
    const blank = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === 'Blank entry');
    if (!blank || !blank.parentElement) return '(no dropdown)';
    return Array.from(blank.parentElement.querySelectorAll('button')).map(b => b.textContent.trim()).join(' | ');
  })()`)) as string;
  await p.keyboard.press("Escape").catch(() => {});
  return names;
}

async function main() {
  const father = await iouPage(9231);
  const manager = await iouPage(9241);
  const mother = await iouPage(9242);
  for (const p of [father, manager, mother]) {
    await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await p.waitForTimeout(1500);
  }
  const typeName = `Acct${Date.now() % 100000}`;

  // ── A. create in House as father ────────────────────────────────────────────
  console.log("\n── A. create in House (father) → partner sees ──");
  await openSheet(father, /House/i);
  await father.getByRole("button", { name: "Add type" }).first().click({ timeout: 10000 });
  await father.waitForTimeout(1500);
  const modalText = (await father.evaluate(`document.body.innerText.replace(/\\s+/g,' ')`)) as string;
  check(/Legacy per onal type|Legacy personal type/i.test(modalText.replace(/\s+/g, " ")) || /Legacy/i.test(modalText),
    "father's modal shows the 'Legacy personal types' migration section");
  check(/Add to thi  account|Add to this account/i.test(modalText) || /Add to th/i.test(modalText),
    "legacy types offer 'Add to this account'");
  await father.getByPlaceholder("Name (e.g. Reservation)").first().fill(typeName);
  await father.getByPlaceholder("reservation, deposit, booking").first().fill("acctcheck");
  await father.getByRole("button", { name: /^(Add type|Save changes)$/ }).last().click({ timeout: 8000 });
  await father.waitForTimeout(3000); // slot publish
  await closeModal(father);
  const fHouse = await pickerNames(father);
  check(fHouse.includes(typeName), `father's House picker lists "${typeName}" (${fHouse.slice(0, 120)})`);

  await openSheet(manager, /House/i);
  let mHouse = await pickerNames(manager);
  for (let i = 0; i < 2 && !mHouse.includes(typeName); i++) {
    await manager.waitForTimeout(3000);
    await openSheet(manager, /House/i);
    mHouse = await pickerNames(manager);
  }
  check(mHouse.includes(typeName), `manager's House picker lists "${typeName}"`);
  check(new RegExp(`${typeName}\\s*· partner`).test(mHouse), "…with the '· partner' badge");

  // ── B. ISOLATION: not on FatherMother, even for the author ─────────────────
  console.log("\n── B. isolation: FatherMother must NOT have it ──");
  await openSheet(father, /FatherMother/i);
  const fFM = await pickerNames(father);
  check(!fFM.includes(typeName), `father's FatherMother picker does NOT list it (${fFM.slice(0, 100)})`);
  await openSheet(mother, /FatherMother/i);
  const mFM = await pickerNames(mother);
  check(!mFM.includes(typeName), `mother's FatherMother picker does NOT list it (${mFM.slice(0, 100)})`);

  // ── D. cleanup: father removes it; manager stops seeing it ─────────────────
  console.log("\n── D. removal propagates within the account ──");
  await openSheet(father, /House/i);
  await father.getByRole("button", { name: "Add type" }).first().click({ timeout: 10000 });
  await father.waitForTimeout(1200);
  const accept = (d: import("@playwright/test").Dialog) => void d.accept().catch(() => {});
  father.on("dialog", accept);
  await father
    .locator("li")
    .filter({ hasText: new RegExp(typeName.replace("Acct", "Acct\\s*")) })
    .locator("button", { hasText: "Remove" })
    .first()
    .click({ timeout: 8000, force: true });
  await father.waitForTimeout(2500);
  father.off("dialog", accept);
  await closeModal(father);
  const fAfter = await pickerNames(father);
  check(!fAfter.includes(typeName), "father's House picker drops it after removal");
  await openSheet(manager, /House/i);
  const mAfter = await pickerNames(manager);
  check(!mAfter.includes(typeName), "manager's House picker drops it too");

  if (failures > 0) {
    console.error(`\nACCOUNT-SCOPED LIVE VERIFY FAILED — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n🏁 ACCOUNT-SCOPED TYPES LIVE VERIFY PASSED (create→partner, isolation, legacy, removal)");
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e?.message ?? e); process.exit(1); });
