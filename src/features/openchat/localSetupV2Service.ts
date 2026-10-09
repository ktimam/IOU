import { createIouLocalAppPackage } from "./localAppPackage";
import { createDurableInboxGrant, type ConnectedDurableInbox, type DurableInboxActor, type DurableInboxGrant, type DurableInboxRoute } from "./durableInboxService";
import { createLocalDeliveryEncryption, localDeliveryDecode, parseLocalDeliveryEncryption, type IouDeliveryContext, type LocalDeliveryEncryption } from "./localImportEncryption";
import { localImportRecipient } from "./localImportSheet";
import { isCanonicalAppScopedChatHandle, nat64ToSheetId, sheetIdToNat64 } from "./chatSheetLinks";
import { localSetupAccountId, parseLocalSetupContextV2, serializeLocalSetupResultV2, type LocalSetupContextV2, type LocalSetupRoute } from "./localAppSetupV2";
import type { LocalProcessorContext } from "./localProcessorContext";
import { Principal } from "@dfinity/principal";

export class LocalSetupV2Error extends Error {}
export type LocalSetupSheet = Readonly<{ pairId: string; sheetId: string; label: string; processorContext: LocalProcessorContext }>;
export type LocalSetupV2Actor = Pick<DurableInboxActor, "create_encrypted_inbox_grant" | "list_encrypted_inbox_grants"> & {
  chat_sheet_links(): Promise<readonly { chat_key: string; sheet_id: bigint }[]>;
  set_chat_sheet_link(handle: string, sheetId: bigint): Promise<unknown>;
};
type IdentityContext = Pick<IouDeliveryContext, "principal" | "backendHost" | "backendCanisterId">;
type Guard = () => void;
type Options = {
  context: LocalSetupContextV2; identity: IdentityContext; actor: LocalSetupV2Actor; destination: string;
  loadKey: () => Promise<{ publicKey: CryptoKey }>;
  loadProcessor: () => Promise<{ metadata: { sha256: string; byteLength: number } }>;
  loadSheet: (sheetId: string, assertCurrent: Guard) => Promise<LocalSetupSheet>;
  selectedSheetId?: string; assertCurrent: Guard;
};
const SHEET = /^[a-f0-9]{16}$/;
const PRIVATE_INBOX_KEYS = "canisterId,expiresAtMs,host,inboxId,kind,version,writeCapability";
function fail(message: string): never { throw new LocalSetupV2Error(message); }

export async function readLocalChatRoutes(actor: Pick<LocalSetupV2Actor, "chat_sheet_links">, assertCurrent: Guard): Promise<Map<string, string>> {
  assertCurrent(); const rows = await actor.chat_sheet_links(); assertCurrent();
  if (!Array.isArray(rows) || rows.length > 1000) fail("IOU could not verify the saved chat routes.");
  const links = new Map<string, string>();
  for (const row of rows) {
    if (!row || !isCanonicalAppScopedChatHandle(row.chat_key) || links.has(row.chat_key) || typeof row.sheet_id !== "bigint") {
      fail("IOU could not verify the saved chat routes.");
    }
    links.set(row.chat_key, nat64ToSheetId(row.sheet_id));
  }
  return links;
}

function previousCatalog(json: string, identity: IdentityContext): { recipient: LocalDeliveryEncryption; inbox?: ConnectedDurableInbox; sheetId: string; destination: string } {
  const catalog = JSON.parse(json);
  if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.apps) || catalog.apps.length !== 1 ||
    Object.keys(catalog).sort().join(",") !== "apps,version") fail("The saved IOU setup could not be verified. Use Open setup for the affected chat.");
  const app = catalog.apps[0], recipient = parseLocalDeliveryEncryption(app?.deliveryEncryption);
  if (app?.id !== "iou" || !recipient || typeof app.destination !== "string") fail("The saved IOU setup has no verified recipient. Use Open setup for the affected chat.");
  const addressed = localImportRecipient(recipient.recipientContext, identity);
  let inbox: ConnectedDurableInbox | undefined;
  if (app.deliveryInbox && "writeCapability" in app.deliveryInbox) {
    const value = app.deliveryInbox;
    if (Object.keys(value).sort().join(",") !== PRIVATE_INBOX_KEYS || value.version !== 1 || value.kind !== "ic-canister" ||
      value.host !== identity.backendHost || value.canisterId !== identity.backendCanisterId || !/^[a-f0-9]{64}$/.test(value.inboxId) ||
      !Number.isSafeInteger(value.expiresAtMs) || value.expiresAtMs < 1) fail("The saved IOU inbox could not be verified.");
    localDeliveryDecode(value.writeCapability, 32);
    inbox = Object.freeze({ ...value });
  }
  return { recipient, inbox, sheetId: addressed.sheetId, destination: app.destination };
}

async function ownedGrants(actor: LocalSetupV2Actor, check: Guard): Promise<Map<string, DurableInboxGrant>> {
  const grants = new Map<string, DurableInboxGrant>();
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    check(); const result = await actor.list_encrypted_inbox_grants(cursor ? [cursor] : []); check();
    if (!result || !("Ok" in result) || "Err" in result || !Array.isArray(result.Ok.grants) || result.Ok.grants.length > 16 ||
      !Array.isArray(result.Ok.next) || result.Ok.next.length > 1) fail("IOU could not verify its existing inbox connections.");
    for (const grant of result.Ok.grants) {
      if (!grant || !/^[a-f0-9]{64}$/.test(grant.inbox_id) || grants.has(grant.inbox_id) || grants.size >= 32) {
        fail("IOU could not verify its existing inbox connections.");
      }
      grants.set(grant.inbox_id, grant);
    }
    const next = result.Ok.next[0];
    if (next === undefined) return grants;
    if (typeof next !== "string" || !/^[a-f0-9]{64}$/.test(next) || (cursor && next <= cursor)) fail("Invalid IOU inbox page.");
    cursor = next;
  }
  fail("IOU could not verify all existing inbox connections.");
}

async function capabilityMatchesOwner(inbox: ConnectedDurableInbox, principal: string): Promise<boolean> {
  // Match durable_inbox.rs::grant_id. Owner metadata alone cannot prove that a
  // retained capability is intact: inboxId also commits to its SHA-256 hash.
  const owner = Principal.fromText(principal).toUint8Array();
  const capability = new Uint8Array(localDeliveryDecode(inbox.writeCapability, 32));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", capability));
  const domain = new TextEncoder().encode("app-encrypted-inbox/grant/v1\0");
  const bytes = new Uint8Array(domain.length + 1 + owner.length + hash.length);
  bytes.set(domain); bytes[domain.length] = owner.length;
  bytes.set(owner, domain.length + 1); bytes.set(hash, domain.length + 1 + owner.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("") === inbox.inboxId;
}

/** Explicit account refresh never changes a route; explicit chat setup changes only that route. */
export async function prepareLocalSetupV2(options: Options): Promise<string> {
  const { actor, identity, assertCurrent: check } = options;
  const context = parseLocalSetupContextV2(options.context);
  check();
  const accountId = await localSetupAccountId(identity); check();
  if (context.accountId && context.accountId !== accountId) {
    fail("Sign in to the IOU account already connected in OpenChat. No key or chat route was changed.");
  }
  const requested = context.scope === "account" ? context.routes : [{ handle: context.handle, catalogJson: context.catalogJson }];
  const links = requested.length ? await readLocalChatRoutes(actor, check) : new Map<string, string>();
  if (context.scope === "account" && requested.some(route => !links.has(route.handle))) {
    fail("A saved chat has no verified IOU sheet mapping. Use Open setup in that chat; reconnecting the app cannot choose a sheet for it.");
  }
  if (context.scope === "chat" && (!options.selectedSheetId || !SHEET.test(options.selectedSheetId))) {
    fail("Choose an active IOU sheet for this chat.");
  }
  const prior = requested.flatMap(route => route.catalogJson ? [previousCatalog(route.catalogJson, identity)] : []);
  const legacy = context.scope === "account" && context.legacyCatalogJson ? previousCatalog(context.legacyCatalogJson, identity) : undefined;
  if (legacy) prior.push(legacy);
  const { metadata } = await options.loadProcessor(); check();
  const key = await options.loadKey(); check();
  const publicInbox: DurableInboxRoute = { version: 1, kind: "ic-canister", host: identity.backendHost, canisterId: identity.backendCanisterId };
  const publicJson = JSON.stringify(createIouLocalAppPackage(options.destination, metadata, undefined, publicInbox));
  const grants = prior.some(row => row.inbox) ? await ownedGrants(actor, check) : new Map<string, DurableInboxGrant>();
  type Recipe = { input: { processorContext: LocalProcessorContext; recipientLabel: string; deliveryEncryption: LocalDeliveryEncryption };
    recipient: LocalDeliveryEncryption; inbox?: ConnectedDurableInbox };
  const recipes = new Map<string, Promise<Recipe>>();
  async function sheetRecipe(sheetId: string, requireLegacyKey = false): Promise<Recipe> {
    if (!recipes.has(sheetId)) recipes.set(sheetId, (async () => {
      check(); const sheet = await options.loadSheet(sheetId, check); check();
      if (sheet.sheetId !== sheetId || !SHEET.test(sheet.pairId)) fail("The selected IOU sheet changed. Open setup again.");
      const recipient = await createLocalDeliveryEncryption(key.publicKey, { ...identity, pairId: sheet.pairId, sheetId }); check();
      if (requireLegacyKey && legacy?.recipient.keyId !== recipient.keyId) fail("The existing legacy recipient key changed. Reconnect its chat explicitly; nothing was retargeted.");
      const input = { processorContext: sheet.processorContext, recipientLabel: sheet.label, deliveryEncryption: recipient };
      createIouLocalAppPackage(options.destination, metadata, input, publicInbox);
      let inbox: ConnectedDurableInbox | undefined;
        for (const candidate of prior) {
          const cached = candidate.inbox, grant = cached && grants.get(cached.inboxId);
          if (!cached || !grant || grant.revoked || cached.expiresAtMs <= Date.now() ||
            candidate.destination !== options.destination || candidate.recipient.keyId !== recipient.keyId ||
            candidate.recipient.recipientContext !== recipient.recipientContext ||
            grant.app_id !== "iou" || grant.app_revision !== "local-import-v2" || grant.action_id !== "iou.entry.import" ||
            grant.destination !== options.destination || grant.recipient_key_id !== recipient.keyId ||
            grant.recipient_context !== recipient.recipientContext || grant.expires_at_ms !== BigInt(cached.expiresAtMs) ||
            typeof grant.created_at_ms !== "bigint" || grant.created_at_ms < 0n || grant.created_at_ms >= grant.expires_at_ms) continue;
          const intact = await capabilityMatchesOwner(cached, identity.principal); check();
          if (!intact) continue; // Explicit setup can replace, never reuse, corrupted capability bytes.
          inbox = cached; break;
        }
      return { input, recipient, inbox };
    })());
    return recipes.get(sheetId)!;
  }
  // Read every Type/key/recipient and validate the whole bounded response BEFORE
  // minting any grant. A too-large refresh must not consume the owner's quota.
  const legacyRecipe = legacy ? await sheetRecipe(legacy.sheetId, true) : undefined;
  const requestedRecipes: { handle: string; recipe: Recipe }[] = [];
  for (const route of requested) {
    const sheetId = context.scope === "account" ? links.get(route.handle)! : options.selectedSheetId!;
    requestedRecipes.push({ handle: route.handle, recipe: await sheetRecipe(sheetId) }); check();
  }
  const placeholder: ConnectedDurableInbox = { ...publicInbox, inboxId: "f".repeat(64), writeCapability: "A".repeat(43), expiresAtMs: Number.MAX_SAFE_INTEGER };
  const render = (recipe: Recipe, inbox = recipe.inbox ?? placeholder) => JSON.stringify(
    createIouLocalAppPackage(options.destination, metadata, { ...recipe.input, deliveryInbox: inbox }, publicInbox));
  serializeLocalSetupResultV2(context, { version: 2, scope: context.scope, appId: "iou", accountId,
    catalogJson: legacyRecipe ? render(legacyRecipe) : publicJson,
    routes: requestedRecipes.map(row => ({ handle: row.handle, catalogJson: render(row.recipe) })) });
  const emitted = new Map<Recipe, Promise<string>>();
  async function emit(recipe: Recipe): Promise<string> {
    if (!emitted.has(recipe)) emitted.set(recipe, (async () => {
      const { recipient } = recipe;
      const inbox = recipe.inbox ?? await createDurableInboxGrant({ actor, host: identity.backendHost, canisterId: identity.backendCanisterId,
        binding: { appId: "iou", appRevision: "local-import-v2", actionId: "iou.entry.import", destination: options.destination, recipient }, assertCurrent: check });
      check(); return render(recipe, inbox);
    })());
    return emitted.get(recipe)!;
  }
  const catalogJson = legacyRecipe ? await emit(legacyRecipe) : publicJson;
  const output: LocalSetupRoute[] = [];
  for (const row of requestedRecipes) output.push({ handle: row.handle, catalogJson: await emit(row.recipe) });
  check();
  if (context.scope === "account" && requested.length) {
    const latest = await readLocalChatRoutes(actor, check);
    if (requested.some(route => latest.get(route.handle) !== links.get(route.handle))) fail("A chat's sheet mapping changed. Reconnect again; no mapping was overwritten.");
  }
  if (context.scope === "chat") {
    // Validate the complete response before any mapping write; grant failures cannot
    // silently change the chat's destination. Existing equivalent mappings are no-ops.
    serializeLocalSetupResultV2(context, { version: 2, scope: "chat", appId: "iou", accountId, catalogJson, routes: output });
    const latest = await readLocalChatRoutes(actor, check);
    if (latest.get(context.handle) !== links.get(context.handle)) fail("This chat's sheet changed elsewhere. Open setup again before changing it.");
    if (latest.get(context.handle) !== options.selectedSheetId) {
      check(); await actor.set_chat_sheet_link(context.handle, sheetIdToNat64(options.selectedSheetId!)); check();
      const stored = await readLocalChatRoutes(actor, check);
      if (stored.get(context.handle) !== options.selectedSheetId) fail("IOU could not confirm the saved chat mapping. Check Open setup before trying again.");
    }
  }
  check();
  return serializeLocalSetupResultV2(context, { version: 2, scope: context.scope, appId: "iou", accountId, catalogJson, routes: output });
}
