import { webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encryptEntryPayload,
  newSheetKey,
} from "../crypto/devVetkd";
import { decryptEntryRecords } from "./decryptEntries";
import { encodeEntry, type EntryPayload } from "./types";

if (!globalThis.crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

const valid: EntryPayload = {
  ts: Date.UTC(2026, 7, 1),
  kind: "expense",
  currency: "USD",
  amount_minor: 1200,
  direction: "debt",
  note: "valid",
};

async function record(
  id: number,
  plaintext: Uint8Array,
  key: Uint8Array,
  history: any[] = [],
) {
  const sealed = await encryptEntryPayload(plaintext, key);
  return {
    id,
    entry_key: sealed.entryKey,
    iv: sealed.iv,
    ciphertext: sealed.ciphertext,
    created_by: { toText: () => "principal-a" },
    created_at_server: 1,
    updated_at_server: [],
    deleted_at: [],
    history: history.length ? [history] : [],
  };
}

describe("decryptEntryRecords isolation", () => {
  it("keeps valid neighbors when one ciphertext fails authentication", async () => {
    const key = newSheetKey();
    const first = await record(1, encodeEntry(valid), key);
    const corrupt = await record(2, encodeEntry({ ...valid, note: "corrupt" }), key);
    corrupt.ciphertext = corrupt.ciphertext.slice();
    corrupt.ciphertext[corrupt.ciphertext.length - 1] ^= 1;
    const third = await record(3, encodeEntry({ ...valid, note: "still visible" }), key);

    const result = await decryptEntryRecords([first, corrupt, third], key);
    expect(result.entries.map((entry) => entry.id)).toEqual([1, 3]);
    expect(result.failures).toEqual([{ entryId: 2, stage: "entry" }]);
  });

  it.each([
    ["malformed JSON", new TextEncoder().encode("{")],
    ["valid JSON with an invalid entry shape", new TextEncoder().encode("{}")],
  ])("skips %s without hiding valid entries", async (_label, invalid) => {
    const key = newSheetKey();
    const bad = await record(1, invalid, key);
    const good = await record(2, encodeEntry(valid), key);
    const result = await decryptEntryRecords([bad, good], key);
    expect(result.entries.map((entry) => entry.id)).toEqual([2]);
    expect(result.failures).toEqual([{ entryId: 1, stage: "entry" }]);
  });

  it.each([
    ["invalid date range", { ...valid, ts: Number.MAX_SAFE_INTEGER }],
    ["negative amount", { ...valid, amount_minor: -1 }],
    ["invalid schedule row", { ...valid, schedule: [{ due_ts: valid.ts, percent: 101 }] }],
    [
      "invalid schedule total",
      {
        ...valid,
        txn_type: "iou",
        schedule: [
          { due_ts: valid.ts, percent: 60 },
          { due_ts: valid.ts + 1, percent: 39 },
        ],
      },
    ],
    [
      "invalid fee object",
      { ...valid, fee: { percent: 10, gross_amount_minor: "1200" } },
    ],
    [
      "inconsistent fee net",
      {
        ...valid,
        txn_type: "iou",
        amount_minor: 1_199,
        fee: { percent: 20, gross_amount_minor: 1_200 },
      },
    ],
    [
      "invalid conversion object",
      {
        ...valid,
        convert: {
          from_currency: "EUR",
          from_amount_minor: 1000,
          to_currency: "USD",
          to_amount_minor: 1200,
          rate: "1.2",
          rate_source: "test",
          rate_fetched_at: valid.ts,
        },
      },
    ],
  ])("isolates a nested %s payload from valid neighbors", async (_label, payload) => {
    const key = newSheetKey();
    const bad = await record(1, new TextEncoder().encode(JSON.stringify(payload)), key);
    const good = await record(2, encodeEntry(valid), key);
    const result = await decryptEntryRecords([bad, good], key);
    expect(result.entries.map((entry) => entry.id)).toEqual([2]);
    expect(result.failures).toEqual([{ entryId: 1, stage: "entry" }]);
  });

  it("keeps the current entry while skipping only a corrupt history version", async () => {
    const key = newSheetKey();
    const prior = await encryptEntryPayload(encodeEntry({ ...valid, note: "prior" }), key);
    const corrupt = { ...prior, ciphertext: prior.ciphertext.slice(), replaced_at: 2 };
    corrupt.ciphertext[0] ^= 1;
    const current = await record(1, encodeEntry(valid), key, [
      {
        entry_key: corrupt.entryKey,
        iv: corrupt.iv,
        ciphertext: corrupt.ciphertext,
        replaced_at: 2,
      },
    ]);

    const result = await decryptEntryRecords([current], key);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].history).toEqual([]);
    expect(result.failures).toEqual([{ entryId: 1, stage: "history", historyIndex: 0 }]);
  });

  it("keeps valid history neighbors when one history payload has an invalid nested shape", async () => {
    const key = newSheetKey();
    const first = await encryptEntryPayload(encodeEntry({ ...valid, note: "first" }), key);
    const malformed = await encryptEntryPayload(
      new TextEncoder().encode(JSON.stringify({ ...valid, convert: { rate: "not-a-number" } })),
      key,
    );
    const last = await encryptEntryPayload(encodeEntry({ ...valid, note: "last" }), key);
    const current = await record(1, encodeEntry(valid), key, [
      { entry_key: first.entryKey, iv: first.iv, ciphertext: first.ciphertext, replaced_at: 1 },
      {
        entry_key: malformed.entryKey,
        iv: malformed.iv,
        ciphertext: malformed.ciphertext,
        replaced_at: 2,
      },
      { entry_key: last.entryKey, iv: last.iv, ciphertext: last.ciphertext, replaced_at: 3 },
    ]);

    const result = await decryptEntryRecords([current], key);
    expect(result.entries[0].history.map((version) => version.payload.note)).toEqual([
      "first",
      "last",
    ]);
    expect(result.failures).toEqual([{ entryId: 1, stage: "history", historyIndex: 1 }]);
  });
});
