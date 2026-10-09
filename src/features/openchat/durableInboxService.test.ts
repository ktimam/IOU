import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import type { Identity } from "@dfinity/agent";
import { createDurableInboxGrant, dismissDurableInboxItem, loadDurableInbox, parseDurableInboxRequest, saveDurableInboxItem,
  DURABLE_INBOX_GRANT_MS, type DurableInboxActor, type DurableInboxGrant, type DurableInboxReceipt, type DurableInboxResult } from "./durableInboxService";
import { createLocalDeliveryEncryption, localDeliveryAdditionalData, localDeliveryBase64Url, localDeliveryDecode,
  LOCAL_DELIVERY_DOMAIN, LOCAL_DELIVERY_SCHEME, type LocalDeliveryEncryption, type LocalEncryptedRequest } from "./localImportEncryption";
import type { EntryBatchActor } from "../entries/batchImport";
import type { EntryPayload } from "../entries/types";

const session = vi.hoisted(() => ({ generation: 1, load: vi.fn() }));
vi.mock("./consumerKeypair", () => ({
  captureConsumerKeypairSession: (principal: string) => ({ principal, generation: session.generation }),
  loadExistingConsumerKeypair: (...args: unknown[]) => session.load(...args),
}));
const principal = Principal.selfAuthenticating(new Uint8Array([1, 2, 3])).toText();
const identity = { getPrincipal: () => Principal.fromText(principal) } as Identity;
const context = { principal, backendHost: "https://icp-api.io", backendCanisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai", pairId: "0000000000000001", sheetId: "0000000000000002" };
const destination = "https://iou.example/openchat/import", requestId = "A".repeat(43), inboxId = "a".repeat(64);
const original = { entries: [{ amount: 12900, currency: "EGP", kind: "settlement", direction: "credit", date: "2026-08-14", note: "Synthetic receipt" }] };
const buffer = (v: Uint8Array): ArrayBuffer => v.slice().buffer as ArrayBuffer;
const ok = <T>(value: T): DurableInboxResult<T> => ({ Ok: value });
let keys: CryptoKeyPair, recipient: LocalDeliveryEncryption, grant: DurableInboxGrant;
let encrypted: Uint8Array, receipt: DurableInboxReceipt;

async function seal(value: unknown = original, id = requestId) {
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const salt = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12));
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: keys.publicKey }, ephemeral.privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const aes = await crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: new TextEncoder().encode(LOCAL_DELIVERY_DOMAIN) }, hkdf,
    { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const request: LocalEncryptedRequest = { importId: id, appId: "iou", appRevision: "local-import-v2", actionId: "iou.entry.import", destination,
    envelope: { version: 1, scheme: LOCAL_DELIVERY_SCHEME, keyId: recipient.keyId, recipientContext: recipient.recipientContext,
      ephemeralPublicKey: localDeliveryBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))),
      salt: localDeliveryBase64Url(salt), iv: localDeliveryBase64Url(iv), ciphertext: "" } };
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv), additionalData: buffer(localDeliveryAdditionalData(request)) }, aes, new TextEncoder().encode(JSON.stringify(value)));
  return wire({ appId: request.appId, appRevision: request.appRevision, actionId: request.actionId, destination,
    idempotencyKey: id, envelope: { ...request.envelope, ciphertext: localDeliveryBase64Url(new Uint8Array(cipher)) } }, id);
}
async function wire(value: unknown, id = requestId) {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const now = Date.now();
  const proof: DurableInboxReceipt = { inbox_id: inboxId, request_id: id, body_sha256: new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(body))),
    received_at_ms: BigInt(now), expires_at_ms: BigInt(now + 86400000), status: { Pending: null }, replayed: false };
  return { body, proof };
}
function actor(): DurableInboxActor & EntryBatchActor {
  return {
    create_encrypted_inbox_grant: vi.fn(async input => ok({ ...grant, ...input })),
    list_encrypted_inbox_grants: vi.fn(async () => ok({ grants: [grant], next: [] as [] })),
    list_encrypted_inbox: vi.fn(async () => ok({ items: [{ receipt, encrypted_payload: encrypted }], next: [] as [] })),
    acknowledge_encrypted_inbox: vi.fn(async input => ok({ ...receipt, inbox_id: input.inbox_id, request_id: input.request_id,
      body_sha256: input.body_sha256, status: input.disposition })),
    get_consumer_keypair: vi.fn(async () => ({ mutation_epoch: 1n, keypair: [{ public_key_pem: "synthetic-public-key", wrapped_private_key: "opaque" }] as [{ public_key_pem: string; wrapped_private_key: string }] })),
    add_entry_batch: vi.fn(async (input: Parameters<EntryBatchActor["add_entry_batch"]>[0]) => ({ entry_ids: input.entries.map((_, i) => BigInt(i + 1)), replayed: false })),
  };
}
const load = (a: DurableInboxActor, assertCurrent = () => {}) => loadDurableInbox({ actor: a, identity, principal, context, templates: [], assertCurrent });
beforeAll(async () => {
  keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  recipient = await createLocalDeliveryEncryption(keys.publicKey, context);
});
beforeEach(async () => {
  session.generation = 1;
  session.load.mockReset().mockResolvedValue({ ...keys, publicKeySpkiPem: "synthetic-public-key", fingerprint: new Uint8Array(32) });
  grant = { inbox_id: inboxId, app_id: "iou", app_revision: "local-import-v2", action_id: "iou.entry.import", destination,
    recipient_key_id: recipient.keyId, recipient_context: recipient.recipientContext, created_at_ms: BigInt(Date.now() - 1000), expires_at_ms: BigInt(Date.now() + 86400000), revoked: false };
  const sealed = await seal(); encrypted = sealed.body; receipt = sealed.proof;
});

describe("explicit encrypted inbox connection", () => {
  const create = (a: DurableInboxActor, extra = {}) => createDurableInboxGrant({ actor: a, host: context.backendHost, canisterId: context.backendCanisterId,
    binding: { appId: "iou", appRevision: "local-import-v2", actionId: "iou.entry.import", destination, recipient }, assertCurrent: () => {}, ...extra });
  it("sends only a hash of a fresh capability and pins the recipient metadata", async () => {
    const a = actor(), first = await create(a), second = await create(a);
    expect(first.writeCapability).not.toBe(second.writeCapability);
    const submitted = vi.mocked(a.create_encrypted_inbox_grant).mock.calls[0][0];
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(localDeliveryDecode(first.writeCapability, 32))));
    expect(submitted.write_capability_hash).toEqual(Array.from(digest));
    expect(submitted).not.toHaveProperty("write_capability");
    expect(submitted.recipient_context).toBe(recipient.recipientContext);
    expect(first).toMatchObject({ version: 1, kind: "ic-canister", inboxId, host: context.backendHost });
  });
  it.each([{ host: "http://remote.example" }, { host: "https://icp-api.io/api" }, { canisterId: "aaaaa-aa" },
    { canisterId: "2vxsx-fae" }, { expiresAtMs: 1 }, { expiresAtMs: Date.now() + DURABLE_INBOX_GRANT_MS * 2 }])("rejects invalid route/expiry without mutation %j", async extra => {
    const a = actor(); await expect(create(a, extra)).rejects.toThrow(); expect(a.create_encrypted_inbox_grant).not.toHaveBeenCalled();
  });
  it("rejects changed returned binding", async () => {
    const a = actor(); vi.mocked(a.create_encrypted_inbox_grant).mockImplementation(async input => ok({ ...grant, ...input, recipient_key_id: "0".repeat(64) }));
    await expect(create(a)).rejects.toThrow(/binding changed/);
  });
  it.each([500, 120_000])("keeps the default grant within the backend ceiling when the client clock is %ims ahead", async aheadMs => {
    const a = actor(), serverNow = Date.now() - aheadMs;
    vi.mocked(a.create_encrypted_inbox_grant).mockImplementation(async input => {
      // Mirror the real canister's independent clock and strict maximum; the
      // previous Date.now() + 90-day default fails this boundary.
      if (input.expires_at_ms <= BigInt(serverNow) || input.expires_at_ms - BigInt(serverNow) > BigInt(DURABLE_INBOX_GRANT_MS)) {
        return { Err: { InvalidRequest: null } };
      }
      return ok({ ...grant, ...input, created_at_ms: BigInt(serverNow) });
    });
    const connected = await create(a);
    expect(a.create_encrypted_inbox_grant).toHaveBeenCalledOnce();
    expect(connected.expiresAtMs - serverNow).toBeGreaterThan(0);
    expect(connected.expiresAtMs - serverNow).toBeLessThanOrEqual(DURABLE_INBOX_GRANT_MS);
    expect(connected.expiresAtMs - serverNow).toBeGreaterThan(DURABLE_INBOX_GRANT_MS - 5 * 60_000);
  });
  it("preserves an explicit valid expiry instead of silently shortening it", async () => {
    const a = actor(), expiresAtMs = Date.now() + DURABLE_INBOX_GRANT_MS - 60_000;
    expect((await create(a, { expiresAtMs })).expiresAtMs).toBe(expiresAtMs);
    expect(vi.mocked(a.create_encrypted_inbox_grant).mock.calls[0][0].expires_at_ms).toBe(BigInt(expiresAtMs));
  });
  it("keeps the exact explicit maximum strict and rejects one millisecond above it", async () => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const a = actor(), expiresAtMs = now + DURABLE_INBOX_GRANT_MS;
      expect((await create(a, { expiresAtMs })).expiresAtMs).toBe(expiresAtMs);
      vi.mocked(a.create_encrypted_inbox_grant).mockClear();
      await expect(create(a, { expiresAtMs: expiresAtMs + 1 })).rejects.toThrow("Invalid inbox expiry");
      expect(a.create_encrypted_inbox_grant).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("does not bypass or retry the backend ceiling when clock skew exceeds the default headroom", async () => {
    const a = actor(), serverNow = Date.now() - 6 * 60_000;
    vi.mocked(a.create_encrypted_inbox_grant).mockImplementation(async input => {
      expect(input.expires_at_ms - BigInt(serverNow)).toBeGreaterThan(BigInt(DURABLE_INBOX_GRANT_MS));
      return { Err: { InvalidRequest: null } };
    });
    await expect(create(a)).rejects.toThrow("The encrypted inbox operation could not be completed");
    expect(a.create_encrypted_inbox_grant).toHaveBeenCalledOnce();
  });
  it("checks the session immediately before and after the update", async () => {
    const a = actor(); let current = true;
    vi.mocked(a.create_encrypted_inbox_grant).mockImplementation(async input => { current = false; return ok({ ...grant, ...input }); });
    await expect(create(a, { assertCurrent: () => { if (!current) throw new Error("changed"); } })).rejects.toThrow("changed");
  });
});

describe("persistent ciphertext listing and local review", () => {
  it("decrypts the same persisted request after a fresh load and never saves or acknowledges automatically", async () => {
    const a = actor(), first = await load(a), second = await load(a);
    expect(first.items[0].drafts?.[0].initial).toMatchObject({ amount_minor: 1290000, currency: "EGP", direction: "credit", note: "Synthetic receipt", ts: Date.parse("2026-08-14T00:00:00Z") });
    expect(second.items[0].drafts).toEqual(first.items[0].drafts);
    expect(a.add_entry_batch).not.toHaveBeenCalled(); expect(a.acknowledge_encrypted_inbox).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(encrypted)).not.toMatch(/12900|Synthetic receipt|2026-08-14/);
  });
  it("still lists readable pending drafts in revoked/expired grants", async () => {
    grant = { ...grant, revoked: true, created_at_ms: 1n, expires_at_ms: 2n };
    expect((await load(actor())).items[0].drafts).toHaveLength(1);
  });
  it("skips other sheets before key loading", async () => {
    const another = await createLocalDeliveryEncryption(keys.publicKey, { ...context, sheetId: "0000000000000003" });
    grant.recipient_context = another.recipientContext;
    const a = actor(); expect((await load(a)).items).toHaveLength(0);
    expect(session.load).not.toHaveBeenCalled(); expect(a.list_encrypted_inbox).not.toHaveBeenCalled();
  });
  it("supports an empty filtered page with a forward cursor", async () => {
    const a = actor(); vi.mocked(a.list_encrypted_inbox).mockResolvedValueOnce(ok({ items: [], next: ["0".repeat(43)] }));
    expect((await load(a)).items).toHaveLength(1); expect(a.list_encrypted_inbox).toHaveBeenCalledTimes(2);
  });
  it("rejects a repeated page cursor without looping", async () => {
    const a = actor(); vi.mocked(a.list_encrypted_inbox).mockResolvedValue(ok({ items: [], next: [requestId] }));
    await expect(load(a)).rejects.toThrow(/cursor/); expect(a.list_encrypted_inbox).toHaveBeenCalledTimes(2);
  });
  it("retains malformed ciphertext as an individually dismissible error", async () => {
    const invalid = await wire({ entries: original.entries }); encrypted = invalid.body; receipt = invalid.proof;
    const a = actor(), { items } = await load(a);
    expect(items).toHaveLength(1); expect(items[0].error).toBeTruthy(); expect(items[0].drafts).toBeUndefined();
    expect(a.acknowledge_encrypted_inbox).not.toHaveBeenCalled();
    await dismissDurableInboxItem({ actor: a, item: items[0], assertCurrent: () => {} });
    expect(a.add_entry_batch).not.toHaveBeenCalled();
    expect(a.acknowledge_encrypted_inbox).toHaveBeenCalledWith(expect.objectContaining({ disposition: { Dismissed: null } }));
  });
  it("retains missing keys without creating replacement keys", async () => {
    const a = actor(); vi.mocked(a.get_consumer_keypair).mockResolvedValue({ mutation_epoch: 1n, keypair: [] });
    expect((await load(a)).items[0].error).toBeTruthy(); expect(session.load).not.toHaveBeenCalled();
  });
  it("refuses a rotated key epoch even if the public string stayed equal", async () => {
    const a = actor(); vi.mocked(a.get_consumer_keypair).mockResolvedValueOnce({ mutation_epoch: 0n, keypair: [{ public_key_pem: "synthetic-public-key", wrapped_private_key: "opaque" }] });
    expect((await load(a)).items[0].error).toBeTruthy();
  });
  it("aborts instead of converting an auth-generation change into an item error", async () => {
    session.load.mockImplementation(async () => { session.generation++; return { ...keys, publicKeySpkiPem: "synthetic-public-key" }; });
    await expect(load(actor())).rejects.toThrow(/session changed/);
  });
  it("retains unknown Types and missing dates without guessing", async () => {
    const sealed = await seal({ entries: [{ ...original.entries[0], date: undefined }] }); encrypted = sealed.body; receipt = sealed.proof;
    expect((await load(actor())).items[0].error).toMatch(/date is missing/);
  });
  it("filters saved/dismissed tombstones without decrypting", async () => {
    receipt.status = { Saved: null }; expect((await load(actor())).items).toHaveLength(0); expect(session.load).not.toHaveBeenCalled();
  });
  it.each(["appId", "appRevision", "actionId", "destination", "idempotencyKey"])("rejects an altered host header %s even with a matching body digest", async field => {
    const row = JSON.parse(new TextDecoder().decode(encrypted)); row[field] = "changed";
    const changed = await wire(row); await expect(parseDurableInboxRequest(changed.body, changed.proof, grant)).rejects.toThrow(/binding/);
  });
  it("rejects a changed exact byte digest or extra plaintext field", async () => {
    await expect(parseDurableInboxRequest(encrypted, { ...receipt, body_sha256: new Uint8Array(32) }, grant)).rejects.toThrow(/receipt mismatch/);
    const changed = await wire({ ...JSON.parse(new TextDecoder().decode(encrypted)), note: "forbidden" });
    await expect(parseDurableInboxRequest(changed.body, changed.proof, grant)).rejects.toThrow(/request/);
  });
  it("deduplicates an identical original receipt across reconnect grants", async () => {
    const a = actor(), second = { ...grant, inbox_id: "b".repeat(64) };
    vi.mocked(a.list_encrypted_inbox_grants).mockResolvedValue(ok({ grants: [grant, second], next: [] }));
    vi.mocked(a.list_encrypted_inbox).mockImplementation(async input => ok({ items: [{ receipt: { ...receipt, inbox_id: input.inbox_id }, encrypted_payload: encrypted }], next: [] }));
    expect((await load(a)).items).toHaveLength(1);
  });
  it("blocks conflicting same-ID deliveries instead of choosing a plaintext", async () => {
    const a = actor(), second = { ...grant, inbox_id: "b".repeat(64) };
    const changed = await seal({ entries: [{ ...original.entries[0], amount: 11.11 }] });
    vi.mocked(a.list_encrypted_inbox_grants).mockResolvedValue(ok({ grants: [grant, second], next: [] }));
    vi.mocked(a.list_encrypted_inbox).mockImplementation(async input => ok({ items: [{ receipt: { ...(input.inbox_id === inboxId ? receipt : changed.proof), inbox_id: input.inbox_id },
      encrypted_payload: input.inbox_id === inboxId ? encrypted : changed.body }], next: [] }));
    const loaded = await load(a);
    expect(loaded.items).toHaveLength(1); expect(loaded.items[0].drafts).toBeUndefined(); expect(loaded.items[0].error).toMatch(/Conflicting/);
  });
  it("isolates a bad item while preserving another valid pending draft", async () => {
    const a = actor(), second = await seal(original, "B".repeat(42) + "A");
    const bad = await wire({ entries: [] });
    vi.mocked(a.list_encrypted_inbox).mockResolvedValue(ok({ items: [{ receipt: bad.proof, encrypted_payload: bad.body }, { receipt: second.proof, encrypted_payload: second.body }], next: [] }));
    const loaded = await load(a);
    expect(loaded.items[0].error).toBeTruthy(); expect(loaded.items[1].drafts).toHaveLength(1);
    expect(a.acknowledge_encrypted_inbox).not.toHaveBeenCalled();
  });
});

describe("explicit save then durable acknowledgement", () => {
  const save = (a: DurableInboxActor & EntryBatchActor, item: Awaited<ReturnType<typeof load>>["items"][number], extra = {}) => saveDurableInboxItem({ actor: a, item, context,
    payloads: item.drafts!.map(d => d.initial as EntryPayload), sheetKey: new Uint8Array(32), assertCurrent: () => {}, ...extra });
  it("writes ciphertext once through the exact-ID batch API, then acknowledges", async () => {
    const a = actor(), item = (await load(a)).items[0], outcome = await save(a, item);
    expect(outcome).toMatchObject({ acknowledged: true, acknowledgement: { accepted_count: 1, replayed: false } });
    expect(a.add_entry_batch).toHaveBeenCalledWith(expect.objectContaining({ sheet_id: context.sheetId, import_id: Array.from(localDeliveryDecode(requestId, 32)) }));
    expect(vi.mocked(a.add_entry_batch).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(a.acknowledge_encrypted_inbox).mock.invocationCallOrder[0]);
    expect(JSON.stringify(vi.mocked(a.add_entry_batch).mock.calls[0])).not.toMatch(/Synthetic receipt|amount_minor/);
  });
  it("leaves a failed/unknown save pending without acknowledgement", async () => {
    const a = actor(), item = (await load(a)).items[0]; vi.mocked(a.add_entry_batch).mockRejectedValue(new Error("response lost"));
    await expect(save(a, item)).rejects.toThrow("response lost"); expect(a.acknowledge_encrypted_inbox).not.toHaveBeenCalled();
    await expect(save(a, item, { payloads: [{ ...item.drafts![0].initial, note: "different retry" }] })).rejects.toThrow(/save was already attempted/);
    expect(a.add_entry_batch).toHaveBeenCalledTimes(1);
  });
  it("reports saved-but-unacknowledged and recovers after a fresh session with a ledger replay", async () => {
    const a = actor(); vi.mocked(a.acknowledge_encrypted_inbox).mockRejectedValueOnce(new Error("ack response lost"));
    expect((await save(a, (await load(a)).items[0])).acknowledged).toBe(false);
    vi.mocked(a.add_entry_batch).mockResolvedValue({ entry_ids: [1n], replayed: true });
    expect(await save(a, (await load(a)).items[0])).toMatchObject({ acknowledged: true, acknowledgement: { replayed: true, entry_ids: [1n] } });
    expect(vi.mocked(a.add_entry_batch).mock.calls.map(call => call[0].import_id)).toEqual([Array(32).fill(0), Array(32).fill(0)]);
  });
  it("rejects a changed target sheet before any ledger call", async () => {
    const a = actor(), item = (await load(a)).items[0]; await expect(save(a, item, { context: { ...context, sheetId: "0000000000000003" } })).rejects.toThrow(/destination changed/);
    expect(a.add_entry_batch).not.toHaveBeenCalled();
  });
  it("refuses a stale modal after another device handled the pending row", async () => {
    const a = actor(), item = (await load(a)).items[0];
    vi.mocked(a.list_encrypted_inbox).mockResolvedValue(ok({ items: [], next: [] }));
    await expect(save(a, item)).rejects.toThrow(/no longer pending/);
    expect(a.add_entry_batch).not.toHaveBeenCalled(); expect(a.acknowledge_encrypted_inbox).not.toHaveBeenCalled();
  });
  it("rechecks auth after encryption before the ledger mutation", async () => {
    const a = actor(), item = (await load(a)).items[0]; let n = 0;
    await expect(save(a, item, { assertCurrent: () => { if (++n > 1) throw new Error("signed out"); } })).rejects.toThrow("signed out");
    expect(a.add_entry_batch).not.toHaveBeenCalled(); expect(a.acknowledge_encrypted_inbox).not.toHaveBeenCalled();
  });
  it("rejects forged acknowledgement metadata without treating it as confirmed", async () => {
    const a = actor(), item = (await load(a)).items[0];
    vi.mocked(a.acknowledge_encrypted_inbox).mockResolvedValue(ok({ ...receipt, body_sha256: new Uint8Array(32), status: { Saved: null } }));
    expect((await save(a, item)).acknowledged).toBe(false);
  });
});
