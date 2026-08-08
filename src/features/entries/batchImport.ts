// Atomic/idempotent multi-entry ledger import.
//
// Encryption still happens entirely in the signed-in browser under K_sheet.
// Only after every row is encrypted do we make one canister update. The
// sheet-scoped import identity is the exact app-scoped OpenChat message handle;
// the backend receipt turns an outcome-unknown retry into a read of the
// original entry ids rather than another append.

import { encryptEntryPayload } from "../crypto/devVetkd";
import type { EntryPayload } from "./types";

const MIN_BATCH_ENTRIES = 1;
const MAX_BATCH_ENTRIES = 32;
const HASH_BYTES = 32;
const LEGACY_RELAY_DOMAIN = new TextEncoder().encode("iou-entry-batch-relay-v1\0");
const MAX_U64 = (1n << 64n) - 1n;

type EncryptedEntry = {
  entryKey: Uint8Array;
  ciphertext: Uint8Array;
  iv: Uint8Array;
};

export type EntryBatchActor = {
  add_entry_batch(request: {
    sheet_id: string;
    import_id: number[];
    entries: {
      entry_key: number[];
      ciphertext: number[];
      iv: number[];
    }[];
  }): Promise<{ entry_ids: bigint[] | BigUint64Array; replayed: boolean }>;
};

export type EntryBatchAcknowledgement = {
  entry_ids: bigint[];
  replayed: boolean;
  /** Number of rows accepted by the authoritative receipt. */
  accepted_count: number;
};

export type BatchImportContext = {
  sheetId: string;
  principal: string;
};

/** Prevent a modal opened under one route/account from writing under another. */
export function batchImportContextMatches(
  captured: BatchImportContext,
  sheetId: string,
  principal: string | null,
): boolean {
  return principal !== null && captured.sheetId === sheetId && captured.principal === principal;
}

/**
 * Clearing an accepted relay item can itself await I/O. Re-check afterwards
 * before applying route-local effects (chat mapping, reload, modal state).
 */
export async function finalizeAcceptedChatImport(options: {
  captured: BatchImportContext;
  clear: () => Promise<void>;
  current: () => { sheetId: string; principal: string | null };
}): Promise<boolean> {
  await options.clear();
  const current = options.current();
  return batchImportContextMatches(options.captured, current.sheetId, current.principal);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto SubtleCrypto is not available");
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return new Uint8Array(await subtle.digest("SHA-256", input));
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeCanonicalHandle(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("OpenChat message handle must be canonical unpadded base64url for exactly 32 bytes");
  }
  let bytes: Uint8Array;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("OpenChat message handle must be canonical unpadded base64url for exactly 32 bytes");
  }
  if (bytes.byteLength !== HASH_BYTES || encodeBase64Url(bytes) !== value) {
    throw new Error("OpenChat message handle must be canonical unpadded base64url for exactly 32 bytes");
  }
  return bytes;
}

/** Resolve the stable sheet-scoped idempotency identity for this import. */
export async function batchImportIdentity(
  messageHandle: string | null,
  relayId: string,
): Promise<Uint8Array> {
  if (messageHandle !== null) return decodeCanonicalHandle(messageHandle);
  if (typeof relayId !== "string" || relayId.length === 0 || relayId.length > 512) {
    throw new Error("legacy relay batch id must contain 1..=512 characters");
  }
  return digest(concatBytes(LEGACY_RELAY_DOMAIN, new TextEncoder().encode(relayId)));
}

function validateAcknowledgement(
  value: { entry_ids: bigint[] | BigUint64Array; replayed: boolean },
  submittedCount: number,
): EntryBatchAcknowledgement {
  if (!value || typeof value.replayed !== "boolean") {
    throw new Error("invalid batch acknowledgement from IOU backend");
  }
  const wireIds = value.entry_ids;
  if (!Array.isArray(wireIds) && !(wireIds instanceof BigUint64Array)) {
    throw new Error("invalid batch acknowledgement from IOU backend");
  }
  const entryIds = Array.from(wireIds);
  if (
    entryIds.length === 0 ||
    entryIds.length > MAX_BATCH_ENTRIES ||
    entryIds.some((id) => typeof id !== "bigint" || id <= 0n || id > MAX_U64) ||
    new Set(entryIds.map(String)).size !== entryIds.length ||
    (!value.replayed && entryIds.length !== submittedCount)
  ) {
    throw new Error("invalid batch acknowledgement from IOU backend");
  }
  return {
    entry_ids: entryIds,
    replayed: value.replayed,
    accepted_count: entryIds.length,
  };
}

export async function addEntryBatch(options: {
  actor: EntryBatchActor | null | undefined;
  sheetId: string;
  payloads: EntryPayload[];
  messageHandle: string | null;
  relayId: string;
  sheetKey: Uint8Array;
  encrypt?: (plaintext: Uint8Array, sheetKey: Uint8Array) => Promise<EncryptedEntry>;
  /** Re-check route/auth state after encryption and immediately before mutation. */
  beforeMutate?: () => void;
}): Promise<EntryBatchAcknowledgement> {
  const { actor, sheetId, payloads, messageHandle, relayId, sheetKey } = options;
  if (!actor || typeof actor.add_entry_batch !== "function") {
    throw new Error("IOU backend is unavailable; no entries were added");
  }
  if (!/^[0-9a-f]{16}$/.test(sheetId)) {
    throw new Error("sheet id must be a canonical 16-character lowercase hexadecimal value");
  }
  if (payloads.length < MIN_BATCH_ENTRIES || payloads.length > MAX_BATCH_ENTRIES) {
    throw new Error("entry batch must contain 1..32 rows");
  }
  if (!(sheetKey instanceof Uint8Array) || sheetKey.byteLength !== 32) {
    throw new Error("sheet key must be exactly 32 bytes");
  }

  const importId = await batchImportIdentity(messageHandle, relayId);
  const encrypt = options.encrypt ?? encryptEntryPayload;

  // Prepare everything before the sole mutating call. A row-level WebCrypto
  // failure therefore cannot leave a prefix of the batch in the ledger.
  const encryptedRows: EncryptedEntry[] = [];
  for (const payload of payloads) {
    encryptedRows.push(
      await encrypt(new TextEncoder().encode(JSON.stringify(payload)), sheetKey),
    );
  }

  options.beforeMutate?.();

  const acknowledgement = await actor.add_entry_batch({
    sheet_id: sheetId,
    import_id: Array.from(importId),
    entries: encryptedRows.map((row) => ({
      entry_key: Array.from(row.entryKey),
      ciphertext: Array.from(row.ciphertext),
      iv: Array.from(row.iv),
    })),
  });
  return validateAcknowledgement(acknowledgement, payloads.length);
}
