import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { addEntryBatch, type EntryBatchActor, type EntryBatchAcknowledgement } from "../entries/batchImport";
import type { EntryPayload } from "../entries/types";
import type { ParsedDraft } from "../entries/draft";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { captureConsumerKeypairSession, loadExistingConsumerKeypair, type ConsumerKeypair } from "./consumerKeypair";
import { createLocalDeliveryEncryption, IOU_LOCAL_APP_REVISION, localDeliveryBase64Url, localDeliveryDecode,
  parseLocalDeliveryEncryption, parseLocalEncryptedEnvelope, type IouDeliveryContext, type LocalDeliveryEncryption } from "./localImportEncryption";
import { decryptPendingLocalImport, isLocalImportId, type PendingLocalImport } from "./localImportHandoff";
import { createLocalImportSaveLock, localImportRecipient, localImportSheetDrafts, LocalImportReviewError } from "./localImportSheet";

export const DURABLE_INBOX_MAX_BODY_BYTES = 128 * 1024;
export const DURABLE_INBOX_GRANT_MS = 90 * 24 * 60 * 60 * 1000;
// The backend enforces 90 days using its own clock. Leave room for small
// client/server skew instead of requesting the exact maximum from Date.now().
const DURABLE_INBOX_GRANT_CLOCK_HEADROOM_MS = 5 * 60 * 1000;
type Opt<T> = [] | [T];
type Blob = number[] | Uint8Array;
export type DurableInboxResult<T> = { Ok: T } | { Err: object };
export type DurableInboxGrant = {
  inbox_id: string; app_id: string; app_revision: string; action_id: string; destination: string;
  recipient_key_id: string; recipient_context: string; created_at_ms: bigint; expires_at_ms: bigint; revoked: boolean;
};
export type DurableInboxReceipt = {
  inbox_id: string; request_id: string; body_sha256: Blob; received_at_ms: bigint; expires_at_ms: bigint;
  status: { Pending: null } | { Saved: null } | { Dismissed: null }; replayed: boolean;
};
export type DurableInboxActor = {
  create_encrypted_inbox_grant(input: Omit<DurableInboxGrant, "inbox_id" | "created_at_ms" | "revoked"> & {
    write_capability_hash: number[];
  }): Promise<DurableInboxResult<DurableInboxGrant>>;
  list_encrypted_inbox_grants(after: Opt<string>): Promise<DurableInboxResult<{ grants: DurableInboxGrant[]; next: Opt<string> }>>;
  list_encrypted_inbox(input: { inbox_id: string; after_id: Opt<string> }): Promise<DurableInboxResult<{
    items: { receipt: DurableInboxReceipt; encrypted_payload: Blob }[]; next: Opt<string>;
  }>>;
  acknowledge_encrypted_inbox(input: { inbox_id: string; request_id: string; body_sha256: number[];
    disposition: { Saved: null } | { Dismissed: null } }): Promise<DurableInboxResult<DurableInboxReceipt>>;
  get_consumer_keypair(): Promise<{ mutation_epoch: bigint; keypair: Opt<{ public_key_pem: string; wrapped_private_key: unknown }> }>;
};
export type DurableInboxRoute = Readonly<{ version: 1; kind: "ic-canister"; host: string; canisterId: string }>;
export type ConnectedDurableInbox = DurableInboxRoute & Readonly<{ inboxId: string; writeCapability: string; expiresAtMs: number }>;
export type DurableInboxItem = Readonly<{
  id: string; receipt: DurableInboxReceipt; grant: DurableInboxGrant;
  request?: PendingLocalImport; drafts?: readonly ParsedDraft[]; error?: string;
}>;
type Guard = () => void;
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer as ArrayBuffer;
const validId = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const MAX_PAGES = 64;
const saveLocks = new WeakMap<DurableInboxItem, ReturnType<typeof createLocalImportSaveLock>>();

function bytes(value: Blob, min: number, max = min): Uint8Array {
  if ((!Array.isArray(value) && !(value instanceof Uint8Array)) || value.length < min || value.length > max ||
    Array.from(value).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error("Invalid encrypted inbox bytes");
  return Uint8Array.from(value);
}
function sameBytes(a: Blob, b: Blob): boolean { return a.length === b.length && Array.from(a).every((v, i) => v === b[i]); }
function millis(value: bigint): number {
  if (typeof value !== "bigint" || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid inbox timestamp");
  return Number(value);
}
function result<T>(value: DurableInboxResult<T>): T {
  if (!value || typeof value !== "object" || !("Ok" in value) || "Err" in value) {
    // Canister errors contain no message contents, but do not surface arbitrary remote text.
    throw new Error("The encrypted inbox operation could not be completed. Nothing was discarded.");
  }
  return value.Ok;
}
function origin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw new Error("Invalid inbox host");
  return value;
}
function canonicalPrincipal(value: string): void {
  const p = Principal.fromText(value);
  if (p.toText() !== value || p.isAnonymous() || value === "aaaaa-aa") throw new Error("Invalid inbox principal");
}
function destinationUrl(value: string): void {
  const url = new URL(value);
  origin(url.origin);
  if (url.href !== value || url.username || url.password || url.search || url.hash || url.pathname !== "/openchat/import") {
    throw new Error("Invalid IOU inbox destination");
  }
}
function validateGrant(grant: DurableInboxGrant): void {
  if (!grant || !validId(grant.inbox_id) || grant.app_id !== "iou" || grant.app_revision !== IOU_LOCAL_APP_REVISION ||
    grant.action_id !== "iou.entry.import" || !validId(grant.recipient_key_id) || typeof grant.revoked !== "boolean" ||
    millis(grant.expires_at_ms) <= millis(grant.created_at_ms)) throw new Error("Invalid encrypted inbox grant");
  localDeliveryDecode(grant.recipient_context, 1, 1536);
  destinationUrl(grant.destination);
}
function validateReceipt(receipt: DurableInboxReceipt): void {
  if (!receipt || !validId(receipt.inbox_id) || !isLocalImportId(receipt.request_id) || typeof receipt.replayed !== "boolean" ||
    millis(receipt.expires_at_ms) <= millis(receipt.received_at_ms) || !receipt.status ||
    Object.keys(receipt.status).length !== 1 || !["Pending", "Saved", "Dismissed"].some(k => k in receipt.status)) {
    throw new Error("Invalid encrypted inbox receipt");
  }
  bytes(receipt.body_sha256, 32);
}
function nextPage(next: Opt<string>, previous: string | undefined, seen: Set<string>): string | undefined {
  if (!Array.isArray(next) || next.length > 1) throw new Error("Invalid inbox page cursor");
  if (next.length === 0) return undefined;
  const id = next[0];
  if (typeof id !== "string" || !id || id.length > 128 || (previous !== undefined && id <= previous) || seen.has(id)) throw new Error("Invalid inbox page cursor");
  seen.add(id); return id;
}

/** Explicit Connect only: the raw capability is returned to the approved client, never published. */
export async function createDurableInboxGrant(options: {
  actor: Pick<DurableInboxActor, "create_encrypted_inbox_grant">;
  binding: { appId: string; appRevision: string; actionId: string; destination: string; recipient: LocalDeliveryEncryption };
  host: string; canisterId: string; assertCurrent: Guard; expiresAtMs?: number;
}): Promise<ConnectedDurableInbox> {
  const { binding, assertCurrent } = options;
  assertCurrent(); origin(options.host); canonicalPrincipal(options.canisterId); destinationUrl(binding.destination);
  if (binding.appId !== "iou" || binding.appRevision !== IOU_LOCAL_APP_REVISION || binding.actionId !== "iou.entry.import" ||
    !parseLocalDeliveryEncryption(binding.recipient)) throw new Error("Invalid IOU inbox binding");
  const now = Date.now(), expiresAtMs = options.expiresAtMs ?? now + DURABLE_INBOX_GRANT_MS - DURABLE_INBOX_GRANT_CLOCK_HEADROOM_MS;
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now || expiresAtMs > now + DURABLE_INBOX_GRANT_MS) throw new Error("Invalid inbox expiry");
  const capability = crypto.getRandomValues(new Uint8Array(32));
  try {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(capability)));
    assertCurrent();
    const grant = result(await options.actor.create_encrypted_inbox_grant({
      app_id: binding.appId, app_revision: binding.appRevision, action_id: binding.actionId, destination: binding.destination,
      recipient_key_id: binding.recipient.keyId, recipient_context: binding.recipient.recipientContext,
      write_capability_hash: Array.from(hash), expires_at_ms: BigInt(expiresAtMs),
    }));
    assertCurrent(); validateGrant(grant);
    if (grant.app_id !== binding.appId || grant.app_revision !== binding.appRevision || grant.action_id !== binding.actionId ||
      grant.destination !== binding.destination || grant.recipient_key_id !== binding.recipient.keyId ||
      grant.recipient_context !== binding.recipient.recipientContext || grant.expires_at_ms !== BigInt(expiresAtMs) || grant.revoked) {
      throw new Error("The encrypted inbox binding changed. Reconnect IOU.");
    }
    return Object.freeze({ version: 1, kind: "ic-canister", host: options.host, canisterId: options.canisterId,
      inboxId: grant.inbox_id, writeCapability: localDeliveryBase64Url(capability), expiresAtMs });
  } finally { capability.fill(0); }
}

/** Exact encrypted host JSON; never interpret or accept plaintext proposal fields here. */
export async function parseDurableInboxRequest(body: Blob, receipt: DurableInboxReceipt, grant: DurableInboxGrant): Promise<PendingLocalImport> {
  validateGrant(grant); validateReceipt(receipt);
  const raw = bytes(body, 1, DURABLE_INBOX_MAX_BODY_BYTES);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(raw)));
  if (receipt.inbox_id !== grant.inbox_id || !sameBytes(receipt.body_sha256, digest)) throw new Error("Encrypted inbox receipt mismatch");
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const keys = ["appId", "appRevision", "actionId", "destination", "idempotencyKey", "envelope"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid encrypted inbox request");
  const row = value as Record<string, unknown>, envelope = parseLocalEncryptedEnvelope(row.envelope);
  if (!envelope || row.appId !== grant.app_id || row.appRevision !== grant.app_revision || row.actionId !== grant.action_id ||
    row.destination !== grant.destination || row.idempotencyKey !== receipt.request_id || envelope.keyId !== grant.recipient_key_id ||
    envelope.recipientContext !== grant.recipient_context) throw new Error("Encrypted inbox binding mismatch");
  return Object.freeze({ importId: receipt.request_id, appId: grant.app_id, appRevision: grant.app_revision,
    actionId: grant.action_id, destination: grant.destination, envelope, envelopes: Object.freeze([envelope]),
    // The deposit capability authenticates permission, not an OpenChat publisher or sender origin.
    senderOrigin: new URL(grant.destination).origin, status: "pending-review" });
}

/** Uses the existing ConsumerKeypairSync generation; receive never provisions a replacement key. */
async function existingKeys(actor: Pick<DurableInboxActor, "get_consumer_keypair">, principal: string, assertCurrent: Guard): Promise<ConsumerKeypair> {
  const ticket = captureConsumerKeypairSession(principal);
  const check = () => { assertCurrent(); if (captureConsumerKeypairSession(principal).generation !== ticket.generation) throw new Error("IOU key session changed"); };
  check(); const before = await actor.get_consumer_keypair(); check();
  if (before.keypair.length !== 1) throw new Error("Reconnect IOU: its delivery key is unavailable");
  const key = await loadExistingConsumerKeypair(ticket); check();
  const after = await actor.get_consumer_keypair(); check();
  if (after.mutation_epoch !== before.mutation_epoch || after.keypair.length !== 1 ||
    before.keypair[0]?.public_key_pem !== key.publicKeySpkiPem || after.keypair[0]?.public_key_pem !== key.publicKeySpkiPem) {
    throw new Error("Reconnect IOU: its delivery key changed");
  }
  return key;
}

/** Lists persisted ciphertext, then decrypts only the current authenticated sheet locally. */
export async function loadDurableInbox(options: {
  actor: DurableInboxActor; principal: string; identity: Identity; context: IouDeliveryContext;
  templates: readonly TxnTemplate[]; assertCurrent: Guard;
}): Promise<{ items: DurableInboxItem[]; errors: string[] }> {
  const { actor, principal, identity, context, templates, assertCurrent } = options;
  canonicalPrincipal(principal); canonicalPrincipal(context.backendCanisterId);
  const ticket = captureConsumerKeypairSession(principal);
  const check = () => {
    assertCurrent();
    if (identity.getPrincipal().toText() !== principal || context.principal !== principal ||
      captureConsumerKeypairSession(principal).generation !== ticket.generation) throw new Error("IOU inbox session changed");
  };
  check();
  const grants: DurableInboxGrant[] = [], errors: string[] = [], seenGrants = new Set<string>();
  let cursor: string | undefined;
  const grantPages = new Set<string>();
  for (let pageNo = 0; ; pageNo++) {
    if (pageNo >= 3) throw new Error("Encrypted inbox listing exceeded its page bound");
    const page = result(await actor.list_encrypted_inbox_grants(cursor ? [cursor] : [])); check();
    if (!Array.isArray(page.grants) || page.grants.length > 16 || seenGrants.size + page.grants.length > 32) throw new Error("Invalid encrypted inbox grant page");
    for (const grant of page.grants) {
      try {
        validateGrant(grant);
        if (seenGrants.has(grant.inbox_id)) throw new Error("Duplicate encrypted inbox grant");
        seenGrants.add(grant.inbox_id);
        const addressed = localImportRecipient(grant.recipient_context, context);
        if (addressed.pairId === context.pairId && addressed.sheetId === context.sheetId) grants.push(grant);
      } catch { errors.push("An encrypted inbox connection could not be verified. It was not removed."); }
    }
    const next = nextPage(page.next, cursor, grantPages);
    if (!next) break;
    cursor = next;
  }
  const items: DurableInboxItem[] = [], ids = new Map<string, number>();
  let keyPromise: Promise<ConsumerKeypair> | undefined;
  let receivedBytes = 0;
  for (const grant of grants) {
    const pages = new Set<string>(); cursor = undefined;
    for (let pageNo = 0; ; pageNo++) {
      if (pageNo >= MAX_PAGES) throw new Error("Encrypted inbox listing exceeded its page bound");
      const page = result(await actor.list_encrypted_inbox({ inbox_id: grant.inbox_id, after_id: cursor ? [cursor] : [] })); check();
      if (!Array.isArray(page.items) || page.items.length > 16) throw new Error("Invalid encrypted inbox page");
      for (const wire of page.items) {
        receivedBytes += wire.encrypted_payload?.length ?? 0;
        if (receivedBytes > 4 * 1024 * 1024 || items.length >= 256) throw new Error("Encrypted inbox exceeds its storage bound");
        let receipt: DurableInboxReceipt;
        try {
          receipt = wire.receipt; validateReceipt(receipt);
          if (receipt.inbox_id !== grant.inbox_id) throw new Error("Wrong inbox receipt");
        } catch { errors.push("An encrypted inbox receipt could not be verified. It was not removed."); continue; }
        if (!("Pending" in receipt.status)) continue;
        const duplicate = ids.get(receipt.request_id);
        if (duplicate !== undefined) {
          if (!sameBytes(items[duplicate].receipt.body_sha256, receipt.body_sha256)) {
            items[duplicate] = Object.freeze({ ...items[duplicate], drafts: undefined, error: "Conflicting deliveries use the same request identity. Nothing was saved." });
          }
          continue;
        }
        let request: PendingLocalImport | undefined;
        let drafts: readonly ParsedDraft[] | undefined;
        let error: string | undefined;
        try {
          request = await parseDurableInboxRequest(wire.encrypted_payload, receipt, grant); check();
          if (millis(receipt.expires_at_ms) <= Date.now()) throw new Error("Expired delivery");
          keyPromise ??= existingKeys(actor, principal, check);
          const key = await keyPromise; check();
          const recipient = await createLocalDeliveryEncryption(key.publicKey, context); check();
          const payload = await decryptPendingLocalImport(request, key.privateKey, recipient, grant.destination, check); check();
          drafts = Object.freeze(localImportSheetDrafts(payload.entries, templates, request.importId));
        } catch (cause) {
          check();
          error = cause instanceof LocalImportReviewError ? cause.message : "This pending draft could not be opened with this account's current key and sheet setup. Reconnect or dismiss it; nothing was saved.";
        }
        ids.set(receipt.request_id, items.length);
        items.push(Object.freeze({ id: receipt.request_id, receipt, grant, request, drafts, error }));
      }
      const next = nextPage(page.next, cursor, pages);
      if (!next) break;
      cursor = next;
    }
  }
  check(); return { items, errors };
}

async function acknowledge(actor: Pick<DurableInboxActor, "acknowledge_encrypted_inbox">, item: DurableInboxItem, disposition: "Saved" | "Dismissed", assertCurrent: Guard): Promise<void> {
  validateReceipt(item.receipt); assertCurrent();
  const receipt = result(await actor.acknowledge_encrypted_inbox({ inbox_id: item.receipt.inbox_id, request_id: item.id,
    body_sha256: Array.from(bytes(item.receipt.body_sha256, 32)), disposition: disposition === "Saved" ? { Saved: null } : { Dismissed: null } }));
  assertCurrent(); validateReceipt(receipt);
  if (receipt.inbox_id !== item.receipt.inbox_id || receipt.request_id !== item.id ||
    !sameBytes(receipt.body_sha256, item.receipt.body_sha256) || !(disposition in receipt.status)) throw new Error("Encrypted inbox acknowledgement mismatch");
}

/** Explicit user dismissal only; no ledger writes, even when decryption failed. */
export async function dismissDurableInboxItem(options: {
  actor: Pick<DurableInboxActor, "acknowledge_encrypted_inbox">; item: DurableInboxItem; assertCurrent: Guard;
}): Promise<void> { await acknowledge(options.actor, options.item, "Dismissed", options.assertCurrent); }

async function requireStillPending(actor: Pick<DurableInboxActor, "list_encrypted_inbox">, item: DurableInboxItem, check: Guard): Promise<void> {
  let cursor: string | undefined;
  const pages = new Set<string>();
  for (let pageNo = 0; pageNo < MAX_PAGES; pageNo++) {
    check();
    const page = result(await actor.list_encrypted_inbox({ inbox_id: item.receipt.inbox_id, after_id: cursor ? [cursor] : [] }));
    check();
    if (!Array.isArray(page.items) || page.items.length > 16) throw new Error("Invalid encrypted inbox page");
    for (const row of page.items) {
      validateReceipt(row.receipt);
      if (row.receipt.inbox_id !== item.receipt.inbox_id) throw new Error("Wrong inbox receipt");
      if (row.receipt.request_id !== item.id) continue;
      if (!("Pending" in row.receipt.status) || !sameBytes(row.receipt.body_sha256, item.receipt.body_sha256) ||
        millis(row.receipt.expires_at_ms) <= Date.now()) throw new Error("This inbox draft is no longer pending. Refresh the sheet.");
      return;
    }
    const next = nextPage(page.next, cursor, pages);
    if (!next) break;
    cursor = next;
  }
  throw new Error("This inbox draft is no longer pending. Refresh the sheet before saving.");
}

/** Explicit final review only. The ledger receipt, not an inbox acknowledgement, proves saving. */
export async function saveDurableInboxItem(options: {
  actor: EntryBatchActor & Pick<DurableInboxActor, "acknowledge_encrypted_inbox" | "list_encrypted_inbox">;
  item: DurableInboxItem; context: IouDeliveryContext; payloads: readonly EntryPayload[]; sheetKey: Uint8Array;
  assertCurrent: Guard;
}): Promise<{ acknowledgement: EntryBatchAcknowledgement; acknowledged: boolean }> {
  const { actor, item, context, assertCurrent } = options;
  assertCurrent();
  validateReceipt(item.receipt);
  if (!item.request || item.error || !item.drafts?.length || item.id !== item.request.importId || item.receipt.request_id !== item.id) {
    throw new Error("This encrypted draft is not ready for review");
  }
  if (!("Pending" in item.receipt.status)) throw new Error("This inbox draft has already been handled. Refresh the sheet before continuing.");
  const addressed = localImportRecipient(item.grant.recipient_context, context);
  if (addressed.sheetId !== context.sheetId || addressed.pairId !== context.pairId) throw new Error("The IOU destination changed");
  // A replicated read rejects an already dismissed/expired row. Another device can still
  // act after this check; exact-ID ledger receipts provide the financial duplicate guard.
  await requireStillPending(actor, item, assertCurrent);
  let lock = saveLocks.get(item);
  if (!lock) { lock = createLocalImportSaveLock(item.id, item.drafts.length); saveLocks.set(item, lock); }
  const payloads = lock(options.payloads);
  const acknowledgement = await addEntryBatch({ actor, sheetId: context.sheetId, payloads, messageHandle: item.id,
    relayId: item.id, sheetKey: options.sheetKey, beforeMutate: assertCurrent });
  assertCurrent();
  try {
    await acknowledge(actor, item, "Saved", assertCurrent);
    return { acknowledgement, acknowledged: true };
  } catch {
    assertCurrent();
    // A later explicit retry reuses the exact ledger identity and cannot append another batch.
    return { acknowledgement, acknowledged: false };
  }
}
