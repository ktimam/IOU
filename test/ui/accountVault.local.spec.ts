import { test, expect, chromium, type BrowserContext, type Page, type Route, type Request } from "@playwright/test";
import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { mkdtempSync } from "node:fs";
import { createAccount } from "./flows";

// Recovery entries are scoped to this exact secure local test origin.
const ORIGIN = "http://localhost:4310";
const CANISTER = process.env.IOU_TEST_VAULT_CANISTER ?? "";
if (!CANISTER || Principal.fromText(CANISTER).toText() !== CANISTER || ["aaaaa-aa", "2vxsx-fae"].includes(CANISTER)) {
  throw new Error("Set IOU_TEST_VAULT_CANISTER to the canonical freshly installed local test canister ID");
}
const CONTROL = new URL(process.env.IOU_TEST_POCKETIC_CONTROL_URL ?? "");
const INSTANCE = process.env.IOU_TEST_POCKETIC_INSTANCE ?? "";
if (CONTROL.protocol !== "http:" || CONTROL.hostname !== "127.0.0.1" || !CONTROL.port || CONTROL.pathname !== "/" ||
  CONTROL.search || CONTROL.hash || CONTROL.username || CONTROL.password || !/^(0|[1-9][0-9]{0,5})$/.test(INSTANCE)) {
  throw new Error("Choose an explicit owned loopback PocketIC control URL and instance number");
}
const PAID = new Set(["acquire_account_root", "vetkd_wrap_consumer_key", "vetkd_wrap_sheet_key", "openchat_card_context", "openchat_private_match_context"]);
async function monitor(context: Pick<BrowserContext, "route"> & { on(event: "request", listener: (request: Request) => void): unknown }) {
  const paid: string[] = [], blocked: string[] = [], canisters = new Set<string>();
  await context.route("**/*", async (route: Route) => {
    const url = new URL(route.request().url());
    if (["http:", "https:"].includes(url.protocol) && !(["localhost", "127.0.0.1"].includes(url.hostname) && ["4310", "4311", "49175"].includes(url.port))) {
      blocked.push(url.origin); await route.abort(); return;
    }
    const target = url.pathname.match(/\/canister\/([^/]+)\//)?.[1];
    if (target && target !== CANISTER) { blocked.push("unexpected local canister"); await route.abort(); return; }
    await route.continue();
  });
  context.on("request", request => {
    if (!request.url().includes("/api/")) return;
    const target = new URL(request.url()).pathname.match(/\/canister\/([^/]+)\//)?.[1];
    if (target) canisters.add(target);
    const bytes = request.postDataBuffer();
    if (!bytes) return;
    try {
      const body = Cbor.decode<{ content?: { method_name?: string } }>(bytes);
      const name = body.content?.method_name;
      if (name && PAID.has(name)) paid.push(name);
    } catch { /* Requests without CBOR are not canister calls. */ }
  });
  return { paid, blocked, canisters };
}
async function isolatedClock(method: "GET" | "POST", body?: string): Promise<Response> {
  const path = method === "GET" ? "read/get_time" : "update/set_time";
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(CONTROL.origin + "/instances/" + INSTANCE + "/" + path, {
      method, ...(body ? { headers: { "content-type": "application/json" }, body } : {}),
    });
    // PocketIC reports 409 while its local auto-progress operation owns the instance.
    // This retry is only for its clock administration, never for a paid canister call.
    if (response.status !== 409) {
      if (!response.ok) throw new Error("Isolated clock HTTP " + response.status + ": " + (await response.text()).slice(0, 250));
      return response;
    }
    await new Promise(resolve => setTimeout(resolve, 75 + attempt * 17));
  }
  throw new Error("The isolated PocketIC clock remained busy");
}
async function alignIsolatedPageClock(page: Page) {
  // A prior owned cooldown test may have advanced PocketIC. Align only this
  // synthetic page; never rewind the canister or change the host/device clock.
  const response = await isolatedClock("GET");
  const current = await response.json() as { nanos_since_epoch: number };
  await page.clock.setFixedTime(new Date(Math.floor(current.nanos_since_epoch / 1_000_000)));
}
async function signIn(page: Page) {
  await page.goto(ORIGIN + "/sign-in");
  await page.getByRole("button", { name: /Sign in \(dev/ }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
}
async function assertManagerOnlyControls(page: Page) {
  await expect(page.getByRole("button", { name: /encryption passkey|Check saved passkey/i })).toHaveCount(0);
  await expect(page.locator("summary").filter({ hasText: /encryption passkeys/i })).toHaveCount(0);
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveCount(0);
}
async function autofillRecovery(page: Page, secret: string) {
  try { await page.getByLabel("Recovery password", { exact: true }).fill(secret); }
  catch { throw new Error("Synthetic recovery-field autofill failed"); }
}
async function enrollManagedRecovery(page: Page, resaveVerified = false): Promise<string> {
  await assertManagerOnlyControls(page);
  // Missing/unverified entries are prepared automatically; only an already
  // verified entry needs an explicit resave after the emergency-recovery test.
  if (resaveVerified) await page.getByRole("button", { name: "Prepare the same recovery entry again", exact: true }).click();
  const saveForm = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Save using the password form$/ }) });
  if (await saveForm.getAttribute("open") === null) await saveForm.locator("summary").click();
  const generated = page.getByLabel("Generated recovery password", { exact: true });
  await expect(generated).toHaveAttribute("type", "password");
  const secret = await generated.inputValue();
  expect(/^IOU1-[A-Za-z0-9_-]{43}$/.test(secret), "Synthetic recovery credential has the expected random format").toBe(true);
  await page.getByRole("button", { name: "I saved the entry; verify it", exact: true }).click();
  await expect(generated).toHaveCount(0);
  expect(await page.getByLabel("Recovery password", { exact: true }).inputValue() === "").toBe(true);
  await autofillRecovery(page, secret);
  await page.getByRole("button", { name: "Verify autofilled entry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts", exact: true })).toBeVisible();
  return secret; // Synthetic value remains in test-process memory only; never logged or saved.
}
async function unlockManagedRecovery(page: Page, identity: string, secret: string) {
  await page.goto(ORIGIN + "/sign-in");
  await page.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Unlock account encryption", exact: true })).toBeVisible();
  await assertManagerOnlyControls(page);
  await autofillRecovery(page, secret);
  await page.getByRole("button", { name: "Unlock with autofilled entry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
}

test("direct existing-account recovery gate: remembered synthetic PRF-only vault requires manager setup without paid recovery", async ({ context, page }) => {
  const count = await monitor(context), runtimeErrors: string[] = [];
  page.on("pageerror", () => runtimeErrors.push("Unhandled direct-route runtime error"));
  // The real anonymous card document loads Vite without an authenticated gate.
  await page.goto(ORIGIN + "/openchat/card");
  await alignIsolatedPageClock(page);
  // Seed BEFORE the authenticated account/gate mounts. Use real account-vault helpers and the
  // isolated backend, not a mocked gate or an already manager-enrolled account.
  const seeded = await page.evaluate(async (canister) => {
    const paths = ["/node_modules/.vite/deps/@dfinity_identity-secp256k1.js", "/src/features/auth/AuthProvider.tsx",
      "/src/backend/declarations.ts", "/src/features/auth/config.ts", "/src/features/crypto/accountVault.ts",
      "/src/features/crypto/accountVaultCrypto.ts", "/src/features/crypto/vaultSheets.ts"];
    const [identities, auth, declarations, config, vault, primitives, sheets] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)));
    if (config.host !== "http://127.0.0.1:49175" || config.canisterId !== canister) throw new Error("Direct fixture must be isolated");
    const identity = identities.Secp256k1KeyIdentity.generate();
    localStorage.setItem("iou:dev:identity:v1", JSON.stringify(identity.toJSON()));
    const principal = identity.getPrincipal().toText(), actor = declarations.createActor(await auth.buildAgent(identity));
    if (await actor.get_vetkd_key_name() !== "dfx_test_key") throw new Error("Direct fixture refuses production keys");
    const scope = { principal, canisterId: canister, host: config.host }, root = crypto.getRandomValues(new Uint8Array(32));
    const prf = crypto.getRandomValues(new Uint8Array(32));
    try {
      await vault.initializeAccountVault(actor, scope, root);
      const record = await vault.loadAccountVault(actor, scope);
      // A genuine encrypted legacy PRF-shaped backup with a synthetic random PRF
      // secret; this tests stored compatibility state, not a real authenticator.
      const credentialId = primitives.vaultB64Url(crypto.getRandomValues(new Uint8Array(32)));
      const prfSalt = primitives.vaultB64(crypto.getRandomValues(new Uint8Array(32)));
      const key = await primitives.vaultAesKey(prf, scope, "passkey-backup");
      const sealed = await primitives.vaultSeal(key, root, primitives.vaultAad(scope, "passkey-backup", JSON.stringify([credentialId, location.hostname, prfSalt])));
      record.payload.passkeys.push({ credentialId, rpId: location.hostname, prfSalt, ...sealed });
      const saved = await actor.set_account_vault(record.revision, Array.from(primitives.encodeAccountVault(record.payload)));
      if (!("Ok" in saved)) throw new Error("Synthetic legacy backup could not be seeded");
      const pair = await actor.create_pair();
      const created = await sheets.createRandomSheet(actor, principal, { pairId: pair.pair_id, closingDays: 30, name: "Synthetic pre-upgrade sheet" });
      created.K_sheet.fill(0);
      const existing = await vault.loadAccountVault(actor, scope);
      if (existing.payload.managedRecovery || existing.payload.passkeys.length !== 1) throw new Error("Expected existing PRF-only vault before mounting UI");
      return { sheetId: created.sheet.id as string, rootFingerprint: existing.payload.rootFingerprint, legacyBackup: JSON.stringify(existing.payload.passkeys) };
    } finally { root.fill(0); prf.fill(0); }
  }, CANISTER);
  expect(count.paid).toEqual([]);
  let secret = "";
  try {
    for (const path of ["/sign-in", "/pairs", "/sheet/" + seeded.sheetId]) {
      await page.goto(ORIGIN + path);
      await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Your accounts|Balances/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /encryption passkey|Check saved passkey/i })).toHaveCount(0);
      const form = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Save using the password form$/ }) });
      if (await form.getAttribute("open") === null) await form.locator("summary").click();
      const field = page.getByLabel("Generated recovery password", { exact: true });
      await expect(field).toHaveAttribute("type", "password");
      const candidate = await field.inputValue();
      expect(/^IOU1-[A-Za-z0-9_-]{43}$/.test(candidate), "Synthetic candidate format").toBe(true);
      if (secret) expect(candidate === secret, "Direct navigation retains the original candidate").toBe(true);
      else secret = candidate;
      expect(count.paid).toEqual([]);
    }
    await page.reload();
    await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
    await expect(page.getByLabel("Generated recovery password", { exact: true })).toHaveAttribute("type", "password");
    expect(await page.getByLabel("Generated recovery password", { exact: true }).inputValue() === secret).toBe(true);
    const preserved = await page.evaluate(async (expected) => {
      const paths = ["/src/features/auth/AuthProvider.tsx", "/src/backend/declarations.ts", "/src/features/crypto/accountVault.ts", "/src/features/crypto/vaultAccess.ts"];
      const [auth, declarations, vault, access] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)));
      const identity = auth.loadDevIdentityForDiagnostics(), actor = declarations.createActor(await auth.buildAgent(identity));
      const record = await vault.loadAccountVault(actor, access.accountVaultScope(identity.getPrincipal().toText()));
      return record.payload.rootFingerprint === expected.rootFingerprint && JSON.stringify(record.payload.passkeys) === expected.legacyBackup && !!record.payload.managedRecovery && record.payload.managedRecovery.verifiedOrigins.length === 0;
    }, seeded);
    expect(preserved, "Existing root and legacy backup stay unchanged; manager candidate remains unverified").toBe(true);
    expect(count.paid).toEqual([]); expect(count.blocked).toEqual([]);
    expect([...count.canisters]).toEqual([CANISTER]);
    expect(runtimeErrors).toEqual([]);
  } finally { secret = ""; }
});

for (const routePath of ["/openchat/import", "/openchat/connect.html"]) {
test(`route recovery gate: ${routePath} waits for verification and retains its pending transport`, async ({ context, page: opener }) => {
  const count = await monitor(context);
  const runtimeErrors: string[] = [];
  context.on("page", page => page.on("pageerror", () => runtimeErrors.push("Unhandled route runtime error")));
  let secret = "", plaintextRequestLeak = false;
  context.on("request", request => {
    if (!secret) return;
    const bytes = request.postDataBuffer(), raw = Buffer.from(secret.slice(5), "base64url");
    if (request.url().includes(secret) || request.url().includes(secret.slice(5)) ||
      (bytes && (bytes.includes(Buffer.from(secret)) || bytes.includes(Buffer.from(secret.slice(5))) || bytes.includes(raw)))) plaintextRequestLeak = true;
    raw.fill(0);
  });
  // A synthetic loopback opener, not a user profile or real OpenChat. No setup,
  // credentials, private fields or user account ever reach this test document.
  await context.route("http://localhost:4311/route-gate-test", route => route.fulfill({ contentType: "text/html", body:
    `<button id="open">Open synthetic route</button><script>
      window.replyTypes=[];
      window.addEventListener('message', event => { if(event.origin==='${ORIGIN}' && event.source===window.routeChild) window.replyTypes.push(event.data?.type); });
      document.querySelector('#open').onclick=()=>{window.routeChild=window.open('${ORIGIN}${routePath}','route-test');};
    </script>` }));
  await opener.goto("http://localhost:4311/route-gate-test");
  const opened = context.waitForEvent("page");
  await opener.getByRole("button", { name: "Open synthetic route", exact: true }).click();
  const page = await opened;
  await alignIsolatedPageClock(page);
  await page.waitForURL(ORIGIN + routePath);
  await expect(page.getByRole("heading", { name: routePath.endsWith("import") ? "Sign in to IOU" : "Connect IOU", exact: true })).toBeVisible();
  expect(count.paid).toEqual([]);
  if (routePath.endsWith("import")) {
    await page.getByRole("button", { name: /Sign in \(dev/ }).click();
  } else {
    // Connect intentionally offers only normal Internet Identity. Restore a fresh
    // synthetic dev identity on this route; never invoke an external II provider.
    await page.evaluate(async () => {
      const module = "/node_modules/.vite/deps/@dfinity_identity-secp256k1.js";
      const { Secp256k1KeyIdentity } = await import(/* @vite-ignore */ module);
      localStorage.setItem("iou:dev:identity:v1", JSON.stringify(Secp256k1KeyIdentity.generate().toJSON()));
    });
    await page.reload();
  }
  async function preparedCandidate() {
    await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /encryption passkey|Check saved passkey/i })).toHaveCount(0);
    const form = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Save using the password form$/ }) });
    if (await form.getAttribute("open") === null) await form.locator("summary").click();
    const field = page.getByLabel("Generated recovery password", { exact: true });
    await expect(field).toHaveAttribute("type", "password");
    return field.inputValue();
  }
  async function encryptedVaultReceipt() {
    return page.evaluate(async (canister) => {
      const paths = ["/src/features/auth/AuthProvider.tsx", "/src/backend/declarations.ts", "/src/features/auth/config.ts"];
      const [auth, declarations, config] = await Promise.all(paths.map(path => import(/* @vite-ignore */ path)));
      if (config.host !== "http://127.0.0.1:49175" || config.canisterId !== canister) throw new Error("Route test is not isolated");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("Synthetic identity not restored");
      const actor = declarations.createActor(await auth.buildAgent(identity));
      if (await actor.get_vetkd_key_name() !== "dfx_test_key") throw new Error("Route test refuses production keys");
      const [record] = await actor.get_account_vault();
      if (!record) throw new Error("Encrypted recovery candidate is missing");
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(record.payload)));
      return { revision: String(record.revision), hash: Array.from(hash).map(v => v.toString(16).padStart(2, "0")).join("") };
    }, CANISTER);
  }
  try {
    secret = await preparedCandidate();
    expect(/^IOU1-[A-Za-z0-9_-]{43}$/.test(secret), "Synthetic candidate format").toBe(true);
    const original = await encryptedVaultReceipt();
    expect(count.paid).toEqual(["acquire_account_root"]);
    // Both HTML/SPA connection entries and ordinary navigation must reuse the
    // encrypted candidate and must not implicitly approve or replace it.
    for (const next of ["/openchat/connect", "/openchat/import", "/pairs", routePath]) {
      await page.goto(ORIGIN + next);
      expect(await preparedCandidate() === secret, "Route navigation must retain the original recovery candidate").toBe(true);
      expect(await encryptedVaultReceipt()).toEqual(original);
      expect(count.paid).toEqual(["acquire_account_root"]);
    }
    await page.reload();
    expect(await preparedCandidate() === secret, "Reload must retain the original recovery candidate").toBe(true);
    expect(await encryptedVaultReceipt()).toEqual(original);
    // Queue only public connection metadata while the recovery UI hides the
    // session. Its listener must remain mounted; verification must not lose it.
    const message = routePath.endsWith("import")
      ? { type: "oc:app-import:connect", version: 1, connectionId: "A".repeat(43) }
      : { type: "oc:app-setup:connect", version: 1, connectionId: "A".repeat(43), appId: "iou" };
    await opener.evaluate(({ message, origin }) => {
      const target = (window as unknown as { routeChild: Window }).routeChild;
      target.postMessage(message, origin);
    }, { message, origin: ORIGIN });
    await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Open this draft from OpenChat|Choose the IOU account and sheet/ })).toHaveCount(0);
    expect(await opener.evaluate(() => (window as unknown as { replyTypes: string[] }).replyTypes)).toEqual([]);
    await page.getByRole("button", { name: "I saved the entry; verify it", exact: true }).click();
    expect(await page.getByLabel("Recovery password", { exact: true }).inputValue() === "").toBe(true);
    await autofillRecovery(page, secret);
    await page.getByRole("button", { name: "Verify autofilled entry", exact: true }).click();
    await expect(page.getByRole("heading", { name: routePath.endsWith("import") ? "Open this draft from OpenChat?" : "Choose the IOU account and sheet", exact: true })).toBeVisible();
    await expect(page.getByText("http://localhost:4311", { exact: !routePath.endsWith("import") })).toBeVisible();
    expect(await opener.evaluate(() => (window as unknown as { replyTypes: string[] }).replyTypes)).toEqual([]);
    expect(count.paid).toEqual(["acquire_account_root"]);
    expect(count.blocked).toEqual([]);
    expect([...count.canisters]).toEqual([CANISTER]);
    expect(plaintextRequestLeak, "Recovery secret must never enter a network request").toBe(false);
    expect(runtimeErrors, "Route gate must have no uncaught browser errors").toEqual([]);
  } finally { secret = ""; await page.close(); }
});
}

test("manager recovery: synthetic autofill across fresh Edge contexts, not real Microsoft sync", async () => {
  // This exercises real encryption/backend calls and ordinary password fields.
  // Supplying the test secret simulates autofill; it does NOT prove manager save/sync.
  // The isolated config disables traces/screenshots; never log or persist this secret.
  const browser = await chromium.launch({ headless: true, executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" });
  let secret = "";
  let plaintextRequestLeak = false;
  const runtimeErrors: string[] = [];
  function watchPlaintext(context: BrowserContext) {
    context.on("page", target => target.on("pageerror", () => runtimeErrors.push("Unhandled browser runtime error")));
    context.on("request", request => {
      if (!secret) return;
      const bytes = request.postDataBuffer();
      const url = request.url();
      const raw = Buffer.from(secret.slice(5), "base64url");
      if (url.includes(secret) || url.includes(secret.slice(5)) ||
          (bytes && (bytes.includes(Buffer.from(secret)) || bytes.includes(Buffer.from(secret.slice(5))) || bytes.includes(raw)))) plaintextRequestLeak = true;
      raw.fill(0);
    });
  }
  async function noWebStorageSecret(page: Page) {
    const leaked = await page.evaluate(value => [localStorage, sessionStorage].some(storage =>
      Object.keys(storage).some(key => key.includes(value) || key.includes(value.slice(5)) ||
        (storage.getItem(key) ?? "").includes(value) || (storage.getItem(key) ?? "").includes(value.slice(5)))), secret);
    expect(leaked, "The recovery credential must not be written to Web Storage").toBe(false);
  }
  async function syntheticAutofill(page: Page, value: string) {
    // Do not use a value-bearing assertion or retain Playwright fill diagnostics.
    try { await page.getByLabel("Recovery password", { exact: true }).fill(value); }
    catch { throw new Error("Synthetic recovery-field autofill failed"); }
  }
  try {
    const primary = await browser.newContext({ baseURL: ORIGIN });
    primary.setDefaultTimeout(25_000); watchPlaintext(primary);
    const count = await monitor(primary);
    const page = await primary.newPage();
    await alignIsolatedPageClock(page);
    await signIn(page);
    await assertManagerOnlyControls(page);
    expect(count.paid).toEqual(["acquire_account_root"]);
    const identity = await page.evaluate(() => localStorage.getItem("iou:dev:identity:v1"));
    expect(!!identity).toBe(true);
    const saveForm = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Save using the password form$/ }) });
    if (await saveForm.getAttribute("open") === null) await saveForm.locator("summary").click();
    const generated = page.getByLabel("Generated recovery password", { exact: true });
    await expect(generated).toHaveAttribute("type", "password");
    secret = await generated.inputValue();
    expect(/^IOU1-[A-Za-z0-9_-]{43}$/.test(secret), "A random 256-bit recovery credential is required").toBe(true);
    await noWebStorageSecret(page);
    await page.getByRole("button", { name: "Cancel saving", exact: true }).click();
    await expect(generated).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Prepare the same recovery entry again", exact: true })).toBeVisible();
    await expect(generated).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
    if (await saveForm.getAttribute("open") === null) await saveForm.locator("summary").click();
    expect(await generated.inputValue() === secret, "Cancellation and reload must retain the same encrypted recovery candidate").toBe(true);
    await page.getByRole("button", { name: "I saved the entry; verify it", exact: true }).click();
    await expect(generated).toHaveCount(0);
    expect(await page.getByLabel("Recovery password", { exact: true }).inputValue() === "").toBe(true);
    const wrongSecret = "IOU1-" + "A".repeat(43);
    await syntheticAutofill(page, wrongSecret);
    await page.getByRole("button", { name: "Verify autofilled entry", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: /Recovery could not finish/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
    expect(await page.getByLabel("Recovery password", { exact: true }).inputValue() === "").toBe(true);
    await syntheticAutofill(page, secret);
    await page.getByRole("button", { name: "Verify autofilled entry", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your accounts", exact: true })).toBeVisible();
    await noWebStorageSecret(page);
    const sheet = await createAccount(page, "Manager recovery synthetic", "Original encrypted sheet");
    await page.getByRole("button", { name: "+ Add entry" }).click();
    const entry = page.getByRole("dialog");
    await entry.locator("select").first().selectOption("USD");
    await entry.locator('input[type="number"]').first().fill("43");
    await entry.getByRole("radio", { name: "Owed to you", exact: true }).check();
    await entry.getByRole("radio", { name: "IOU (owed, has due date)", exact: true }).check();
    const note = "original ciphertext recovered with synthetic manager autofill";
    await entry.locator('input[placeholder="lunch, taxi, etc."]').fill(note);
    await entry.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(entry).toHaveCount(0);
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    expect(count.paid).toEqual(["acquire_account_root"]);
    expect(count.blocked).toEqual([]);
    expect([...count.canisters]).toEqual([CANISTER]);
    const secondary = await browser.newContext({ baseURL: ORIGIN });
    secondary.setDefaultTimeout(25_000); watchPlaintext(secondary);
    const secondCount = await monitor(secondary);
    const second = await secondary.newPage();
    await alignIsolatedPageClock(second);
    await second.goto(ORIGIN + "/sign-in");
    // ONLY synthetic authentication is copied. No IndexedDB, storageState or device keys.
    await second.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
    await second.goto(ORIGIN + "/sheet/" + sheet);
    await expect(second.getByRole("heading", { name: "Unlock account encryption", exact: true })).toBeVisible();
    await expect(second.getByText(note, { exact: true })).toHaveCount(0);
    expect(secondCount.paid).toEqual([]);
    await syntheticAutofill(second, wrongSecret);
    await second.getByRole("button", { name: "Unlock with autofilled entry", exact: true }).click();
    await expect(second.getByRole("status").filter({ hasText: /Recovery could not finish/ })).toBeVisible();
    await expect(second.getByRole("heading", { name: "Unlock account encryption", exact: true })).toBeVisible();
    expect(secondCount.paid).toEqual([]);
    await syntheticAutofill(second, secret);
    await second.getByRole("button", { name: "Unlock with autofilled entry", exact: true }).click();
    await expect(second.getByText(note, { exact: true })).toBeVisible();
    await second.reload();
    await expect(second.getByText(note, { exact: true })).toBeVisible();
    await noWebStorageSecret(second);
    expect(secondCount.paid).toEqual([]);
    expect(secondCount.blocked).toEqual([]);
    expect([...secondCount.canisters]).toEqual([CANISTER]);
    expect(plaintextRequestLeak, "No request may contain the plaintext recovery credential").toBe(false);
    expect(runtimeErrors, "Manager recovery must have no uncaught browser runtime errors").toEqual([]);
  } finally { secret = ""; await browser.close(); }
});

test("legacy sheet migration: available original key is free and missing key requires sheet-local paid consent", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: ORIGIN });
  const runtimeErrors: string[] = [];
  context.on("page", target => target.on("pageerror", () => runtimeErrors.push("Unhandled browser runtime error")));
  const count = await monitor(context);
  const page = await context.newPage();
  try {
    await alignIsolatedPageClock(page);
    await signIn(page);
    await enrollManagedRecovery(page);
    expect(count.paid).toEqual(["acquire_account_root"]);
    const freeNote = "Original local legacy ciphertext preserved";
    const paidNote = "Original VetKD legacy ciphertext preserved";
    const seeded = await page.evaluate(async ({ freeNote, paidNote, canister }) => {
      const module = (path: string) => {
        const loaded = performance.getEntriesByType("resource").map(entry => entry.name).reverse().find(name => new URL(name).pathname === path);
        return import(/* @vite-ignore */ loaded ?? path);
      };
      const [auth, declarations, dev, prod, types, config] = await Promise.all([
        module("/src/features/auth/AuthProvider.tsx"), module("/src/backend/declarations.ts"),
        module("/src/features/crypto/devVetkd.ts"), module("/src/features/crypto/prodVetkd.ts"),
        module("/src/features/entries/types.ts"), module("/src/features/auth/config.ts"),
      ]);
      if (config.host !== "http://127.0.0.1:49175" || config.canisterId !== canister || !prod.isProdVetkd()) throw new Error("Legacy fixture is not isolated production cryptography");
      const identity = auth.loadDevIdentityForDiagnostics();
      if (!identity) throw new Error("Synthetic development sign-in is required");
      const principal = identity.getPrincipal().toText();
      const actor = declarations.createActor(await auth.buildAgent(identity));
      if (await actor.get_vetkd_key_name() !== "dfx_test_key") throw new Error("Legacy fixture refuses a mainnet key");
      const hash = async (bytes: Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))));
      async function addOriginal(sheetId: string, key: Uint8Array, note: string, nameKey = key) {
        const name = await dev.encryptName(nameKey, note);
        await actor.set_sheet_name(sheetId, name.enc, name.iv);
        const plaintext = types.encodeEntry({ ts: Date.now(), kind: "expense", currency: "USD", amount_minor: 1425, direction: "credit", note, txn_type: "iou" });
        try {
          const encrypted = await dev.encryptEntryPayload(plaintext, key);
          const saved = await actor.add_entry({ sheet_id: sheetId, entry_key: Array.from(encrypted.entryKey), iv: Array.from(encrypted.iv), ciphertext: Array.from(encrypted.ciphertext) });
          if (new TextDecoder().decode(new Uint8Array(saved.ciphertext)).includes(note)) throw new Error("Synthetic ledger unexpectedly contains plaintext");
          return hash(new Uint8Array(saved.ciphertext));
        } finally { plaintext.fill(0); }
      }
      // Explicit test seeding creates the old device key. The application read
      // path must only load it, never create one or derive a paid replacement.
      const oldPair = await dev.deriveUserKeypair(principal);
      const originalKey = dev.newSheetKey();
      let free;
      try {
        const pair = await actor.create_pair();
        const wrapped = await dev.wrapSheetKey(originalKey, oldPair.publicKey, oldPair.privateKey);
        const sheet = await actor.create_sheet({ pair_id: pair.pair_id, closing_window_days: 30,
          wrapped_key_a: Array.from(wrapped), wrapped_key_b: [], name_enc: [], name_iv: [] });
        free = { id: sheet.id as string, digest: await addOriginal(sheet.id, originalKey, freeNote) };
      } finally { originalKey.fill(0); }
      // Historical production sheets could retain a self-wrapped temporary key
      // and a name encrypted with it, while entries used the actual VetKD key.
      // Having that old device key must not turn the placeholder into a valid
      // migration candidate merely because it decrypts the sheet's name.
      const placeholderKey = dev.newSheetKey();
      let oldVetkdKey: Uint8Array | undefined;
      let paid;
      try {
        const pair = await actor.create_pair();
        const placeholderWrap = await dev.wrapSheetKey(placeholderKey, oldPair.publicKey, oldPair.privateKey);
        const sheet = await actor.create_sheet({ pair_id: pair.pair_id, closing_window_days: 30,
          wrapped_key_a: Array.from(placeholderWrap), wrapped_key_b: [], name_enc: [], name_iv: [] });
        // One real local test-key derivation prepares authoritative OLD entries.
        // It is counted separately from subsequent user-approved migration.
        const prepared = await prod.prepareProdSheetKey(actor);
        oldVetkdKey = await prod.deriveProdSheetKey(actor, sheet.id, prepared);
        paid = { id: sheet.id as string, digest: await addOriginal(sheet.id, oldVetkdKey, paidNote, placeholderKey) };
      } finally { placeholderKey.fill(0); oldVetkdKey?.fill(0); }
      return { free, paid };
    }, { freeNote, paidNote, canister: CANISTER });
    const seededPaid = ["acquire_account_root", "vetkd_wrap_sheet_key"];
    expect(count.paid).toEqual(seededPaid);
    async function verifySavedEnvelope(sheetId: string, originalDigest: string) {
      const result = await page.evaluate(async ({ sheetId, originalDigest }) => {
        const module = (path: string) => {
          const loaded = performance.getEntriesByType("resource").map(entry => entry.name).reverse().find(name => new URL(name).pathname === path);
          return import(/* @vite-ignore */ loaded ?? path);
        };
        const [auth, declarations] = await Promise.all([module("/src/features/auth/AuthProvider.tsx"), module("/src/backend/declarations.ts")]);
        const identity = auth.loadDevIdentityForDiagnostics();
        if (!identity) throw new Error("Synthetic identity was lost");
        const actor = declarations.createActor(await auth.buildAgent(identity));
        const wrapper = new Uint8Array((await actor.get_sheet_wrapped_key(sheetId))[0] ?? []);
        const entries = await actor.list_entries(sheetId, [], 10);
        if (entries.entries.length !== 1) throw new Error("Legacy migration changed the number of original entries");
        const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(entries.entries[0].ciphertext)))));
        return { backedUp: new TextDecoder().decode(wrapper).startsWith("iou-sheet-envelope-v1:"), originalUnchanged: digest === originalDigest };
      }, { sheetId, originalDigest });
      expect(result).toEqual({ backedUp: true, originalUnchanged: true });
    }
    await page.goto(ORIGIN + "/sheet/" + seeded.free.id);
    await expect(page.getByText(freeNote, { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Unlock this older sheet", exact: true })).toHaveCount(0);
    await verifySavedEnvelope(seeded.free.id, seeded.free.digest);
    await page.reload();
    await expect(page.getByText(freeNote, { exact: true }).last()).toBeVisible();
    expect(count.paid).toEqual(seededPaid);

    await page.goto(ORIGIN + "/sheet/" + seeded.paid.id);
    const gate = page.getByRole("region", { name: "Unlock this older sheet", exact: true });
    await expect(page.getByRole("heading", { name: "Unlock this older sheet", exact: true })).toBeVisible();
    await expect(page.getByText(paidNote, { exact: true })).toHaveCount(0);
    expect(count.paid).toEqual(seededPaid);
    await gate.getByRole("button", { name: "Recover this sheet (paid VetKD)", exact: true }).click();
    await expect(gate.getByRole("button", { name: "Confirm paid recovery for this sheet", exact: true })).toBeVisible();
    expect(count.paid).toEqual(seededPaid);
    await gate.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(gate.getByRole("button", { name: "Confirm paid recovery for this sheet", exact: true })).toHaveCount(0);
    await gate.getByRole("button", { name: "Check for an available key (no VetKD)", exact: true }).click();
    await expect(gate.getByRole("button", { name: "Check for an available key (no VetKD)", exact: true })).toBeEnabled();
    expect(count.paid).toEqual(seededPaid);
    // Real in-app SPA navigation must discard the old confirmation state.
    await gate.getByRole("button", { name: "Recover this sheet (paid VetKD)", exact: true }).click();
    await page.getByTitle("Profile & settings", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { name: "Unlock this older sheet", exact: true })).toBeVisible();
    await expect(gate.getByRole("button", { name: "Confirm paid recovery for this sheet", exact: true })).toHaveCount(0);
    expect(count.paid).toEqual(seededPaid);
    await gate.getByRole("button", { name: "Recover this sheet (paid VetKD)", exact: true }).click();
    await gate.getByRole("button", { name: "Confirm paid recovery for this sheet", exact: true }).click();
    await expect(page.getByText(paidNote, { exact: true }).last()).toBeVisible();
    await verifySavedEnvelope(seeded.paid.id, seeded.paid.digest);
    const recoveredPaid = [...seededPaid, "vetkd_wrap_sheet_key"];
    expect(count.paid).toEqual(recoveredPaid);
    await page.reload();
    await expect(page.getByText(paidNote, { exact: true }).last()).toBeVisible();
    expect(count.paid).toEqual(recoveredPaid);
    expect(count.blocked).toEqual([]);
    expect([...count.canisters]).toEqual([CANISTER]);
    expect(runtimeErrors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("automatic test-key setup, mandatory manager recovery, fresh app storage, restart, emergency and shared logout", async ({ browser }) => {
  if (process.env.IOU_TEST_ADVANCE_CLOCK !== "1") throw new Error("This isolated-only test requires explicit IOU_TEST_ADVANCE_CLOCK=1 permission to verify the 24-hour recovery cooldown");
  const profile = mkdtempSync("F:/Temp/OpenChat-IOU/account-vault-browser-");
  const options = { headless: true, executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", baseURL: ORIGIN };
  let primary = await chromium.launchPersistentContext(profile, options);
  primary.setDefaultTimeout(25_000);
  const runtimeErrors: string[] = [];
  const watchPageErrors = (target: Page) => target.on("pageerror", error => {
    // Record only allowlisted diagnostics: provider failures must not put
    // credentials, invite fragments or other secret values into test artifacts.
    const detail = error.message === "useAuth must be used inside AuthProvider"
      ? error.message : "Unhandled browser runtime error";
    const kind = ["Error", "TypeError", "ReferenceError", "SyntaxError"].includes(error.name) ? error.name : "Error";
    runtimeErrors.push(`${kind}: ${detail}`);
  });
  const watchContextErrors = (context: BrowserContext) => {
    for (const target of context.pages()) watchPageErrors(target);
    context.on("page", watchPageErrors);
  };
  watchContextErrors(primary);
  let count = await monitor(primary);
  let page = primary.pages()[0] ?? await primary.newPage();
  await alignIsolatedPageClock(page);
  console.log("[vault UI] sign in");
  await signIn(page);
  expect(count.paid).toEqual(["acquire_account_root"]);
  expect([...count.canisters]).toEqual([CANISTER]);
  console.log("[vault UI] verified latest local canister", CANISTER);
  console.log("[vault UI] real bootstrap completed");
  await expect(page.getByRole("button", { name: /Set up account encryption|Create recovery code|Continue to IOU/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your accounts" })).toHaveCount(0);
  const identity = await page.evaluate(() => localStorage.getItem("iou:dev:identity:v1"));
  expect(identity).toBeTruthy();
  await assertManagerOnlyControls(page);
  // Cancelling saving must retain the initial account keys but keep encrypted
  // features gated. No visible PRF ceremony or paid fallback is available here.
  await page.getByRole("button", { name: "Cancel saving", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Your accounts" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  let recoverySecret = await enrollManagedRecovery(page);
  console.log("[vault UI] cancelled manager enrollment remained gated across reload; separate autofill verification entered IOU");
  const first = await createAccount(page, "Vault Alpha", "Vault First");
  console.log("[vault UI] first random-key sheet created");
  await page.getByRole("button", { name: "+ Add entry" }).click();
  const entry = page.getByRole("dialog");
  await entry.locator("select").first().selectOption("USD");
  await entry.locator('input[type="number"]').first().fill("37");
  await entry.getByRole("radio", { name: "Owed to you", exact: true }).check();
  await entry.getByRole("radio", { name: "IOU (owed, has due date)", exact: true }).check();
  await entry.locator('input[placeholder="lunch, taxi, etc."]').fill("encrypted vault acceptance");
  await entry.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(entry).toHaveCount(0);
  await createAccount(page, "Vault Beta", "Vault Second");
  await page.goto(ORIGIN + "/sheet/" + first);
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  expect(count.blocked).toEqual([]);
  console.log("[vault UI] two sheets and entry reload completed");
  // A genuinely separate device receives only synthetic authentication, never
  // IndexedDB keys. A missing recovery entry must not buy emergency recovery.
  const secondary = await browser.newContext();
  watchContextErrors(secondary);
  const secondaryCount = await monitor(secondary);
  const secondPage = await secondary.newPage();
  await alignIsolatedPageClock(secondPage);
  await secondPage.goto(ORIGIN + "/sign-in");
  await secondPage.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
  await secondPage.goto(ORIGIN + "/sheet/" + first);
  await expect(secondPage.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
  await expect(secondPage.getByText("encrypted vault acceptance", { exact: true })).toHaveCount(0);
  await expect(secondPage.getByLabel("Recovery code", { exact: true })).toHaveCount(0);
  await assertManagerOnlyControls(secondPage);
  expect(secondaryCount.paid).toEqual([]);
  expect(secondaryCount.blocked).toEqual([]);
  await secondary.close();
  // Delete ONLY this dedicated synthetic app's local vault database. Restore
  // from its ordinary manager entry in test memory, not copied device keys.
  // Synthetic autofill does not claim actual password-manager cloud sync.
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const deletion = indexedDB.deleteDatabase("iou-account-vault-v1");
      deletion.onsuccess = () => resolve(); deletion.onerror = () => reject(deletion.error);
      deletion.onblocked = () => reject(new Error("Synthetic vault database stayed open"));
    });
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
  await assertManagerOnlyControls(page);
  await autofillRecovery(page, recoverySecret);
  await page.getByRole("button", { name: "Unlock with autofilled entry", exact: true }).click();
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  console.log("[vault UI] manager backup decrypted original ciphertext after removing the synthetic device root; cloud sync not claimed");
  if (process.env.IOU_TEST_EMULATOR_CDP) {
    if (process.env.IOU_TEST_EMULATOR_CDP !== "http://127.0.0.1:49310") throw new Error("Only the scoped emulator debug port is allowed");
    const mobileBrowser = await chromium.connectOverCDP(process.env.IOU_TEST_EMULATOR_CDP);
    const mobileContext = mobileBrowser.contexts()[0];
    const mobile = await mobileContext.newPage();
    watchPageErrors(mobile);
    mobile.setDefaultTimeout(60_000);
    await mobile.bringToFront();
    const mobileSession = await mobileContext.newCDPSession(mobile);
    await mobileSession.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const mobileCount = await monitor(mobile);
    let priorMobileIdentity: string | null = null;
    let mobileRecoverySecret = "";
    try {
      // Separate synthetic account, not copied app roots or manager secrets
      // from desktop; actual synced provider credentials are out of scope.
      // Open only the owned test origin without running an older synthetic login.
      await mobile.route(ORIGIN + "/sign-in", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Isolated vault fixture setup</title>" }), { times: 1 });
      await mobile.goto(ORIGIN + "/sign-in");
      await alignIsolatedPageClock(mobile);
      priorMobileIdentity = await mobile.evaluate(() => localStorage.getItem("iou:dev:identity:v1"));
      const mobileIdentity = await mobile.evaluate(async () => {
        const path = "/node_modules/.vite/deps/@dfinity_identity-secp256k1.js";
        const { Secp256k1KeyIdentity } = await import(/* @vite-ignore */ path);
        const value = JSON.stringify(Secp256k1KeyIdentity.generate().toJSON());
        localStorage.setItem("iou:dev:identity:v1", value);
        return value;
      });
      await mobile.goto(ORIGIN + "/pairs");
      await expect(mobile.getByRole("heading", { name: "Save your recovery entry" })).toBeVisible();
      await expect(mobile.getByRole("button", { name: /Continue to IOU|Create recovery code/ })).toHaveCount(0);
      mobileRecoverySecret = await enrollManagedRecovery(mobile);
      const mobileSheet = await createAccount(mobile, "Mobile vault acceptance", "Mobile manager sheet", ORIGIN);
      await expect(mobile.getByRole("heading", { name: "Balances", exact: true })).toBeVisible();
      await mobile.getByRole("button", { name: "+ Add entry" }).click();
      const mobileEntry = mobile.getByRole("dialog");
      await mobileEntry.locator("select").first().selectOption("USD");
      await mobileEntry.locator('input[type="number"]').first().fill("19");
      await mobileEntry.getByRole("radio", { name: "Owed to you", exact: true }).check();
      await mobileEntry.getByRole("radio", { name: "IOU (owed, has due date)", exact: true }).check();
      await mobileEntry.locator('input[placeholder="lunch, taxi, etc."]').fill("mobile encrypted vault acceptance");
      await mobileEntry.getByRole("button", { name: "Add entry", exact: true }).click();
      await expect(mobileEntry).toHaveCount(0);
      await mobile.reload();
      await expect(mobile.getByText("mobile encrypted vault acceptance", { exact: true })).toBeVisible({ timeout: 60_000 });
      await mobile.goto(ORIGIN + "/settings");
      await mobile.getByRole("button", { name: "Sign out", exact: true }).click();
      await unlockManagedRecovery(mobile, mobileIdentity, mobileRecoverySecret);
      await mobile.goto(ORIGIN + "/sheet/" + mobileSheet);
      await expect(mobile.getByText("mobile encrypted vault acceptance", { exact: true })).toBeVisible();
      expect(mobileCount.paid).toEqual(["acquire_account_root"]);
      expect(mobileCount.blocked).toEqual([]);
      console.log("[vault UI] Android emulator automatic setup, required manager recovery, random sheet, reload and logout-unlock completed");
    } catch (error) {
      console.log("[vault mobile diagnostic]", JSON.stringify({ path: new URL(mobile.url()).pathname,
        headings: await mobile.locator("h1,h2,h3").allTextContents(), statuses: await mobile.getByRole("status").allTextContents() }));
      throw error;
    } finally {
      mobileRecoverySecret = "";
      await mobile.evaluate(value => {
        if (value === null) localStorage.removeItem("iou:dev:identity:v1");
        else localStorage.setItem("iou:dev:identity:v1", value);
      }, priorMobileIdentity);
      await mobileSession.detach();
      await mobile.close();
      // Never close the CDP browser: that would terminate unrelated emulator tabs.
    }
  }
  // Explicit signout erases the device vault. The same manager entry unlocks it without VetKD.
  await page.goto(ORIGIN + "/settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
  await assertManagerOnlyControls(page);
  await autofillRecovery(page, recoverySecret);
  await page.getByRole("button", { name: "Unlock with autofilled entry", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]);
  console.log("[vault UI] manager unlock after explicit logout completed");
  await primary.close();
  primary = await chromium.launchPersistentContext(profile, options);
  primary.setDefaultTimeout(25_000);
  watchContextErrors(primary);
  count = await monitor(primary);
  page = primary.pages()[0] ?? await primary.newPage();
  await alignIsolatedPageClock(page);
  await page.goto(ORIGIN + "/sheet/" + first);
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual([]);
  console.log("[vault UI] actual browser restart restored encrypted entry");
  const anotherTab = await primary.newPage();
  await anotherTab.goto(ORIGIN + "/sheet/" + first);
  await expect(anotherTab.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  await page.goto(ORIGIN + "/settings");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(anotherTab.getByText("encrypted vault acceptance", { exact: true })).toHaveCount(0);
  await page.evaluate(value => localStorage.setItem("iou:dev:identity:v1", value), identity!);
  await page.goto(ORIGIN + "/pairs");
  await expect(page.getByRole("heading", { name: "Unlock account encryption" })).toBeVisible();
  expect(count.paid).toEqual([]);
  await assertManagerOnlyControls(page);
  await page.getByText("Lost your recovery entry and remembered device keys?", { exact: true }).click();
  await page.getByRole("button", { name: "Recover encryption access (paid VetKD)", exact: true }).click();
  await expect(page.getByText("emergency root recovery is limited to once per 24 hours", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root"]); // Admission denied: no management derivation.
  const clock = await isolatedClock("GET");
  const currentTime = await clock.json() as { nanos_since_epoch: number };
  const advancedMilliseconds = Math.ceil(currentTime.nanos_since_epoch / 1_000_000) + 86_460_000;
  await isolatedClock("POST", '{"nanos_since_epoch":' + (BigInt(advancedMilliseconds) * 1_000_000n) + '}');
  // This is our dedicated desktop context, never the shared emulator context.
  await page.clock.setFixedTime(new Date(advancedMilliseconds));
  // No logout or reload: a definite rejection must permit a fresh explicit retry.
  await page.getByRole("button", { name: "Recover encryption access (paid VetKD)", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your accounts" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root", "acquire_account_root"]);
  const verifiedAgain = await enrollManagedRecovery(page, true);
  expect(verifiedAgain === recoverySecret, "Emergency recovery must reuse the same existing manager backup, not replace it").toBe(true);
  await page.goto(ORIGIN + "/sheet/" + first);
  await expect(page.getByText("encrypted vault acceptance", { exact: true })).toBeVisible();
  expect(count.paid).toEqual(["acquire_account_root", "acquire_account_root"]);
  expect(count.blocked).toEqual([]);
  console.log("[vault UI] cooldown denied without charge; explicit +24h retry required manager verification before decrypting original ciphertext");
  recoverySecret = "";
  await primary.close();
  expect(runtimeErrors, "The complete legacy recovery flow must have no uncaught browser runtime errors").toEqual([]);
});
