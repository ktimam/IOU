/**
 * A first-party, consent-bound import inbox for the unofficial client.
 *
 * The sender must obtain permission before opening IOU and offering the reviewed payload.
 * A received offer is UNTRUSTED and only queues an immutable local draft for IOU's own review.
 * This module never loads a URL, stores a draft, invokes an actor, or submits an entry. It does
 * not assert OpenChat provenance, chat membership, or user consent from a wire flag.
 *
 * The host protocol is generic: actionId and payload are opaque to OpenChat. Only this IOU
 * adapter knows the ledger fields. A future UI supplies a pre-approved exact origin, its
 * opened window reference, and a fresh receiver-owned nonce; never learn these from an offer
 * or place payloads/credentials in URLs. Native bridges require separate qualification.
 */
import { parseDraft, type EntryDraft } from "../entries/draft";
import type { EntryBatchAcknowledgement } from "../entries/batchImport";

export const LOCAL_IMPORT_ACTION = "iou.entry.import";
export const LOCAL_IMPORT_VERSION = 1;
export const LOCAL_IMPORT_LIMITS = Object.freeze({ entries: 32, noteBytes: 4096, payloadBytes: 65536, queued: 8 });

export type LocalImportDraft = Readonly<
  Required<Pick<EntryDraft, "kind" | "currency" | "direction">> & {
    amount: number;
    date?: string;
    note?: string;
    typeId?: string;
    typeName?: string;
  }
>;
export type LocalImportPayload = Readonly<{ entries: readonly LocalImportDraft[] }>;
export type PendingLocalImport = Readonly<{
  importId: string;
  actionId: typeof LOCAL_IMPORT_ACTION;
  senderOrigin: string;
  payload: LocalImportPayload;
  status: "pending-review";
}>;

type Envelope = { version: 1; sessionNonce: string };
type Rejection = "invalid-offer" | "id-conflict" | "queue-full";
export type LocalImportReply =
  | (Envelope & { type: "oc:app-import:ready" })
  | (Envelope & { type: "oc:app-import:received"; importId: string; status: "pending-review" })
  | (Envelope & { type: "oc:app-import:rejected"; reason: Rejection });
/** Separate from `received`: UI may send this ONLY after addEntryBatch returns successfully. */
export type LocalImportCommittedReceipt = Envelope & {
  type: "oc:app-import:committed";
  importId: string;
  status: "saved";
  acceptedCount: number;
  replayed: boolean;
};

/** No network or mutation. Caller must also recheck its captured IOU identity/sheet context. */
export function buildLocalImportCommittedReceipt(
  sessionNonce: string,
  importId: string,
  acknowledgement: EntryBatchAcknowledgement,
): LocalImportCommittedReceipt {
  if (!isLocalImportId(sessionNonce) || !isLocalImportId(importId) ||
    !acknowledgement || typeof acknowledgement.replayed !== "boolean" ||
    !Number.isInteger(acknowledgement.accepted_count) || acknowledgement.accepted_count < 1 ||
    acknowledgement.accepted_count > LOCAL_IMPORT_LIMITS.entries ||
    !Array.isArray(acknowledgement.entry_ids) ||
    acknowledgement.entry_ids.length !== acknowledgement.accepted_count ||
    acknowledgement.entry_ids.some((id) => typeof id !== "bigint" || id <= 0n || id > 0xffffffffffffffffn) ||
    new Set(acknowledgement.entry_ids).size !== acknowledgement.accepted_count) {
    throw new Error("Invalid committed import acknowledgement");
  }
  return Object.freeze({ type: "oc:app-import:committed", version: LOCAL_IMPORT_VERSION,
    sessionNonce, importId, status: "saved", acceptedCount: acknowledgement.accepted_count,
    replayed: acknowledgement.replayed });
}
export type LocalImportEvent = Pick<MessageEvent<unknown>, "origin" | "source" | "data">;
export type LocalImportResult =
  | { kind: "ignored" }
  | { kind: "ready"; reply: LocalImportReply }
  | { kind: "queued" | "duplicate"; draft: PendingLocalImport; reply: LocalImportReply }
  | { kind: "rejected"; reply: LocalImportReply };

// The last base64url digit has four zero padding bits for an exact 32-byte value.
export function isLocalImportId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

export function createLocalImportNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function validOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}

/** Only structured-clone-compatible plain data properties; never invoke an input getter. */
function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 10 || keys.some((key) => typeof key !== "string")) return undefined;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) return undefined;
    out[key] = descriptor.value;
  }
  return out;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function dataRows(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 || value.length > LOCAL_IMPORT_LIMITS.entries ||
    Reflect.ownKeys(value).length !== value.length + 1) return undefined;
  const rows: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined;
    rows.push(descriptor.value);
  }
  return rows;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validNote(value: unknown): value is string {
  return typeof value === "string" && value.length <= LOCAL_IMPORT_LIMITS.noteBytes &&
    new TextEncoder().encode(value).byteLength <= LOCAL_IMPORT_LIMITS.noteBytes &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) &&
    !/[\ud800-\udfff]/u.test(value);
}

/** A deliberately narrower DTO than legacy paste/card input: no inference, aliases or hidden data. */
export function parseLocalImportPayload(value: unknown): LocalImportPayload | undefined {
  try {
    const envelope = dataRecord(value);
    if (!envelope || !exactKeys(envelope, ["entries"])) return undefined;
    const rows = dataRows(envelope.entries);
    if (!rows) return undefined;
    const entries: LocalImportDraft[] = [];
    for (const item of rows) {
      const row = dataRecord(item);
      if (!row || !exactKeys(row, ["kind", "amount", "currency", "direction"], ["date", "note", "typeId", "typeName"]) ||
        (row.kind !== "iou" && row.kind !== "settlement") ||
        (row.direction !== "credit" && row.direction !== "debt") ||
        typeof row.amount !== "number" || !Number.isFinite(row.amount) || row.amount <= 0 ||
        !Number.isSafeInteger(Math.round(row.amount * 100)) ||
        Math.round(row.amount * 100) / 100 !== row.amount ||
        typeof row.currency !== "string" || !/^[A-Z]{3}$/.test(row.currency) ||
        (Object.hasOwn(row, "date") && !validDate(row.date)) ||
        (Object.hasOwn(row, "note") && !validNote(row.note)) ||
        Object.hasOwn(row, "typeId") !== Object.hasOwn(row, "typeName") ||
        (Object.hasOwn(row, "typeId") && (typeof row.typeId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(row.typeId) ||
          typeof row.typeName !== "string" || row.typeName.length < 1 || row.typeName.length > 128 || !validNote(row.typeName)))) return undefined;
      const draft: LocalImportDraft = Object.freeze({
        kind: row.kind, amount: row.amount, currency: row.currency, direction: row.direction,
        ...(Object.hasOwn(row, "date") ? { date: row.date as string } : {}),
        ...(Object.hasOwn(row, "note") ? { note: row.note as string } : {}),
        ...(Object.hasOwn(row, "typeId") ? { typeId: row.typeId as string, typeName: row.typeName as string } : {}),
      });
      // Reuse IOU's money/type validator, but retain ONLY the original reviewed DTO. In particular,
      // its form-default date and trimmed note are never inserted into the received draft.
      if (!parseDraft(draft, undefined, { dateEvidence: "explicit-only" }).ok) return undefined;
      entries.push(draft);
    }
    const payload = Object.freeze({ entries: Object.freeze(entries) });
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > LOCAL_IMPORT_LIMITS.payloadBytes) return undefined;
    return payload;
  } catch { return undefined; }
}

export function createLocalImportReceiver(binding: {
  senderOrigin: string;
  senderWindow: MessageEventSource;
  sessionNonce: string;
}) {
  const { senderOrigin, senderWindow, sessionNonce } = binding;
  if (!validOrigin(senderOrigin) || !senderWindow || !isLocalImportId(sessionNonce)) {
    throw new Error("Invalid local import binding");
  }
  let ready = false;
  let closed = false;
  const queue = new Map<string, { draft: PendingLocalImport; canonical: string }>();
  const common: Envelope = { version: LOCAL_IMPORT_VERSION, sessionNonce };
  const rejected = (reason: Rejection): LocalImportResult => ({
    kind: "rejected", reply: { ...common, type: "oc:app-import:rejected", reason },
  });

  return Object.freeze({
    /** Caller may post reply ONLY to senderWindow with senderOrigin, never '*'. No automatic I/O. */
    receive(event: LocalImportEvent): LocalImportResult {
      if (closed || event.source !== senderWindow || event.origin !== senderOrigin) return { kind: "ignored" };
      let message: Record<string, unknown> | undefined;
      try { message = dataRecord(event.data); } catch { return { kind: "ignored" }; }
      if (!message || message.version !== LOCAL_IMPORT_VERSION || message.sessionNonce !== sessionNonce) return { kind: "ignored" };
      if (message.type === "oc:app-import:hello" && exactKeys(message, ["type", "version", "sessionNonce"])) {
        ready = true;
        return { kind: "ready", reply: { ...common, type: "oc:app-import:ready" } };
      }
      if (!ready || message.type !== "oc:app-import:offer") return { kind: "ignored" };
      if (!exactKeys(message, ["type", "version", "sessionNonce", "importId", "actionId", "payload"]) ||
        !isLocalImportId(message.importId) || message.actionId !== LOCAL_IMPORT_ACTION) return rejected("invalid-offer");
      const payload = parseLocalImportPayload(message.payload);
      if (!payload) return rejected("invalid-offer");
      const canonical = JSON.stringify(payload);
      const prior = queue.get(message.importId);
      if (prior && prior.canonical !== canonical) return rejected("id-conflict");
      if (!prior && queue.size >= LOCAL_IMPORT_LIMITS.queued) return rejected("queue-full");
      const draft: PendingLocalImport = prior?.draft ?? Object.freeze({
        importId: message.importId, actionId: LOCAL_IMPORT_ACTION, senderOrigin, payload,
        status: "pending-review" as const,
      });
      if (!prior) queue.set(message.importId, { draft, canonical });
      return {
        kind: prior ? "duplicate" : "queued", draft,
        reply: { ...common, type: "oc:app-import:received", importId: message.importId, status: "pending-review" },
      };
    },
    pending(): readonly PendingLocalImport[] { return Object.freeze([...queue.values()].map((item) => item.draft)); },
    /** Invoke on navigation, logout, expiry or account change; old callbacks then cannot requeue. */
    close(): void { closed = true; ready = false; queue.clear(); },
  });
}
