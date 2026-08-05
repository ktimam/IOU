// Regression E2E for the stale-invite fix (v1.10.1): `issue_invite` mints a fresh
// live code, and `accept_invite` grows a re-seal path. Reproduces the exact bug the
// user hit — "invalid or already-consumed invite code" — and proves the repairs:
//
//   1. issue_invite mints a FRESH code and RETIRES the previous one.
//   2. Re-invite after a partner LEAVES works (the old code was consumed on join).
//   3. Legacy "joined but not granted" pair self-heals: an already-member caller
//      re-accepts a fresh link and gets their sheet key sealed (fixes "no wrapped key").
//   4. A stranger still can't take a filled slot, even with a fresh code.
//
// Skips cleanly when the local replica is down (see env.ts).

import { it, expect } from "vitest";
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

function u8(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

async function member(id = freshIdentity()) {
  const kp = await deriveUserKeypair(id.getPrincipal().toText());
  return { actor: await iouActor(id), principal: id.getPrincipal().toText(), kp };
}

// A creates a solo account + one solo sheet; returns ids + the sheet key K.
async function soloAccount(A: Awaited<ReturnType<typeof member>>) {
  const cp = await A.actor.create_pair();
  const K = newSheetKey();
  const wrapA = await wrapSheetKey(K, A.kp.publicKey, A.kp.privateKey);
  const sheet = await A.actor.create_sheet({
    pair_id: cp.pair_id,
    closing_window_days: 30,
    wrapped_key_a: Array.from(wrapA),
    wrapped_key_b: [],
    name_enc: [],
    name_iv: [],
  });
  return { pairId: cp.pair_id as string, createCode: cp.invite_code as string, sheetId: sheet.id as string, K };
}

function rewrapFor(m: Awaited<ReturnType<typeof member>>, sheetId: string, K: Uint8Array) {
  return wrapSheetKey(K, m.kp.publicKey, m.kp.privateKey).then((blob) => ({
    sheet_id: sheetId,
    wrapped_key_for_partner: Array.from(blob),
  }));
}
function pubkeyOf(m: Awaited<ReturnType<typeof member>>) {
  return Array.from(new TextEncoder().encode(m.kp.publicKeyB64));
}

describeE2E("IOU invite reissue + re-seal (stale-invite fix)", () => {
  it("issue_invite mints a fresh code and RETIRES the previous one", async () => {
    const A = await member();
    const { pairId, createCode } = await soloAccount(A);
    const fresh = (await A.actor.issue_invite(pairId)) as string;
    expect(fresh).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(fresh).not.toBe(createCode);

    // The original create_pair code is now dead; only the fresh one accepts.
    const B = await member();
    await expect(B.actor.accept_invite(createCode, [], pubkeyOf(B))).rejects.toThrow(
      /invalid or already-consumed/i,
    );
  });

  it("re-invite after a partner LEAVES works (old code was consumed on join)", async () => {
    const A = await member();
    const { pairId, sheetId, K } = await soloAccount(A);

    // First partner joins via a minted link, then leaves.
    const B = await member();
    await A.actor.issue_invite(pairId); // mint (openInvite does this)
    const code1 = (await A.actor.issue_invite(pairId)) as string; // fresh each open
    await B.actor.accept_invite(code1, [await rewrapFor(B, sheetId, K)], pubkeyOf(B));
    await B.actor.leave_pair(pairId);

    // Re-inviting a NEW partner must work — the previous flow trapped here.
    const code2 = (await A.actor.issue_invite(pairId)) as string;
    expect(code2).not.toBe(code1);
    const C = await member();
    await C.actor.accept_invite(code2, [await rewrapFor(C, sheetId, K)], pubkeyOf(C));
    const wkC = optVal(await C.actor.get_sheet_wrapped_key(sheetId));
    const KC = await unwrapSheetKey(u8(wkC!), C.kp.privateKey, C.kp.publicKey);
    expect(Array.from(KC)).toEqual(Array.from(K)); // C reads the shared sheet
  });

  it("legacy 'joined but not granted' pair self-heals via a fresh link (re-seal)", async () => {
    const A = await member();
    const { pairId, sheetId, K } = await soloAccount(A);

    // Reproduce the broken state: B accepts with NO rewrap → becomes members[1] but
    // keyless (this is what the old join_pair-without-grant left behind).
    const B = await member();
    const code1 = (await A.actor.issue_invite(pairId)) as string;
    await B.actor.accept_invite(code1, [], pubkeyOf(B));
    expect(optVal(await B.actor.get_sheet_wrapped_key(sheetId))).toBeNull(); // "no wrapped key"

    // The creator re-shares access; B re-accepts the fresh link and now their key is sealed.
    const code2 = (await A.actor.issue_invite(pairId)) as string;
    await B.actor.accept_invite(code2, [await rewrapFor(B, sheetId, K)], pubkeyOf(B));
    const wkB = optVal(await B.actor.get_sheet_wrapped_key(sheetId));
    expect(wkB).toBeTruthy();
    const KB = await unwrapSheetKey(u8(wkB!), B.kp.privateKey, B.kp.publicKey);
    expect(Array.from(KB)).toEqual(Array.from(K)); // repaired: B now reads K
  });

  it("a stranger cannot take a FILLED slot even with a fresh code", async () => {
    const A = await member();
    const { pairId, sheetId, K } = await soloAccount(A);
    const B = await member();
    await B.actor.accept_invite(
      (await A.actor.issue_invite(pairId)) as string,
      [await rewrapFor(B, sheetId, K)],
      pubkeyOf(B),
    );
    // Slot is filled by B. A fresh code + a stranger D must be rejected.
    const D = await member();
    await expect(
      D.actor.accept_invite((await A.actor.issue_invite(pairId)) as string, [], pubkeyOf(D)),
    ).rejects.toThrow(/already has a partner/i);
  });

  // E2: the creator cannot accept their OWN invite code.
  it("the creator cannot accept their own invite code", async () => {
    const A = await member();
    const { pairId } = await soloAccount(A);
    const code = (await A.actor.issue_invite(pairId)) as string;
    await expect(A.actor.accept_invite(code, [], pubkeyOf(A))).rejects.toThrow(
      /creator cannot accept their own invite/i,
    );
  });

  // E3: accept_invite is refused while the pair is archived.
  it("accept_invite is refused while the pair is archived", async () => {
    const A = await member();
    const { pairId } = await soloAccount(A);
    const code = (await A.actor.issue_invite(pairId)) as string;
    await A.actor.archive_pair(pairId);
    const B = await member();
    await expect(B.actor.accept_invite(code, [], pubkeyOf(B))).rejects.toThrow(/pair is archived/i);
  });

  // E4: issue_invite is refused while the pair is archived.
  it("issue_invite is refused while the pair is archived", async () => {
    const A = await member();
    const { pairId } = await soloAccount(A);
    await A.actor.archive_pair(pairId);
    await expect(A.actor.issue_invite(pairId)).rejects.toThrow(/pair is archived/i);
  });

  // E6: a SOLO account cannot be left (it must be deleted instead).
  it("leave_pair is refused on a solo account (delete it instead)", async () => {
    const A = await member();
    const { pairId } = await soloAccount(A);
    await expect(A.actor.leave_pair(pairId)).rejects.toThrow(/cannot leave a solo account/i);
  });

  // E1: after the CREATOR leaves, the promoted member can re-invite; the new partner joins + reads K.
  it("a promoted member (creator left) can re-invite; the new partner joins and reads K", async () => {
    const A = await member();
    const { pairId, sheetId, K } = await soloAccount(A);
    const B = await member();
    await B.actor.accept_invite(
      (await A.actor.issue_invite(pairId)) as string,
      [await rewrapFor(B, sheetId, K)],
      pubkeyOf(B),
    );
    await A.actor.leave_pair(pairId); // A (member_a) leaves → B promoted to slot 0
    const pairB = optVal(await B.actor.get_pair(pairId)) as { members: { toText?: () => string }[] };
    const m0 = pairB.members[0];
    expect(typeof m0.toText === "function" ? m0.toText() : String(m0)).toBe(B.principal);

    const C = await member();
    await C.actor.accept_invite(
      (await B.actor.issue_invite(pairId)) as string, // the PROMOTED member issues it
      [await rewrapFor(C, sheetId, K)],
      pubkeyOf(C),
    );
    const KC = await unwrapSheetKey(
      u8(optVal(await C.actor.get_sheet_wrapped_key(sheetId))!),
      C.kp.privateKey,
      C.kp.publicKey,
    );
    expect(Array.from(KC)).toEqual(Array.from(K));
  });

  // E5: accept_invite seals ONLY the sheets in the rewrap batch; sheets not in it stay unreadable.
  it("accept_invite seals only the rewrapped sheets; others stay anonymous to the joiner", async () => {
    const A = await member();
    const pairId = (await A.actor.create_pair()).pair_id as string;
    // One active sheet per pair → make the 'other' sheet, close it, then the 'target' active sheet.
    const mkSheet = async (K: Uint8Array) =>
      (
        await A.actor.create_sheet({
          pair_id: pairId,
          closing_window_days: 30,
          wrapped_key_a: Array.from(await wrapSheetKey(K, A.kp.publicKey, A.kp.privateKey)),
          wrapped_key_b: [],
          name_enc: [],
          name_iv: [],
        })
      ).id as string;
    const Ko = newSheetKey();
    const other = await mkSheet(Ko);
    await A.actor.close_sheet_encrypted(other, {
      entry_key: new Uint8Array(32),
      ciphertext: new Uint8Array(16),
      iv: new Uint8Array(12),
    });
    const Kt = newSheetKey();
    const target = await mkSheet(Kt);

    const B = await member();
    await B.actor.accept_invite(
      (await A.actor.issue_invite(pairId)) as string,
      [await rewrapFor(B, target, Kt)], // rewrap the TARGET only
      pubkeyOf(B),
    );
    // B reads the rewrapped target…
    const KtB = await unwrapSheetKey(
      u8(optVal(await B.actor.get_sheet_wrapped_key(target))!),
      B.kp.privateKey,
      B.kp.publicKey,
    );
    expect(Array.from(KtB)).toEqual(Array.from(Kt));
    // …but the sheet NOT in the batch stays anonymous to B.
    expect(optVal(await B.actor.get_sheet_wrapped_key(other))).toBeNull();
  });

  // E8: re-key continuity — an entry the departed partner wrote still decrypts for the replacement.
  it("re-key continuity: an entry the departed partner wrote still decrypts for the replacement", async () => {
    const A = await member();
    const { pairId, sheetId, K } = await soloAccount(A);
    const B = await member();
    await B.actor.accept_invite(
      (await A.actor.issue_invite(pairId)) as string,
      [await rewrapFor(B, sheetId, K)],
      pubkeyOf(B),
    );
    const payload: EntryPayload = {
      ts: Date.UTC(2026, 6, 1),
      kind: "expense",
      currency: "USD",
      amount_minor: 1500,
      direction: "credit",
      note: "B before leaving",
      txn_type: "iou",
    };
    const enc = await encryptEntryPayload(encodeEntry(payload), K);
    const entry = await B.actor.add_entry({
      sheet_id: sheetId,
      entry_key: Array.from(enc.entryKey),
      ciphertext: Array.from(enc.ciphertext),
      iv: Array.from(enc.iv),
    });
    await B.actor.leave_pair(pairId);

    // Replacement C joins via a fresh invite (K unchanged — leave_pair doesn't rotate it).
    const C = await member();
    await C.actor.accept_invite(
      (await A.actor.issue_invite(pairId)) as string,
      [await rewrapFor(C, sheetId, K)],
      pubkeyOf(C),
    );
    const KC = await unwrapSheetKey(
      u8(optVal(await C.actor.get_sheet_wrapped_key(sheetId))!),
      C.kp.privateKey,
      C.kp.publicKey,
    );
    const listed = await C.actor.list_entries(sheetId, [], 100);
    const mine = listed.entries.find((e: { id: bigint }) => e.id === entry.id);
    expect(mine).toBeDefined();
    const decoded = decodeEntry(
      await decryptEntryPayload(u8(mine.entry_key), u8(mine.iv), u8(mine.ciphertext), KC),
    );
    expect(decoded).toEqual(payload); // B's pre-departure entry, readable by C
  });
});
