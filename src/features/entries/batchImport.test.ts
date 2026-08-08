import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { EntryPayload } from "./types";
import {
  addEntryBatch,
  batchImportContextMatches,
  batchImportIdentity,
  finalizeAcceptedChatImport,
} from "./batchImport";

const payload = (amount: number): EntryPayload => ({
  ts: Date.UTC(2026, 7, 8),
  kind: "expense",
  currency: "USD",
  amount_minor: amount,
  direction: "credit",
  note: `row-${amount}`,
  txn_type: "iou",
  draft_id: `draft-${amount}`,
  import_message_id: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
});

const encrypted = (seed: number) => ({
  entryKey: new Uint8Array(32).fill(seed),
  ciphertext: new Uint8Array(32).fill(seed + 1),
  iv: new Uint8Array(12).fill(seed + 2),
});

describe("atomic OpenChat batch import", () => {
  it("prepares every encrypted row before making the one backend mutation", async () => {
    const actor = { add_entry_batch: vi.fn() };
    const encrypt = vi
      .fn()
      .mockResolvedValueOnce(encrypted(1))
      .mockRejectedValueOnce(new Error("injected row-2 encryption failure"));

    await expect(
      addEntryBatch({
        actor,
        sheetId: "0123456789abcdef",
        payloads: [payload(100), payload(200), payload(300)],
        messageHandle: payload(100).import_message_id!,
        relayId: "oc-unused",
        sheetKey: new Uint8Array(32).fill(9),
        encrypt,
      }),
    ).rejects.toThrow("injected row-2 encryption failure");

    expect(actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it("retries an outcome-unknown call by import identity despite payload and count drift", async () => {
    const stored: unknown[] = [];
    let receipt: { entryIds: bigint[] } | undefined;
    let first = true;
    const actor = {
      add_entry_batch: vi.fn(async (request: any) => {
        if (receipt) {
          return { entry_ids: receipt.entryIds, replayed: true };
        }
        const entryIds = request.entries.map((_: unknown, index: number) => BigInt(index + 1));
        stored.push(...entryIds);
        receipt = { entryIds };
        if (first) {
          first = false;
          throw new Error("injected response loss after commit");
        }
        return { entry_ids: entryIds, replayed: false };
      }),
    };
    let nonce = 1;
    const encrypt = vi.fn(async () => encrypted(nonce++));
    const args = {
      actor,
      sheetId: "0123456789abcdef",
      payloads: [payload(100), payload(200)],
      messageHandle: payload(100).import_message_id!,
      relayId: "oc-unused",
      sheetKey: new Uint8Array(32).fill(9),
      encrypt,
    };

    await expect(addEntryBatch(args)).rejects.toThrow("injected response loss after commit");
    const reparsedAfterSettingsAndTemplateDrift: EntryPayload = {
      ...payload(999),
      ts: payload(999).ts + 86_400_000,
      currency: "EGP",
      note: "changed next day after private type/default preference changed",
      schedule: [{ due_ts: payload(999).ts + 2 * 86_400_000, percent: 100 }],
      fee: { percent: 10, gross_amount_minor: 1110 },
    };
    await expect(
      addEntryBatch({ ...args, payloads: [reparsedAfterSettingsAndTemplateDrift] }),
    ).resolves.toMatchObject({ replayed: true, entry_ids: [1n, 2n], accepted_count: 2 });
    expect(stored).toHaveLength(2);
    expect(actor.add_entry_batch).toHaveBeenCalledTimes(2);
    expect(actor.add_entry_batch.mock.calls[0][0].entries).not.toEqual(
      actor.add_entry_batch.mock.calls[1][0].entries,
    );
    expect(actor.add_entry_batch.mock.calls[0][0]).not.toHaveProperty("payload_hash");
  });

  it("uses the exact canonical OpenChat message handle as the sheet-scoped idempotency identity", async () => {
    const handle = Buffer.from(new Uint8Array(32).fill(11)).toString("base64url");
    await expect(batchImportIdentity(handle, "oc-anything")).resolves.toEqual(
      new Uint8Array(32).fill(11),
    );
    await expect(batchImportIdentity(handle + "=", "oc-anything")).rejects.toThrow(/canonical/i);
  });

  it("accepts a filtered one-row card but rejects empty and oversized new imports", async () => {
    const actor = { add_entry_batch: vi.fn() };
    const encrypt = vi.fn(async () => encrypted(1));
    actor.add_entry_batch.mockResolvedValue({ entry_ids: [1n], replayed: false });
    await expect(
      addEntryBatch({
        actor,
        sheetId: "0123456789abcdef",
        payloads: [payload(1)],
        messageHandle: payload(1).import_message_id!,
        relayId: "oc-unused",
        sheetKey: new Uint8Array(32).fill(9),
        encrypt,
      }),
    ).resolves.toMatchObject({ entry_ids: [1n] });

    for (const payloads of [[], Array.from({ length: 33 }, (_, i) => payload(i + 1))]) {
      await expect(
        addEntryBatch({
          actor,
          sheetId: "0123456789abcdef",
          payloads,
          messageHandle: payload(1).import_message_id!,
          relayId: "oc-unused",
          sheetKey: new Uint8Array(32).fill(9),
          encrypt,
        }),
      ).rejects.toThrow(/1\.\.32/);
    }
    expect(encrypt).toHaveBeenCalledTimes(1);
    expect(actor.add_entry_batch).toHaveBeenCalledTimes(1);
  });

  it("fails before encryption when the authenticated backend actor is unavailable", async () => {
    const encrypt = vi.fn(async () => encrypted(1));
    await expect(
      addEntryBatch({
        actor: null,
        sheetId: "0123456789abcdef",
        payloads: [payload(1), payload(2)],
        messageHandle: payload(1).import_message_id!,
        relayId: "oc-unused",
        sheetKey: new Uint8Array(32).fill(9),
        encrypt,
      }),
    ).rejects.toThrow(/backend is unavailable/i);
    expect(encrypt).not.toHaveBeenCalled();
  });

  it("rejects malformed backend acknowledgements so callers cannot clear the inbox", async () => {
    const base = {
      sheetId: "0123456789abcdef",
      payloads: [payload(1), payload(2)],
      messageHandle: payload(1).import_message_id!,
      relayId: "oc-unused",
      sheetKey: new Uint8Array(32).fill(9),
      encrypt: vi.fn(async () => encrypted(1)),
    };
    for (const acknowledgement of [
      { entry_ids: [1n], replayed: false },
      { entry_ids: [], replayed: true },
      { entry_ids: [0n, 1n], replayed: true },
      { entry_ids: [1n, 1n], replayed: true },
      { entry_ids: Array.from({ length: 33 }, (_, index) => BigInt(index + 1)), replayed: true },
    ]) {
      await expect(
        addEntryBatch({
          ...base,
          actor: { add_entry_batch: vi.fn(async () => acknowledgement) },
        }),
      ).rejects.toThrow(/invalid batch acknowledgement/i);
    }
  });

  it("binds a pending import to the sheet and signed-in principal that opened it", () => {
    const captured = { sheetId: "0123456789abcdef", principal: "father-principal" };
    expect(batchImportContextMatches(captured, captured.sheetId, captured.principal)).toBe(true);
    expect(batchImportContextMatches(captured, "fedcba9876543210", captured.principal)).toBe(false);
    expect(batchImportContextMatches(captured, captured.sheetId, "manager-principal")).toBe(false);
    expect(batchImportContextMatches(captured, captured.sheetId, null)).toBe(false);
  });

  it("rechecks captured route/auth state after encryption and before the sole mutation", async () => {
    const actor = {
      add_entry_batch: vi.fn(async () => ({ entry_ids: [1n], replayed: false })),
    };
    await expect(
      addEntryBatch({
        actor,
        sheetId: "0123456789abcdef",
        payloads: [payload(1)],
        messageHandle: payload(1).import_message_id!,
        relayId: "oc-unused",
        sheetKey: new Uint8Array(32).fill(9),
        encrypt: vi.fn(async () => encrypted(1)),
        beforeMutate: () => {
          throw new Error("route changed");
        },
      }),
    ).rejects.toThrow("route changed");
    expect(actor.add_entry_batch).not.toHaveBeenCalled();
  });

  it("does not apply route-local effects when account/sheet changes during deferred clear", async () => {
    const captured = { sheetId: "0123456789abcdef", principal: "father-principal" };
    let active: { sheetId: string; principal: string | null } = { ...captured };
    let releaseClear!: () => void;
    const clear = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseClear = resolve;
      }),
    );
    const finalizing = finalizeAcceptedChatImport({
      captured,
      clear,
      current: () => active,
    });
    active = { sheetId: "fedcba9876543210", principal: "manager-principal" };
    releaseClear();
    await expect(finalizing).resolves.toBe(false);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it("clears the inbox only after the one atomic backend call resolves", () => {
    const source = readFileSync(new URL("./SheetPage.tsx", import.meta.url), "utf8");
    const start = source.indexOf("async function confirmBatch()");
    const end = source.indexOf("// Entry delete", start);
    const confirmBatch = source.slice(start, end > start ? end : undefined);
    expect(confirmBatch).toContain("if (!actor)");
    expect(confirmBatch).not.toMatch(/for\s*\([^)]*batch\.drafts/);
    expect(confirmBatch.indexOf("await addEntryBatch(")).toBeGreaterThanOrEqual(0);
    expect(confirmBatch).toContain("clear: () => clearRelay(batch.relayId)");
    expect(confirmBatch.indexOf("await finalizeAcceptedChatImport(")).toBeGreaterThan(
      confirmBatch.indexOf("await addEntryBatch("),
    );
  });

  it("routes a single pending ADD through the receipt endpoint while local adds stay on add_entry", () => {
    const source = readFileSync(new URL("./SheetPage.tsx", import.meta.url), "utf8");
    const start = source.indexOf("async function onSubmit(");
    const end = source.indexOf("async function confirmBatch()", start);
    const onSubmit = source.slice(start, end);
    expect(onSubmit).toMatch(/pendingRelayId[\s\S]*await addEntryBatch\(/);
    expect(onSubmit).toMatch(/else[\s\S]*await writeEntry\(toStore\)/);
    expect(onSubmit).toContain("clear: () => clearRelay(pendingRelayId)");
    expect(onSubmit.indexOf("await finalizeAcceptedChatImport(")).toBeGreaterThan(
      onSubmit.indexOf("await addEntryBatch("),
    );
  });
});
