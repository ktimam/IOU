import { decryptEntryPayload } from "../crypto/devVetkd";
import { decodeEntry, type EntryPayload } from "./types";

export type EntryHistoryVersion = { payload: EntryPayload; replacedAt: number };

export type DecryptedEntry = {
  id: number;
  created_by: string;
  created_at_server: number;
  updated_at_server: number | null;
  payload: EntryPayload;
  deleted: boolean;
  history: EntryHistoryVersion[];
};

export type EntryDecodeFailure = {
  entryId: number;
  stage: "entry" | "history";
  historyIndex?: number;
};

function bytes(value: unknown): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value as number[]);
}

function principalText(value: unknown): string {
  return value != null && typeof (value as { toText?: unknown }).toText === "function"
    ? (value as { toText: () => string }).toText()
    : String(value ?? "");
}

/**
 * Treat every encrypted record as an independent trust boundary. A peer may write malformed
 * ciphertext or JSON, but that must not hide the other valid entries in the sheet.
 */
export async function decryptEntryRecords(
  records: any[],
  sheetKey: Uint8Array,
): Promise<{ entries: DecryptedEntry[]; failures: EntryDecodeFailure[] }> {
  const entries: DecryptedEntry[] = [];
  const failures: EntryDecodeFailure[] = [];

  for (const record of records) {
    const entryId = Number(record.id);
    try {
      const plaintext = await decryptEntryPayload(
        bytes(record.entry_key),
        bytes(record.iv),
        bytes(record.ciphertext),
        sheetKey,
      );
      const payload = decodeEntry(plaintext);
      const versions: any[] =
        record.history && record.history.length ? record.history[0] : [];
      const history: EntryHistoryVersion[] = [];
      for (let historyIndex = 0; historyIndex < versions.length; historyIndex++) {
        const version = versions[historyIndex];
        try {
          const prior = await decryptEntryPayload(
            bytes(version.entry_key),
            bytes(version.iv),
            bytes(version.ciphertext),
            sheetKey,
          );
          history.push({
            payload: decodeEntry(prior),
            replacedAt: Number(version.replaced_at),
          });
        } catch {
          failures.push({ entryId, stage: "history", historyIndex });
        }
      }
      entries.push({
        id: entryId,
        created_by: principalText(record.created_by),
        created_at_server: Number(record.created_at_server),
        updated_at_server:
          record.updated_at_server && record.updated_at_server.length
            ? Number(record.updated_at_server[0])
            : null,
        payload,
        deleted: !!(record.deleted_at && record.deleted_at.length),
        history,
      });
    } catch {
      failures.push({ entryId, stage: "entry" });
    }
  }

  return { entries, failures };
}
