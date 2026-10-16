import { test, expect, type Page } from "@playwright/test";
import { Cbor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { createAccount } from "./flows";

const ORIGIN = "http://localhost:4310";
const HOST = "http://127.0.0.1:49175";
const CANISTER = process.env.IOU_TEST_VAULT_CANISTER;
if (!CANISTER || Principal.fromText(CANISTER).toText() !== CANISTER || CANISTER === "2vxsx-fae") {
  throw new Error("IOU_TEST_VAULT_CANISTER must explicitly name the canonical isolated local canister principal");
}
const NOTE = "Synthetic account-vault inbox acceptance";
const PAID = new Set(["acquire_account_root", "vetkd_wrap_consumer_key", "vetkd_wrap_sheet_key", "openchat_card_context", "openchat_private_match_context"]);
const CONTROL = new URL(process.env.IOU_TEST_POCKETIC_CONTROL_URL ?? "");
const INSTANCE = process.env.IOU_TEST_POCKETIC_INSTANCE ?? "";
if (CONTROL.protocol !== "http:" || CONTROL.hostname !== "127.0.0.1" || !CONTROL.port || CONTROL.pathname !== "/" ||
  CONTROL.search || CONTROL.hash || CONTROL.username || CONTROL.password || !/^(0|[1-9][0-9]{0,5})$/.test(INSTANCE)) {
  throw new Error("Choose an explicit owned loopback PocketIC control URL and instance number");
}
async function alignIsolatedPageClock(page: Page) {
  // Read-only alignment permits this owned fixture to follow a cooldown test.
  // The browser's synthetic page changes; host and canister clocks do not.
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(CONTROL.origin + "/instances/" + INSTANCE + "/read/get_time");
    if (response.status === 409) { await new Promise(resolve => setTimeout(resolve, 75 + attempt * 17)); continue; }
    if (!response.ok) throw new Error("Isolated clock HTTP " + response.status);
    const current = await response.json() as { nanos_since_epoch: number };
    const offset = Math.floor(current.nanos_since_epoch / 1_000_000) - Date.now();
    await page.addInitScript((delta) => {
      // Keep native performance/resource timing: it resolves the exact running
      // Vite module below. Playwright's full clock shim empties those entries.
      const NativeDate = Date;
      globalThis.Date = new Proxy(NativeDate, {
        construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [target.now() + delta], newTarget); },
        apply(target) { return new target(target.now() + delta).toString(); },
        get(target, key, receiver) { return key === "now" ? () => target.now() + delta : Reflect.get(target, key, receiver); },
      });
    }, offset);
    return;
  }
  throw new Error("The isolated PocketIC clock remained busy");
}

for (const missingDate of [false, true]) {
test(`vault-backed generic inbox reconnect, encrypted delivery, ${missingDate ? "missing-date correction" : "dated review"} and persisted UI save do not buy another key`, async ({ context, page }) => {
  const paid: string[] = [], methods: string[] = [], blocked: string[] = [];
  const runtimeErrors: string[] = [];
  page.on("pageerror", () => runtimeErrors.push("Unhandled browser runtime error"));
  await page.addInitScript(() => performance.setResourceTimingBufferSize(3000));
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    const allowed = (url.origin === ORIGIN || url.origin === HOST) &&
      (!url.pathname.includes("/canister/") || url.pathname.includes(`/canister/${CANISTER}/`));
    if (["http:", "https:"].includes(url.protocol) && !allowed) { blocked.push(url.origin); await route.abort(); return; }
    await route.continue();
  });
  context.on("request", request => {
    if (!request.url().startsWith(HOST + "/api/")) return;
    const data = request.postDataBuffer(); if (!data) return;
    try {
      const method = Cbor.decode<{ content?: { method_name?: string } }>(data).content?.method_name;
      if (method) { methods.push(method); if (PAID.has(method)) paid.push(method); }
    } catch { /* Non-CBOR transport requests carry no method name. */ }
  });
  await alignIsolatedPageClock(page);
  await page.goto(ORIGIN + "/sign-in");
  expect(await page.evaluate(async ({ host, canister }) => {
    const path = "/src/features/auth/config.ts"; const config = await import(/* @vite-ignore */ path);
    return config.host === host && config.canisterId === canister;
  }, { host: HOST, canister: CANISTER })).toBe(true);
  await page.getByRole("button", { name: /Sign in \(dev/ }).click();
  await expect(page.getByRole("heading", { name: "Save your recovery entry", exact: true })).toBeVisible();
  expect(paid).toEqual(["acquire_account_root"]);
  await expect(page.getByRole("button", { name: /Continue to IOU|Create recovery code|Set up account encryption/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /encryption passkey|Check saved passkey/i })).toHaveCount(0);
  // Login prepares the manager entry automatically, without another user action.
  await expect(page.getByLabel("Generated recovery password", { exact: true })).toHaveAttribute("type", "password");
  const saveForm = page.locator("details").filter({ has: page.locator("summary", { hasText: /^Save using the password form$/ }) });
  if (await saveForm.getAttribute("open") === null) await saveForm.locator("summary").click();
  const generated = page.getByLabel("Generated recovery password", { exact: true });
  await expect(generated).toHaveAttribute("type", "password");
  let recoverySecret = await generated.inputValue();
  try {
    expect(/^IOU1-[A-Za-z0-9_-]{43}$/.test(recoverySecret)).toBe(true);
    await page.getByRole("button", { name: "I saved the entry; verify it", exact: true }).click();
    await expect(generated).toHaveCount(0);
    expect(await page.getByLabel("Recovery password", { exact: true }).inputValue() === "").toBe(true);
    try { await page.getByLabel("Recovery password", { exact: true }).fill(recoverySecret); }
    catch { throw new Error("Synthetic manager autofill failed"); }
    await page.getByRole("button", { name: "Verify autofilled entry", exact: true }).click();
  } finally { recoverySecret = ""; }
  await expect(page.getByRole("heading", { name: "Your accounts" })).toBeVisible();
  const sheetId = await createAccount(page, "Synthetic inbox account", "Vault inbox sheet");
  await expect(page.getByRole("heading", { name: "Balances", exact: true })).toBeVisible();

  const delivery = await page.evaluate(async ({ sheetId, note, host, canister, missingDate }) => {
    // Reuse the running app's exact HMR module instances: importing the bare
    // path after Vite adds ?t= would otherwise create a second auth/key session.
    const module = (path: string) => {
      const loaded = performance.getEntriesByType("resource").map(entry => entry.name).reverse().find(name => new URL(name).pathname === path);
      return import(/* @vite-ignore */ loaded ?? path);
    };
    const [identityModule, auth, declarations, consumer, encryption, inbox] = await Promise.all([
      module("/node_modules/.vite/deps/@dfinity_identity-secp256k1.js"), module("/src/features/auth/AuthProvider.tsx"),
      module("/src/backend/declarations.ts"), module("/src/features/openchat/consumerKeypair.ts"),
      module("/src/features/openchat/localImportEncryption.ts"), module("/src/features/openchat/durableInboxService.ts"),
    ]);
    // This fresh profile's synthetic identity is used only inside its browser.
    // No private identity, capability, key, passkey output or backup code leaves it.
    const stored = localStorage.getItem("iou:dev:identity:v1");
    if (!stored) throw new Error("Synthetic sign-in was not established");
    const identity = identityModule.Secp256k1KeyIdentity.fromJSON(stored);
    const principal = identity.getPrincipal().toText();
    const actor = declarations.createActor(await auth.buildAgent(identity));
    if (await actor.get_vetkd_key_name() !== "dfx_test_key") throw new Error("Synthetic test refuses a production VetKD key");
    const sheet = (await actor.get_sheet(sheetId))[0];
    if (!sheet) throw new Error("Synthetic sheet is unavailable");
    if (consumer.captureConsumerKeypairSession().principal !== principal) {
      const modules = performance.getEntriesByType("resource").map(entry => entry.name).filter(name => /consumerKeypair|ConsumerKeypairSync|AuthProvider/.test(new URL(name).pathname));
      throw new Error("Synthetic harness did not import the active consumer session: " + JSON.stringify(modules));
    }
    const ticket = consumer.captureConsumerKeypairSession(principal);
    const key = await consumer.loadOrCreateConsumerKeypair(ticket);
    const before = await actor.get_consumer_keypair();
    const deliveryContext = { principal, backendHost: host, backendCanisterId: canister, pairId: sheet.pair_id, sheetId };
    const recipient = await encryption.createLocalDeliveryEncryption(key.publicKey, deliveryContext);
    const destination = location.origin + "/openchat/import";
    const binding = { appId: "iou", appRevision: encryption.IOU_LOCAL_APP_REVISION, actionId: "iou.entry.import", destination, recipient };
    const connect = () => inbox.createDurableInboxGrant({ actor, binding, host, canisterId: canister, assertCurrent: () => {} });
    const first = await connect();
    const reloadedKey = await consumer.loadExistingConsumerKeypair(ticket);
    const reconnected = await connect();
    const after = await actor.get_consumer_keypair();
    if (before.mutation_epoch !== after.mutation_epoch || key.publicKeySpkiPem !== reloadedKey.publicKeySpkiPem || first.inboxId === reconnected.inboxId) throw new Error("Reconnect unexpectedly changed the delivery key");
    const importId = encryption.localDeliveryBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
    const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: key.publicKey }, ephemeral.privateKey, 256);
    const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
    new Uint8Array(shared).fill(0);
    const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: new TextEncoder().encode(encryption.LOCAL_DELIVERY_DOMAIN) }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const request = { importId, appId: binding.appId, appRevision: binding.appRevision, actionId: binding.actionId, destination,
      envelope: { version: 1, scheme: encryption.LOCAL_DELIVERY_SCHEME, keyId: recipient.keyId, recipientContext: recipient.recipientContext,
        ephemeralPublicKey: encryption.localDeliveryBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
        salt: encryption.localDeliveryBase64Url(salt), iv: encryption.localDeliveryBase64Url(iv), ciphertext: "" } };
    const plaintext = new TextEncoder().encode(JSON.stringify({ entries: [{ amount: 37.25, currency: "USD", kind: "settlement", direction: "credit", ...(missingDate ? {} : { date: "2026-10-13" }), note }] }));
    try {
      const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encryption.localDeliveryAdditionalData(request) }, aes, plaintext);
      request.envelope.ciphertext = encryption.localDeliveryBase64Url(new Uint8Array(cipher));
    } finally { plaintext.fill(0); }
    const wire = new TextEncoder().encode(JSON.stringify({ appId: binding.appId, appRevision: binding.appRevision, actionId: binding.actionId, destination, idempotencyKey: importId, envelope: request.envelope }));
    if (new TextDecoder().decode(wire).includes(note)) throw new Error("Plaintext leaked into the delivery wire");
    const capability = encryption.localDeliveryDecode(reconnected.writeCapability, 32);
    try {
      const result = await actor.deposit_encrypted_inbox({ inbox_id: reconnected.inboxId, write_capability: Array.from(capability), request_id: importId, encrypted_payload: Array.from(wire) });
      if (!result.Ok || !("Pending" in result.Ok.status)) throw new Error("Synthetic encrypted deposit was rejected");
    } finally { capability.fill(0); }
    const listed = await inbox.loadDurableInbox({ actor, principal, identity, context: deliveryContext, templates: [], assertCurrent: () => {} });
    const pending = listed.items.find((item: { id: string }) => item.id === importId);
    if (listed.errors.length || pending?.error || pending?.drafts?.[0]?.initial?.note !== note) throw new Error("Actual pending inbox did not decrypt the synthetic draft");
    if (missingDate && (pending.drafts[0].initial.ts !== undefined || !pending.drafts[0].reviewDate)) throw new Error("Missing date did not remain editable and blank");
    return { requestId: importId, inboxId: reconnected.inboxId, bodyHash: Array.from(pending.receipt.body_sha256) as number[], pendingCount: listed.items.length, consumerStable: true };
  }, { sheetId, note: NOTE, host: HOST, canister: CANISTER, missingDate });
  expect(delivery.pendingCount).toBe(1); expect(delivery.consumerStable).toBe(true);
  expect(paid).toEqual(["acquire_account_root"]);

  // Reload drops plaintext session keys; the actual UI must recover via the
  // protected account root, decrypt the pending inbox and explicitly save it.
  await page.reload();
  await expect(page.getByRole("heading", { name: /Pending from chat \(1\)/ })).toBeVisible();
  const review = page.getByRole("button", { name: "Review & add", exact: true });
  await expect(review).toBeEnabled(); await review.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator('input[placeholder="lunch, taxi, etc."]')).toHaveValue(NOTE);
  if (missingDate) {
    await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("");
    await expect(dialog.getByText(/A date was not supplied/)).toBeVisible();
    const writesBefore = methods.filter(method => ["add_entry_batch", "acknowledge_encrypted_inbox"].includes(method)).length;
    await dialog.getByRole("button", { name: "Add entry", exact: true }).click();
    await expect(dialog).toBeVisible();
    expect(methods.filter(method => ["add_entry_batch", "acknowledge_encrypted_inbox"].includes(method))).toHaveLength(writesBefore);
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("heading", { name: /Pending from chat \(1\)/ })).toBeVisible();
    await expect(review).toBeEnabled(); await review.click();
    await expect(dialog.getByLabel("Date", { exact: true })).toHaveValue("");
    expect(methods.filter(method => ["add_entry_batch", "acknowledge_encrypted_inbox"].includes(method))).toHaveLength(writesBefore);
    await dialog.getByLabel("Date", { exact: true }).fill("2026-10-14");
  }
  await dialog.getByRole("button", { name: "Add entry", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText(NOTE, { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Pending from chat/ })).toHaveCount(0);

  const saved = await page.evaluate(async ({ sheetId, inboxId, requestId, bodyHash, note, expectedDate }) => {
    const module = (path: string) => {
      const loaded = performance.getEntriesByType("resource").map(entry => entry.name).reverse().find(name => new URL(name).pathname === path);
      return import(/* @vite-ignore */ loaded ?? path);
    };
    const [identityModule, auth, declarations, sheets, cryptoModule, types] = await Promise.all([
      module("/node_modules/.vite/deps/@dfinity_identity-secp256k1.js"), module("/src/features/auth/AuthProvider.tsx"), module("/src/backend/declarations.ts"),
      module("/src/features/crypto/vaultSheets.ts"), module("/src/features/crypto/devVetkd.ts"), module("/src/features/entries/types.ts"),
    ]);
    const identity = identityModule.Secp256k1KeyIdentity.fromJSON(localStorage.getItem("iou:dev:identity:v1"));
    const actor = declarations.createActor(await auth.buildAgent(identity));
    const rootKey = await sheets.readVaultSheetKey(actor, identity.getPrincipal().toText(), sheetId);
    try {
      const entries = await actor.list_entries(sheetId, [], 100);
      if (entries.entries.length !== 1) throw new Error("Expected exactly one persisted encrypted ledger entry");
      const entry = entries.entries[0];
      if (new TextDecoder().decode(new Uint8Array(entry.ciphertext)).includes(note)) throw new Error("Ledger stored plaintext");
      const plaintext = await cryptoModule.decryptEntryPayload(new Uint8Array(entry.entry_key), new Uint8Array(entry.iv), new Uint8Array(entry.ciphertext), rootKey);
      try {
        const payload = types.decodeEntry(plaintext);
        const inbox = await actor.list_encrypted_inbox({ inbox_id: inboxId, after_id: [] });
        if (!inbox.Ok) throw new Error("Could not inspect saved inbox receipt");
        if (inbox.Ok.items.some((item: any) => item.receipt.request_id === requestId)) throw new Error("Handled draft remained pending");
        // Handled payloads leave the pending index. An idempotent same-disposition
        // acknowledgement returns the retained receipt; replayed proves the UI
        // already acknowledged it, rather than this assertion doing the first save.
        const confirmed = await actor.acknowledge_encrypted_inbox({ inbox_id: inboxId, request_id: requestId, body_sha256: bodyHash, disposition: { Saved: null } });
        return { count: entries.entries.length, contentMatches: payload.note === note && payload.amount_minor === 3725 && payload.ts === Date.parse(expectedDate + "T00:00:00Z"),
          savedReceipt: !!confirmed.Ok && confirmed.Ok.replayed && "Saved" in confirmed.Ok.status };
      } finally { plaintext.fill(0); }
    } finally { rootKey.fill(0); }
  }, { sheetId, inboxId: delivery.inboxId, requestId: delivery.requestId, bodyHash: delivery.bodyHash, note: NOTE, expectedDate: missingDate ? "2026-10-14" : "2026-10-13" });
  expect(saved).toEqual({ count: 1, contentMatches: true, savedReceipt: true });
  expect(methods).toContain("set_consumer_keypair");
  expect(methods.filter(method => method === "create_encrypted_inbox_grant")).toHaveLength(2);
  expect(methods).toContain("deposit_encrypted_inbox"); expect(methods).toContain("add_entry_batch");
  expect(paid).toEqual(["acquire_account_root"]); expect(blocked).toEqual([]);
  expect(runtimeErrors, "Inbox recovery must have no uncaught browser runtime errors").toEqual([]);
});
}
