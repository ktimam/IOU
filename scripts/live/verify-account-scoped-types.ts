// Live verification of account-scoped transaction types across three signed-in IOU profiles.
//
// The test creates a disposable shared account between manager (:9241) and mother (:9242),
// exercises the type UI, checks an unrelated father (:9231), then removes the type and deletes
// the disposable account. It deliberately discovers each profile's existing account IDs from
// the backend instead of treating mutable display names as identity.
import { chromium, type Page } from "@playwright/test";

const MANAGER_PORT = Number(process.env.MANAGER_PORT || 9241);
const MOTHER_PORT = Number(process.env.MOTHER_PORT || 9242);
const FATHER_PORT = Number(process.env.FATHER_PORT || 9231);

let failures = 0;
function check(condition: boolean, label: string): void {
  console.log(`${condition ? "PASS" : "FAIL"} - ${label}`);
  if (!condition) failures++;
}

const SETUP = `window.__iouTypeVerify = window.__iouTypeVerify || (async () => {
  const secp = await import('/node_modules/.vite/deps/@dfinity_identity-secp256k1.js');
  const identity = secp.Secp256k1KeyIdentity.fromJSON(localStorage.getItem('iou:dev:identity:v1'));
  const auth = await import('/src/features/auth/AuthProvider.tsx');
  const decl = await import('/src/backend/declarations.ts');
  const createSheet = await import('/src/features/flows/createSheet.ts');
  const crypto = await import('/src/features/crypto/devVetkd.ts');
  const agent = await auth.buildAgent(identity);
  return {
    identity,
    actor: decl.createActor(agent),
    createSheet,
    crypto,
    principal: identity.getPrincipal().toText(),
  };
})();`;

interface Session {
  page: Page;
}

async function session(port: number): Promise<Session> {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes(":3000"));
  if (!page) throw new Error(`No IOU tab found on CDP port ${port}`);
  return { page };
}

async function run<T>(page: Page, body: string): Promise<T> {
  return page.evaluate(`(async () => {
    ${SETUP}
    const app = await window.__iouTypeVerify;
    ${body}
  })()`) as Promise<T>;
}

async function activeSheetIds(page: Page): Promise<string[]> {
  return run<string[]>(page, `
    const pairs = await app.actor.get_my_pairs();
    return pairs.flatMap((pair) => {
      const active = Array.isArray(pair.active_sheet_id) ? pair.active_sheet_id[0] : pair.active_sheet_id;
      return active ? [active] : [];
    });
  `);
}

async function openSheet(page: Page, sheetId: string): Promise<void> {
  await page.goto(`http://127.0.0.1:3000/sheet/${sheetId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3500);
}

async function closeModal(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await page.locator(".modal-backdrop").isVisible().catch(() => false))) return;
    await page.getByRole("button", { name: "Close" }).last().click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function pickerNames(page: Page): Promise<string> {
  const addButton = page.getByRole("button", { name: /^\+ Add/ });
  if (!(await addButton.isVisible().catch(() => false))) return "(no picker)";
  await addButton.click({ timeout: 8000 });
  await page.waitForTimeout(500);
  const names = (await page.evaluate(`(() => {
    const blank = Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Blank entry',
    );
    if (!blank?.parentElement) return '(no dropdown)';
    return Array.from(blank.parentElement.querySelectorAll('button'))
      .map((button) => button.textContent?.replace(/\\s+/g, ' ').trim() || '')
      .join(' | ');
  })()`)) as string;
  await page.keyboard.press("Escape").catch(() => {});
  return names;
}

async function waitForPicker(page: Page, expected: string, present: boolean): Promise<string> {
  let names = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    names = await pickerNames(page);
    if (names.includes(expected) === present) return names;
    await page.waitForTimeout(1500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2200);
  }
  return names;
}

async function removeType(page: Page, typeName: string): Promise<boolean> {
  await closeModal(page);
  await page.getByRole("button", { name: "Add type" }).first().click({ timeout: 8000 });
  await page.waitForTimeout(800);
  const row = page.locator("li").filter({ hasText: typeName }).first();
  if (!(await row.isVisible().catch(() => false))) {
    await closeModal(page);
    return false;
  }
  const accept = (dialog: import("@playwright/test").Dialog) => void dialog.accept().catch(() => {});
  page.on("dialog", accept);
  await row.getByRole("button", { name: "Remove" }).click({ timeout: 8000, force: true });
  await page.waitForTimeout(1800);
  page.off("dialog", accept);
  await closeModal(page);
  return true;
}

async function main(): Promise<void> {
  const manager = await session(MANAGER_PORT);
  const mother = await session(MOTHER_PORT);
  const father = await session(FATHER_PORT);
  const typeName = `AccountLive${Date.now().toString().slice(-7)}`;
  const managerExistingSheets = await activeSheetIds(manager.page);
  const fatherExistingSheets = await activeSheetIds(father.page);
  let pairId: string | null = null;
  let sharedSheetId: string | null = null;
  let typeCreated = false;

  try {
    const created = await run<{
      pairId: string;
      sheetId: string;
      sheetKey: number[];
      inviteCode: string;
    }>(manager.page, `
      const pair = await app.actor.create_pair();
      const made = await app.createSheet.createSheetForPair(app.actor, app.identity, {
        pairId: pair.pair_id,
        currencies: ['USD'],
        closingDays: 365,
      });
      const inviteCode = await app.actor.issue_invite(pair.pair_id);
      return {
        pairId: pair.pair_id,
        sheetId: made.sheet.id,
        sheetKey: Array.from(made.K_sheet),
        inviteCode,
      };
    `);
    pairId = created.pairId;
    sharedSheetId = created.sheetId;

    await run(mother.page, `
      const keypair = await app.crypto.deriveUserKeypair(app.principal);
      const publicKey = Array.from(new TextEncoder().encode(keypair.publicKeyB64));
      const sheetKey = new Uint8Array(${JSON.stringify(created.sheetKey)});
      const wrapped = await app.crypto.wrapSheetKey(sheetKey, keypair.publicKey, keypair.privateKey);
      await app.actor.accept_invite(
        ${JSON.stringify(created.inviteCode)},
        [{
          sheet_id: ${JSON.stringify(created.sheetId)},
          wrapped_key_for_partner: Array.from(wrapped),
        }],
        publicKey,
      );
      return true;
    `);

    const access = await Promise.all([
      run<boolean>(manager.page, `return Boolean((await app.actor.get_pair(${JSON.stringify(pairId)}))[0]);`),
      run<boolean>(mother.page, `return Boolean((await app.actor.get_pair(${JSON.stringify(pairId)}))[0]);`),
      run<{ pair: boolean; sheet: boolean; writeRejected: boolean }>(father.page, `
        const pair = Boolean((await app.actor.get_pair(${JSON.stringify(pairId)}))[0]);
        const sheet = Boolean((await app.actor.get_sheet(${JSON.stringify(sharedSheetId)}))[0]);
        let writeRejected = false;
        try {
          await app.actor.set_pair_templates(${JSON.stringify(pairId)}, [1], Array(12).fill(0));
        } catch {
          writeRejected = true;
        }
        return { pair, sheet, writeRejected };
      `),
    ]);
    check(access[0], "creating member can query the disposable shared account");
    check(access[1], "invited member can query the disposable shared account");
    check(!access[2].pair && !access[2].sheet, "unrelated user cannot read its pair or sheet");
    check(access[2].writeRejected, "unrelated user cannot publish a type slot into it");

    await openSheet(manager.page, sharedSheetId);
    await manager.page.getByRole("button", { name: "Add type" }).first().click({ timeout: 10000 });
    await manager.page.getByPlaceholder("Name (e.g. Reservation)").first().fill(typeName);
    await manager.page
      .getByPlaceholder("reservation, deposit, booking")
      .first()
      .fill("account-live-check");
    await manager.page.getByRole("button", { name: /^(Add type|Save changes)$/ }).last().click();
    await manager.page.waitForTimeout(2200);
    await closeModal(manager.page);
    typeCreated = true;

    const managerShared = await waitForPicker(manager.page, typeName, true);
    check(managerShared.includes(typeName), "author sees the type in the account where it was created");

    await openSheet(mother.page, sharedSheetId);
    const motherShared = await waitForPicker(mother.page, typeName, true);
    check(motherShared.includes(typeName), "partner sees the type in the same shared account");
    check(
      new RegExp(`${typeName}\\s*·\\s*partner`).test(motherShared),
      "partner-owned type is labelled as partner data",
    );

    if (managerExistingSheets.length > 0) {
      await openSheet(manager.page, managerExistingSheets[0]);
      const authorOther = await waitForPicker(manager.page, typeName, false);
      check(!authorOther.includes(typeName), "author does not see the type in another account");
    } else {
      console.log("SKIP - author has no pre-existing account for the cross-account UI assertion");
    }

    if (fatherExistingSheets.length > 0) {
      await openSheet(father.page, fatherExistingSheets[0]);
      const unrelated = await waitForPicker(father.page, typeName, false);
      check(!unrelated.includes(typeName), "unrelated user's account does not expose the type");
    }

    await openSheet(manager.page, sharedSheetId);
    check(await removeType(manager.page, typeName), "author can remove the disposable type");
    typeCreated = false;
    await openSheet(mother.page, sharedSheetId);
    const motherAfter = await waitForPicker(mother.page, typeName, false);
    check(!motherAfter.includes(typeName), "removal propagates to the partner");
  } finally {
    if (typeCreated && sharedSheetId) {
      await openSheet(manager.page, sharedSheetId).catch(() => {});
      await removeType(manager.page, typeName).catch(() => false);
    }
    if (pairId) {
      await run(mother.page, `
        try { await app.actor.leave_pair(${JSON.stringify(pairId)}); } catch {}
        return true;
      `).catch(() => false);
      await run(manager.page, `
        try { await app.actor.archive_pair(${JSON.stringify(pairId)}); } catch {}
        try { await app.actor.delete_pair(${JSON.stringify(pairId)}); } catch {}
        return true;
      `).catch(() => false);
      const stillPresent = await run<boolean>(manager.page, `
        return Boolean((await app.actor.get_pair(${JSON.stringify(pairId)}))[0]);
      `).catch(() => true);
      check(!stillPresent, "disposable shared account was deleted after verification");
    }
  }

  if (failures > 0) throw new Error(`${failures} account-scoped assertion(s) failed`);
  console.log("ACCOUNT-SCOPED TYPES LIVE VERIFY PASSED");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error?.message ?? error);
    process.exit(1);
  });
