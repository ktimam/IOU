import { describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { createHash } from "node:crypto";
import { prepareLocalSetupV2, type LocalSetupV2Actor } from "./localSetupV2Service";
import { localSetupAccountId, parseLocalSetupContextV2 } from "./localAppSetupV2";
import { createIouLocalAppPackage } from "./localAppPackage";
import { createLocalProcessorContext } from "./localProcessorContext";
import { createLocalDeliveryEncryption } from "./localImportEncryption";
import type { DurableInboxGrant } from "./durableInboxService";

const firstHandle = "A".repeat(43), secondHandle = "B".repeat(42) + "A";
const firstSheet = "0000000000000001", secondSheet = "0000000000000002";
const identity = { principal: Principal.selfAuthenticating(new Uint8Array([1, 2, 3])).toText(),
  backendHost: "https://backend.example", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" };
const destination = "https://iou.example/openchat/import";
const metadata = { sha256: "f".repeat(64), byteLength: 10 };
async function fixture() {
  const key = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const accountId = await localSetupAccountId(identity);
  const sheets = [firstSheet, secondSheet].map((sheetId, i) => ({ sheetId, pairId: `000000000000000${i + 3}`, label: `Sheet ${i + 1}`,
    processorContext: createLocalProcessorContext([{ id: `type-${i}`, name: `Choice ${i}`, direction: i ? "debt" as const : "credit" as const,
      txn_type: "iou" as const, keywords: [] }], i ? "EGP" : "USD") }));
  const route = { version: 1 as const, kind: "ic-canister" as const, host: identity.backendHost, canisterId: identity.backendCanisterId };
  const grants: DurableInboxGrant[] = [], catalogs: string[] = [];
  for (const [i, sheet] of sheets.entries()) {
    const recipient = await createLocalDeliveryEncryption(key.publicKey, { ...identity, pairId: sheet.pairId, sheetId: sheet.sheetId });
    const capability = Buffer.alloc(32, i), owner = Principal.fromText(identity.principal).toUint8Array();
    const inboxId = createHash("sha256").update("app-encrypted-inbox/grant/v1\0").update(Buffer.from([owner.length])).update(owner)
      .update(createHash("sha256").update(capability).digest()).digest("hex");
    const grant = { inbox_id: inboxId, app_id: "iou", app_revision: "local-import-v2", action_id: "iou.entry.import", destination,
      recipient_key_id: recipient.keyId, recipient_context: recipient.recipientContext,
      created_at_ms: BigInt(Date.now() - 1000), expires_at_ms: BigInt(Date.now() + 86400000), revoked: false };
    grants.push(grant);
    catalogs.push(JSON.stringify(createIouLocalAppPackage(destination, metadata, { recipientLabel: sheet.label, processorContext: sheet.processorContext,
      deliveryEncryption: recipient, deliveryInbox: { ...route, inboxId: grant.inbox_id, writeCapability: capability.toString("base64url"), expiresAtMs: Number(grant.expires_at_ms) } }, route)));
  }
  const links = new Map([[firstHandle, firstSheet], [secondHandle, secondSheet]]);
  const actor: LocalSetupV2Actor = {
    chat_sheet_links: vi.fn(async () => [...links].map(([chat_key, sheetId]) => ({ chat_key, sheet_id: BigInt(`0x${sheetId}`) }))),
    set_chat_sheet_link: vi.fn(async (handle, sheetId) => { links.set(handle, sheetId.toString(16).padStart(16, "0")); }),
    list_encrypted_inbox_grants: vi.fn(async () => ({ Ok: { grants, next: [] as [] } })),
    create_encrypted_inbox_grant: vi.fn(async input => ({ Ok: { ...input, inbox_id: "c".repeat(64), created_at_ms: BigInt(Date.now()), revoked: false } })),
  };
  const options = { actor, identity, destination, loadKey: vi.fn(async () => key), loadProcessor: vi.fn(async () => ({ metadata })),
    loadSheet: vi.fn(async (sheetId: string) => sheets.find(sheet => sheet.sheetId === sheetId)!), assertCurrent: vi.fn() };
  const routes = [{ handle: firstHandle, catalogJson: catalogs[0] }, { handle: secondHandle, catalogJson: catalogs[1] }];
  return { options, actor, accountId, sheets, catalogs, grants, links, routes };
}

describe("IOU account and persistent per-chat setup separation", () => {
  it("connects an account without selecting, reading or assigning a sheet", async () => {
    const f = await fixture();
    const result = JSON.parse(await prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", routes: [] } }));
    expect(result).toMatchObject({ version: 2, scope: "account", accountId: f.accountId, routes: [] });
    const app = JSON.parse(result.catalogJson).apps[0];
    expect(app.setupScopes).toEqual(["account", "chat"]);
    expect(app.deliveryEncryption).toBeUndefined();
    expect(app.deliveryInbox.writeCapability).toBeUndefined();
    expect(f.options.loadKey).toHaveBeenCalledOnce();
    expect(f.options.loadSheet).not.toHaveBeenCalled();
    expect(f.actor.chat_sheet_links).not.toHaveBeenCalled();
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("reconnects two chats to their distinct saved sheets without writing mappings or renewing valid grants", async () => {
    const f = await fixture();
    const result = JSON.parse(await prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId, routes: f.routes } }));
    expect(result.routes.map((route: any) => route.handle)).toEqual([firstHandle, secondHandle]);
    for (const [i, row] of result.routes.entries()) {
      const app = JSON.parse(row.catalogJson).apps[0];
      expect(app.recipientLabel).toBe(f.sheets[i].label);
      expect(app.actions[0].processorContext).toMatchObject({ defaultCurrency: i ? "EGP" : "USD", types: [{ id: `type-${i}` }] });
      expect(app.deliveryInbox.inboxId).toBe(f.grants[i].inbox_id);
    }
    expect([...f.links.values()]).toEqual([firstSheet, secondSheet]);
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("keeps one valid grant for multiple routes targeting the same sheet", async () => {
    const f = await fixture(); f.links.set(secondHandle, firstSheet);
    const result = JSON.parse(await prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId, routes: f.routes } }));
    expect(result.routes.map((row: any) => JSON.parse(row.catalogJson).apps[0].deliveryInbox.inboxId)).toEqual([f.grants[0].inbox_id, f.grants[0].inbox_id]);
    expect(f.options.loadSheet).toHaveBeenCalledOnce();
    expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("reopens existing chat setup with its stored mapping and unchanged grant", async () => {
    const f = await fixture();
    const result = JSON.parse(await prepareLocalSetupV2({ ...f.options, selectedSheetId: firstSheet,
      context: { version: 2, scope: "chat", accountId: f.accountId, handle: firstHandle, catalogJson: f.catalogs[0] } }));
    expect(result.routes).toHaveLength(1);
    expect(JSON.parse(result.routes[0].catalogJson).apps[0].deliveryInbox.inboxId).toBe(f.grants[0].inbox_id);
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("replaces a corrupted capability instead of reporting a successful but unusable reconnect", async () => {
    const f = await fixture(), broken = JSON.parse(f.catalogs[0]);
    broken.apps[0].deliveryInbox.writeCapability = Buffer.alloc(32, 9).toString("base64url");
    const result = JSON.parse(await prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId,
      routes: [{ handle: firstHandle, catalogJson: JSON.stringify(broken) }] } }));
    expect(f.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce();
    expect(JSON.parse(result.routes[0].catalogJson).apps[0].deliveryInbox.inboxId).not.toBe(f.grants[0].inbox_id);
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("changes only the explicitly selected chat's mapping", async () => {
    const f = await fixture();
    await prepareLocalSetupV2({ ...f.options, selectedSheetId: secondSheet,
      context: { version: 2, scope: "chat", accountId: f.accountId, handle: firstHandle, catalogJson: f.catalogs[0] } });
    expect(f.actor.set_chat_sheet_link).toHaveBeenCalledExactlyOnceWith(firstHandle, 2n);
    expect(f.links.get(secondHandle)).toBe(secondSheet);
  });
  it.each(["account", "chat"] as const)("rejects a different IOU account before keys or mutations for %s setup", async scope => {
    const f = await fixture(), accountId = "D".repeat(42) + "A";
    const context = scope === "account" ? { version: 2 as const, scope, accountId, routes: f.routes } : { version: 2 as const, scope, accountId, handle: firstHandle };
    await expect(prepareLocalSetupV2({ ...f.options, context, selectedSheetId: firstSheet })).rejects.toThrow("Sign in to the IOU account already connected");
    expect(f.options.loadKey).not.toHaveBeenCalled(); expect(f.options.loadProcessor).not.toHaveBeenCalled();
    expect(f.actor.chat_sheet_links).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("does not invent an absent route from a historical private catalog", async () => {
    const f = await fixture(); f.links.delete(firstHandle);
    await expect(prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId, routes: f.routes } })).rejects.toThrow("Use Open setup");
    expect(f.options.loadKey).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("preserves an explicit legacy recipient without claiming per-chat mappings", async () => {
    const f = await fixture();
    const result = JSON.parse(await prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", routes: [], legacyCatalogJson: f.catalogs[0] } }));
    expect(result.routes).toEqual([]);
    expect(JSON.parse(result.catalogJson).apps[0].recipientLabel).toBe(f.sheets[0].label);
    expect(f.actor.chat_sheet_links).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
    expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("rejects a legacy recipient for another identity before loading a key", async () => {
    const f = await fixture(), other = { ...identity, principal: Principal.selfAuthenticating(new Uint8Array([7, 8, 9])).toText() };
    await expect(prepareLocalSetupV2({ ...f.options, identity: other, context: { version: 2, scope: "account", routes: [], legacyCatalogJson: f.catalogs[0] } })).rejects.toThrow();
    expect(f.options.loadKey).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("rejects a changed legacy key even when that same sheet is in the requested routes", async () => {
    const f = await fixture(), next = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    f.options.loadKey.mockResolvedValue(next);
    await expect(prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId, routes: f.routes, legacyCatalogJson: f.catalogs[0] } })).rejects.toThrow("legacy recipient key changed");
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("renews an expired grant once but never changes mappings on account reconnect", async () => {
    const f = await fixture(), old = JSON.parse(f.catalogs[0]); old.apps[0].deliveryInbox.expiresAtMs = Date.now() - 1;
    f.grants[0].expires_at_ms = BigInt(old.apps[0].deliveryInbox.expiresAtMs);
    await prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId,
      routes: [{ handle: firstHandle, catalogJson: JSON.stringify(old) }] } });
    expect(f.actor.create_encrypted_inbox_grant).toHaveBeenCalledOnce(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("does not save a mapping when grant creation fails", async () => {
    const f = await fixture(); vi.mocked(f.actor.create_encrypted_inbox_grant).mockResolvedValue({ Err: { Capacity: null } });
    await expect(prepareLocalSetupV2({ ...f.options, selectedSheetId: secondSheet,
      context: { version: 2, scope: "chat", accountId: f.accountId, handle: firstHandle } })).rejects.toThrow();
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled(); expect(f.links.get(firstHandle)).toBe(firstSheet);
  });
  it("validates every sheet before consuming a missing grant", async () => {
    const f = await fixture(), old = JSON.parse(f.catalogs[0]); delete old.apps[0].deliveryInbox;
    const load = f.options.loadSheet.getMockImplementation()!;
    f.options.loadSheet.mockImplementation(async id => { if (id === secondSheet) throw new Error("unreadable Types"); return load(id); });
    await expect(prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId,
      routes: [{ handle: firstHandle, catalogJson: JSON.stringify(old) }, f.routes[1]] } })).rejects.toThrow("unreadable Types");
    expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("rejects an aggregate route response over 1 MiB before minting or changing routes", async () => {
    const f = await fixture(), old = JSON.parse(f.catalogs[0]); delete old.apps[0].deliveryInbox;
    const routes = Array.from({ length: 32 }, (_, index) => ({ handle: Buffer.alloc(32, index).toString("base64url"), catalogJson: JSON.stringify(old) }));
    f.links.clear(); for (const route of routes) f.links.set(route.handle, firstSheet);
    f.sheets[0].processorContext = createLocalProcessorContext(Array.from({ length: 48 }, (_, index) => ({
      id: `type-${index}`, name: "n".repeat(128), keywords: ["a".repeat(128), "b".repeat(128), "c".repeat(128)], direction: "credit", txn_type: "iou",
    })), "USD");
    expect(() => parseLocalSetupContextV2({ version: 2, scope: "account", accountId: f.accountId, routes })).not.toThrow();
    await expect(prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId, routes } })).rejects.toThrow();
    expect(f.options.loadSheet).toHaveBeenCalledOnce();
    expect(f.actor.create_encrypted_inbox_grant).not.toHaveBeenCalled(); expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
  it("rejects a mapping change during account refresh without overwriting it", async () => {
    const f = await fixture(), key = await f.options.loadKey();
    f.options.loadKey.mockClear().mockImplementationOnce(async () => { f.links.set(firstHandle, secondSheet); return key; });
    await expect(prepareLocalSetupV2({ ...f.options, context: { version: 2, scope: "account", accountId: f.accountId, routes: f.routes } })).rejects.toThrow("mapping changed");
    expect(f.actor.set_chat_sheet_link).not.toHaveBeenCalled();
  });
});
