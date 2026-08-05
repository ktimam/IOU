// IOU backend E2E against the LIVE replica, driving the canister with two
// distinct identities (= two users). Proves the confirmable-action-adjacent
// surface end to end: E2E-encrypted entries (A encrypts, B decrypts via the
// shared wrapped K_sheet), cross-currency fee → balance, per-user consumer-key
// isolation, caller-scoped chat→sheet links, template blob round-trip, and the
// consumer "import a decrypted draft into the linked sheet" loop.

import { it, expect, beforeAll } from "vitest";
import { describeE2E, freshIdentity, iouActor, optVal } from "./env";
import {
  deriveUserKeypair,
  newSheetKey,
  wrapSheetKey,
  unwrapSheetKey,
  encryptEntryPayload,
  decryptEntryPayload,
} from "../../src/features/crypto/devVetkd";
import { encodeEntry, decodeEntry, type EntryPayload } from "../../src/features/entries/types";
import { currencyFromUserRecord } from "../../src/features/settings/defaultCurrency";
import { computeBalances } from "../../src/features/entries/balance";
import { parseDraft } from "../../src/features/entries/draft";
import { sheetIdToNat64, nat64ToSheetId } from "../../src/features/openchat/chatSheetLinks";

function u8(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

type Member = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actor: any;
  principal: string;
  kp: { publicKey: CryptoKey; privateKey: CryptoKey };
};

describeE2E("IOU backend — two-user pair/sheet/entry E2E", () => {
  let A: Member;
  let B: Member;
  let pairId: string;
  let sheetId: string;
  let K: Uint8Array;

  beforeAll(async () => {
    const aId = freshIdentity();
    const bId = freshIdentity();
    const aActor = await iouActor(aId);
    const bActor = await iouActor(bId);
    const aKp = await deriveUserKeypair(aId.getPrincipal().toText());
    const bKp = await deriveUserKeypair(bId.getPrincipal().toText());
    A = { actor: aActor, principal: aId.getPrincipal().toText(), kp: aKp };
    B = { actor: bActor, principal: bId.getPrincipal().toText(), kp: bKp };

    const cp = await A.actor.create_pair();
    pairId = cp.pair_id;
    await B.actor.join_pair(cp.invite_code);

    K = newSheetKey();
    const wrapA = await wrapSheetKey(K, aKp.publicKey, aKp.privateKey); // A wraps for A (self)
    const wrapB = await wrapSheetKey(K, bKp.publicKey, aKp.privateKey); // A wraps for B
    const sheet = await A.actor.create_sheet({
      pair_id: pairId,
      closing_window_days: 30,
      wrapped_key_a: Array.from(wrapA),
      wrapped_key_b: Array.from(wrapB),
      name_enc: [],
      name_iv: [],
    });
    sheetId = sheet.id;
  });

  it("pairs two users and creates a shared sheet", () => {
    expect(pairId).toBeTruthy();
    expect(sheetId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("A adds an encrypted cross-currency entry; B unwraps K and decrypts it, balance matches", async () => {
    const payload: EntryPayload = {
      ts: Date.UTC(2026, 5, 1),
      kind: "expense",
      currency: "USD",
      amount_minor: 100000, // net = gross (percent 0; foreign fixed fee not netted)
      direction: "credit",
      note: "reservation deposit",
      txn_type: "iou",
      fee: { percent: 0, fixed_minor: 50000, fixed_currency: "EGP", gross_amount_minor: 100000 },
    };
    const enc = await encryptEntryPayload(encodeEntry(payload), K);
    const entry = await A.actor.add_entry({
      sheet_id: sheetId,
      entry_key: Array.from(enc.entryKey),
      ciphertext: Array.from(enc.ciphertext),
      iv: Array.from(enc.iv),
    });
    expect(entry.id).toBeGreaterThanOrEqual(0n);

    // B recovers the shared sheet key from ITS wrapped copy, then decrypts.
    const wkB = optVal(await B.actor.get_sheet_wrapped_key(sheetId));
    expect(wkB).toBeTruthy();
    const KB = await unwrapSheetKey(u8(wkB!), B.kp.privateKey, A.kp.publicKey);
    expect(Array.from(KB)).toEqual(Array.from(K)); // both members derive the same K_sheet

    const listed = await B.actor.list_entries(sheetId, [], 100);
    const mine = listed.entries.find((e: { id: bigint }) => e.id === entry.id);
    expect(mine).toBeDefined();
    const decoded = decodeEntry(await decryptEntryPayload(u8(mine.entry_key), u8(mine.iv), u8(mine.ciphertext), KB));
    expect(decoded).toEqual(payload);

    // The cross-currency fee shows as its own opposite-direction EGP line.
    expect(computeBalances([decoded])).toEqual([
      { currency: "USD", amount_minor: 100000 },
      { currency: "EGP", amount_minor: -50000 },
    ]);
  });

  it("ciphertext is bound to K_sheet (a wrong key cannot decrypt)", async () => {
    const enc = await encryptEntryPayload(encodeEntry({ ts: 0, kind: "payment", currency: "USD", amount_minor: 1, direction: "credit", note: "x" }), K);
    await expect(decryptEntryPayload(enc.entryKey, enc.iv, enc.ciphertext, newSheetKey())).rejects.toBeTruthy();
  });

  it("consumer keypair is caller-keyed and its stable epoch rejects stale/ABA writes", async () => {
    // The canister guards: wrapped key non-empty ≤8192 bytes; pem must be a 1..2000-char SPKI PEM.
    const PEM_A = "-----BEGIN PUBLIC KEY-----\nAAAA-KEY-A\n-----END PUBLIC KEY-----\n";
    const PEM_B = "-----BEGIN PUBLIC KEY-----\nBBBB-KEY-B\n-----END PUBLIC KEY-----\n";
    const a0 = await A.actor.get_consumer_keypair();
    const b0 = await B.actor.get_consumer_keypair();
    expect(a0).toMatchObject({ mutation_epoch: 0n, keypair: [] });
    expect(b0).toMatchObject({ mutation_epoch: 0n, keypair: [] });
    expect(await A.actor.set_consumer_keypair(0n, new Array(32).fill(7), PEM_A))
      .toEqual({ Ok: 1n });
    expect(await B.actor.set_consumer_keypair(0n, new Array(32).fill(9), PEM_B))
      .toEqual({ Ok: 1n });
    expect(optVal((await A.actor.get_consumer_keypair()).keypair)?.public_key_pem).toBe(PEM_A);
    expect(optVal((await B.actor.get_consumer_keypair()).keypair)?.public_key_pem).toBe(PEM_B);

    expect(await A.actor.delete_consumer_keypair(1n)).toEqual({ Ok: 2n });
    expect(await A.actor.get_consumer_keypair()).toMatchObject({ mutation_epoch: 2n, keypair: [] });
    // A request prepared before delete cannot land after its tombstone.
    expect(await A.actor.set_consumer_keypair(1n, new Array(32).fill(8), PEM_A))
      .toEqual({
        Err: { StaleEpoch: { expected_epoch: 1n, current_epoch: 2n } },
      });

    // Reconnect is allowed only by explicitly observing the tombstone epoch.
    expect(await A.actor.set_consumer_keypair(2n, new Array(32).fill(10), PEM_A))
      .toEqual({ Ok: 3n });
    // The old epoch is still rejected after the value cycles absent -> present (ABA).
    expect(await A.actor.set_consumer_keypair(1n, new Array(32).fill(11), PEM_A))
      .toEqual({
        Err: { StaleEpoch: { expected_epoch: 1n, current_epoch: 3n } },
      });
    expect(await A.actor.delete_consumer_keypair(3n)).toEqual({ Ok: 4n });
    expect(await A.actor.get_consumer_keypair()).toMatchObject({ mutation_epoch: 4n, keypair: [] });
    // B's copy is untouched.
    expect(optVal((await B.actor.get_consumer_keypair()).keypair)?.public_key_pem).toBe(PEM_B);
  });

  it("chat→sheet links are caller-scoped and round-trip loss-free", async () => {
    const chatKey = "group:e2e-" + sheetId.slice(0, 6);
    await A.actor.set_chat_sheet_link(chatKey, sheetIdToNat64(sheetId));
    const aLinks = (await A.actor.chat_sheet_links()) as { chat_key: string; sheet_id: bigint }[];
    const link = aLinks.find((l) => l.chat_key === chatKey);
    expect(link).toBeDefined();
    expect(nat64ToSheetId(BigInt(link!.sheet_id))).toBe(sheetId);

    // B does not see A's links.
    const bLinks = (await B.actor.chat_sheet_links()) as { chat_key: string }[];
    expect(bLinks.some((l) => l.chat_key === chatKey)).toBe(false);

    await A.actor.remove_chat_sheet_link(chatKey);
    const after = (await A.actor.chat_sheet_links()) as { chat_key: string }[];
    expect(after.some((l) => l.chat_key === chatKey)).toBe(false);
  });

  it("user templates blob round-trips (opaque encrypted, size-checked only)", async () => {
    // The canister guards the iv to 12..16 bytes (a real AES-GCM nonce) and caps the blob at 64000.
    await A.actor.set_user_templates([1, 2, 3, 4], [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const rec = optVal(await A.actor.get_my_user());
    expect(rec).toBeTruthy();
    expect(Array.from(u8(optVal(rec.templates_enc)!))).toEqual([1, 2, 3, 4]);
  });

  it("consumer import loop: a decrypted draft parses, encrypts, and lands in the linked sheet", async () => {
    // The import half of the confirmable-action loop (the OpenChat deposit half is covered by the
    // Rust integration test on these same canisters — see test/README.md). Here: a decrypted inbox
    // payload → parseDraft → encrypt under K → add_entry → the linked sheet holds it, decryptable.
    const parsed = parseDraft({ kind: "settlement", amount: "42.50", currency: "usd", direction: "credit", note: "dinner", draft_id: "d:e2e-import" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const initial = parsed.value.initial;
    const payload: EntryPayload = {
      ts: initial.ts!,
      kind: initial.txn_type === "settlement" ? "payment" : "expense",
      currency: initial.currency!,
      amount_minor: initial.amount_minor!,
      direction: initial.direction!,
      note: initial.note!,
      txn_type: initial.txn_type,
      draft_id: initial.draft_id,
    };

    // Link the chat to this sheet, then import as if the draft arrived from that chat.
    await A.actor.set_chat_sheet_link("group:import-e2e", sheetIdToNat64(sheetId));
    const enc = await encryptEntryPayload(encodeEntry(payload), K);
    const entry = await A.actor.add_entry({
      sheet_id: sheetId,
      entry_key: Array.from(enc.entryKey),
      ciphertext: Array.from(enc.ciphertext),
      iv: Array.from(enc.iv),
    });

    const listed = await A.actor.list_entries(sheetId, [], 100);
    const mine = listed.entries.find((e: { id: bigint }) => e.id === entry.id);
    const decoded = decodeEntry(await decryptEntryPayload(u8(mine.entry_key), u8(mine.iv), u8(mine.ciphertext), K));
    expect(decoded.draft_id).toBe("d:e2e-import"); // idempotency key survived the round-trip
    expect(decoded.amount_minor).toBe(4250);
    await A.actor.remove_chat_sheet_link("group:import-e2e");
  });

  it("default currency: canister rejects non-ISO junk, stores uppercase, and is caller-keyed", async () => {
    // The ISO guard lives ONLY on the canister (set_default_currency, src/lib.rs) — the client-side
    // normalizer in defaultCurrency.ts drops junk before it is ever sent, so every unit test passes
    // whether or not the canister checks anything. Drop that trap and a stray "EGYPT" (or a code from
    // a future build that isn't three letters) is accepted and persisted, and every picker and chat
    // import then reads a default no currency table knows, silently falling back to USD on the money.
    await expect(A.actor.set_default_currency("EGYPT")).rejects.toThrow(/3-letter ISO/i);
    await expect(A.actor.set_default_currency("E1P")).rejects.toThrow(/3-letter ISO/i);

    // Trimmed and uppercased BY THE CANISTER. Asserted on the raw candid field, not through
    // currencyFromUserRecord: that helper uppercases too, so reading the default only through it
    // would keep passing with the canister's normalization gone — and the two devices that wrote
    // "egp" and "EGP" would then be storing values that never compare equal.
    await A.actor.set_default_currency("  eGp  ");
    const recA = optVal(await A.actor.get_my_user()) as { default_currency: [] | [string] };
    expect(optVal(recA.default_currency)).toBe("EGP");
    expect(currencyFromUserRecord(recA)).toBe("EGP");

    // Caller-keyed is the entire point of a per-USER default. A third identity that has never chosen
    // one must still read nothing — a canister-global default would stamp A's EGP onto every other
    // user's entry forms and chat imports instead of letting them fall back.
    const C = await iouActor(freshIdentity());
    expect(currencyFromUserRecord(optVal(await C.get_my_user()))).toBeUndefined();

    // ...and the WRITE is caller-keyed too, not just the read: B choosing its own must not clobber A's.
    await B.actor.set_default_currency("usd");
    expect(currencyFromUserRecord(optVal(await B.actor.get_my_user()))).toBe("USD");
    expect(currencyFromUserRecord(optVal(await A.actor.get_my_user()))).toBe("EGP");
  });
});
