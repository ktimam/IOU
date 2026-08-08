// Atomic entry-batch E2E against the LIVE IOU canister.
//
// This is intentionally one isolated lifecycle rather than an ordered group of
// tests: every identity/account/sheet belongs only to this run, and the final
// cleanup removes the account (including its entries and batch receipts).
// The first authenticated batch call is also the real inspect_message admission
// check; an old deployment without add_entry_batch, or a build that omitted it
// from either inspect whitelist, fails before the rest of the scenario.

import { AnonymousIdentity } from "@dfinity/agent";
import { expect, it } from "vitest";
import { deriveUserKeypair, newSheetKey, wrapSheetKey } from "../../src/features/crypto/devVetkd";
import { describeE2E, freshIdentity, iouActor } from "./env";

type Actor = {
  // The E2E actor is generated dynamically from the hand-maintained Candid IDL.
  // Keep the structural surface here small so this test also catches IDL drift.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: any;
};

type Entry = {
  id: bigint;
  entry_key: Uint8Array | number[];
  ciphertext: Uint8Array | number[];
  iv: Uint8Array | number[];
};

type EncryptedRow = {
  entry_key: number[];
  ciphertext: number[];
  iv: number[];
};

function row(seed: number): EncryptedRow {
  return {
    entry_key: new Array(32).fill(seed & 0xff),
    ciphertext: new Array(16).fill((seed + 1) & 0xff),
    iv: new Array(12).fill((seed + 2) & 0xff),
  };
}

function importId(seed: number): number[] {
  // Receipts are sheet-scoped. A fresh sheet plus a full-width value makes the
  // fixture independent of every other run without exposing a chat coordinate.
  return Array.from({ length: 32 }, (_, index) => (seed + index) & 0xff);
}

async function entries(actor: Actor, sheetId: string): Promise<Entry[]> {
  const listed = (await actor.list_entries(sheetId, [], 100)) as { entries: Entry[] };
  return listed.entries;
}

function sortedIds(values: Entry[]): bigint[] {
  return values.map(({ id }) => id).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function captureCleanup(
  errors: unknown[],
  label: string,
  operation: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error) {
    errors.push(new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`));
    return false;
  }
}

describeE2E("IOU backend — atomic entry batch ingress, rollback, retry, and access", () => {
  it("commits all rows once and keeps receipts inaccessible after membership/state changes", async () => {
    const aIdentity = freshIdentity();
    const bIdentity = freshIdentity();
    const A = (await iouActor(aIdentity)) as Actor;
    const B = (await iouActor(bIdentity)) as Actor;
    const anonymous = (await iouActor(new AnonymousIdentity())) as Actor;

    let pairId: string | undefined;
    let sheetId: string | undefined;
    let bJoined = false;
    let bLeft = false;
    let pairSolo = false;
    let sheetClosed = false;
    let pairArchived = false;
    let pairDeleted = false;
    let scenarioError: unknown;

    try {
      const created = await A.create_pair();
      pairId = created.pair_id as string;
      pairSolo = true;
      await B.join_pair(created.invite_code);
      bJoined = true;
      pairSolo = false;

      const aKeys = await deriveUserKeypair(aIdentity.getPrincipal().toText());
      const bKeys = await deriveUserKeypair(bIdentity.getPrincipal().toText());
      const sheetKey = newSheetKey();
      const wrappedA = await wrapSheetKey(sheetKey, aKeys.publicKey, aKeys.privateKey);
      const wrappedB = await wrapSheetKey(sheetKey, bKeys.publicKey, aKeys.privateKey);
      const sheet = await A.create_sheet({
        pair_id: pairId,
        closing_window_days: 30,
        wrapped_key_a: Array.from(wrappedA),
        wrapped_key_b: Array.from(wrappedB),
        name_enc: [],
        name_iv: [],
      });
      sheetId = sheet.id as string;

      // A successful real ingress proves add_entry_batch is in inspect_message's
      // method whitelist as well as exported by the installed Wasm/Candid pair.
      const admission = await A.add_entry_batch({
        sheet_id: sheetId,
        import_id: importId(11),
        entries: [row(11)],
      });
      expect(admission).toMatchObject({ replayed: false });
      expect(Array.from(admission.entry_ids as Iterable<bigint>)).toHaveLength(1);

      // The same valid shape must be rejected at the authentication boundary,
      // before it can allocate an entry or receipt.
      const beforeAnonymous = await entries(A, sheetId);
      await expect(
        anonymous.add_entry_batch({
          sheet_id: sheetId,
          import_id: importId(22),
          entries: [row(22)],
        }),
      ).rejects.toThrow(/anonymous callers are not allowed/i);
      expect(sortedIds(await entries(A, sheetId))).toEqual(sortedIds(beforeAnonymous));

      // Row 2 is invalid. Full preflight must reject it before writing row 1,
      // advancing the counter, charging sheet bytes, or storing a receipt.
      const beforeBadBatch = await entries(A, sheetId);
      const badImportId = importId(33);
      const badRows = [row(31), row(32), row(33)];
      badRows[1] = { ...badRows[1], entry_key: new Array(31).fill(32) };
      await expect(
        A.add_entry_batch({
          sheet_id: sheetId,
          import_id: badImportId,
          entries: badRows,
        }),
      ).rejects.toThrow(/entry_key must be 32 bytes/i);
      expect(sortedIds(await entries(A, sheetId))).toEqual(sortedIds(beforeBadBatch));

      // Reuse the rejected import id with a valid two-row request. If the bad
      // call left a partial receipt, counter, or row behind, these assertions fail.
      const goodRows = [row(41), row(42)];
      const lostResponse = new Error("simulated response loss after batch commit");
      await expect(
        (async () => {
          await A.add_entry_batch({
            sheet_id: sheetId,
            import_id: badImportId,
            entries: goodRows,
          });
          throw lostResponse;
        })(),
      ).rejects.toBe(lostResponse);

      const afterCommit = await entries(A, sheetId);
      const beforeIds = sortedIds(beforeBadBatch);
      const committedIds = sortedIds(afterCommit).filter((id) => !beforeIds.includes(id));
      expect(committedIds).toHaveLength(2);
      expect(committedIds[1]).toBe(committedIds[0] + 1n);
      for (const [index, id] of committedIds.entries()) {
        const stored = afterCommit.find((entry) => entry.id === id);
        expect(stored).toBeDefined();
        expect(Array.from(stored!.entry_key)).toEqual(goodRows[index].entry_key);
        expect(Array.from(stored!.ciphertext)).toEqual(goodRows[index].ciphertext);
        expect(Array.from(stored!.iv)).toEqual(goodRows[index].iv);
      }

      // Retrying after the unknown outcome returns the authoritative original
      // ids and writes nothing. The other current sheet member converges on the
      // same sheet/message receipt rather than producing a second batch.
      const replayA = await A.add_entry_batch({
        sheet_id: sheetId,
        import_id: badImportId,
        entries: goodRows,
      });
      expect(replayA.replayed).toBe(true);
      expect(Array.from(replayA.entry_ids as Iterable<bigint>)).toEqual(committedIds);
      expect(sortedIds(await entries(A, sheetId))).toEqual(sortedIds(afterCommit));

      const replayB = await B.add_entry_batch({
        sheet_id: sheetId,
        import_id: badImportId,
        entries: goodRows,
      });
      expect(replayB.replayed).toBe(true);
      expect(Array.from(replayB.entry_ids as Iterable<bigint>)).toEqual(committedIds);
      expect(sortedIds(await entries(B, sheetId))).toEqual(sortedIds(afterCommit));

      // Access/state checks deliberately happen before receipt lookup. A former
      // member cannot probe an old receipt, and even the remaining owner cannot
      // replay one after the sheet closes.
      await B.leave_pair(pairId);
      bLeft = true;
      pairSolo = true;
      await expect(
        B.add_entry_batch({
          sheet_id: sheetId,
          import_id: badImportId,
          entries: goodRows,
        }),
      ).rejects.toThrow(/caller does not have access to this sheet/i);

      await A.close_sheet_encrypted(sheetId, {
        entry_key: new Uint8Array(32),
        ciphertext: new Uint8Array(16),
        iv: new Uint8Array(12),
      });
      sheetClosed = true;
      await expect(
        A.add_entry_batch({
          sheet_id: sheetId,
          import_id: badImportId,
          entries: goodRows,
        }),
      ).rejects.toThrow(/sheet is not active/i);
      expect(sortedIds(await entries(A, sheetId))).toEqual(sortedIds(afterCommit));
    } catch (error) {
      scenarioError = error;
    }

    const cleanupErrors: unknown[] = [];
    if (bJoined && !bLeft && pairId) {
      bLeft = await captureCleanup(cleanupErrors, "leave isolated pair", () => B.leave_pair(pairId));
      if (bLeft) pairSolo = true;
    }
    if (sheetId && !sheetClosed) {
      sheetClosed = await captureCleanup(cleanupErrors, "close isolated sheet", () =>
        A.close_sheet_encrypted(sheetId, {
          entry_key: new Uint8Array(32),
          ciphertext: new Uint8Array(16),
          iv: new Uint8Array(12),
        }),
      );
    }
    if (pairId && !pairArchived) {
      // Archiving is safe for an isolated account even if leave/close failed,
      // and delete_pair can purge an active sheet once the account is solo.
      pairArchived = await captureCleanup(cleanupErrors, "archive isolated pair", () =>
        A.archive_pair(pairId),
      );
    }
    if (pairId && pairSolo && pairArchived && !pairDeleted) {
      pairDeleted = await captureCleanup(cleanupErrors, "delete isolated pair", () =>
        A.delete_pair(pairId),
      );
    }

    if (scenarioError !== undefined) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError([scenarioError, ...cleanupErrors], "batch scenario and cleanup failed");
      }
      throw scenarioError;
    }
    expect(cleanupErrors).toEqual([]);
    expect(pairDeleted).toBe(true);
  }, 120_000);
});
