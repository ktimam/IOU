// IOU invite-link auto-join + account-lifecycle E2E against the LIVE replica.
//
// Proves the v1.10.0 membership model end to end with two identities:
//   • accept_invite: the invitee self-joins AND seals K_sheet to itself in one
//     message — NO creator grant. Afterward they read/decrypt the shared sheet.
//   • delete_pair guards: refused while 2 members, refused until archived.
//   • archive_pair / unarchive_pair flip the account-level flag (visible in
//     get_my_pairs.archived_at).
//   • leave_pair: the partner leaves → locked out; the creator retains the
//     account solo.
//   • delete_pair: a solo, archived account is erased (pair + sheets gone).
//
// The suite skips cleanly when the local replica is down (see env.ts).

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

function u8(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

type Member = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actor: any;
  principal: string;
  kp: { publicKey: CryptoKey; privateKey: CryptoKey; publicKeyB64: string };
};

describeE2E("IOU invite-link auto-join + lifecycle E2E", () => {
  let A: Member; // creator
  let B: Member; // invitee
  let pairId: string;
  let inviteCode: string;
  let sheetId: string;
  let K: Uint8Array;

  beforeAll(async () => {
    const aId = freshIdentity();
    const bId = freshIdentity();
    const aKp = await deriveUserKeypair(aId.getPrincipal().toText());
    const bKp = await deriveUserKeypair(bId.getPrincipal().toText());
    A = { actor: await iouActor(aId), principal: aId.getPrincipal().toText(), kp: aKp };
    B = { actor: await iouActor(bId), principal: bId.getPrincipal().toText(), kp: bKp };

    // A creates a SOLO account + its first sheet (member_b anonymous). The sheet
    // key is self-wrapped under A's own keypair; member_b's slot stays empty.
    const cp = await A.actor.create_pair();
    pairId = cp.pair_id;
    inviteCode = cp.invite_code;
    K = newSheetKey();
    const wrapA = await wrapSheetKey(K, aKp.publicKey, aKp.privateKey);
    const sheet = await A.actor.create_sheet({
      pair_id: pairId,
      enabled_currencies: ["USD"],
      closing_window_days: 30,
      wrapped_key_a: Array.from(wrapA),
      wrapped_key_b: [], // solo placeholder
      name_enc: [],
      name_iv: [],
    });
    sheetId = sheet.id;
  });

  it("B accepts the invite and is IMMEDIATELY in — no grant call", async () => {
    // B self-wraps K (from the invite link's fragment) under B's own key and
    // hands the opaque blob to accept_invite — exactly what AcceptInvitePage does.
    const selfWrapB = await wrapSheetKey(K, B.kp.publicKey, B.kp.privateKey);
    const pubkey = Array.from(new TextEncoder().encode(B.kp.publicKeyB64));
    const updated = await B.actor.accept_invite(
      inviteCode,
      [{ sheet_id: sheetId, wrapped_key_for_partner: Array.from(selfWrapB) }],
      pubkey,
    );
    // members[1] is now B.
    const m1 = updated.members[1];
    expect(typeof m1.toText === "function" ? m1.toText() : String(m1)).toBe(B.principal);

    // B reads its wrapped copy and recovers the SAME K — with no grant step.
    const wkB = optVal(await B.actor.get_sheet_wrapped_key(sheetId));
    expect(wkB).toBeTruthy();
    const KB = await unwrapSheetKey(u8(wkB!), B.kp.privateKey, B.kp.publicKey); // self-unwrap
    expect(Array.from(KB)).toEqual(Array.from(K));
  });

  it("the invite is single-use — a second accept is rejected", async () => {
    const cId = freshIdentity();
    const cActor = await iouActor(cId);
    const cKp = await deriveUserKeypair(cId.getPrincipal().toText());
    const pubkey = Array.from(new TextEncoder().encode(cKp.publicKeyB64));
    await expect(cActor.accept_invite(inviteCode, [], pubkey)).rejects.toBeTruthy();
  });

  it("both members read/write the shared sheet (B writes, A reads)", async () => {
    const payload: EntryPayload = {
      ts: Date.UTC(2026, 6, 1),
      kind: "expense",
      currency: "USD",
      amount_minor: 2500,
      direction: "credit",
      note: "B's entry",
      txn_type: "iou",
    };
    const enc = await encryptEntryPayload(encodeEntry(payload), K);
    const entry = await B.actor.add_entry({
      sheet_id: sheetId,
      entry_key: Array.from(enc.entryKey),
      ciphertext: Array.from(enc.ciphertext),
      iv: Array.from(enc.iv),
    });
    // A recovers K from ITS self-wrapped copy and decrypts B's entry.
    const wkA = optVal(await A.actor.get_sheet_wrapped_key(sheetId));
    const KA = await unwrapSheetKey(u8(wkA!), A.kp.privateKey, A.kp.publicKey);
    const listed = await A.actor.list_entries(sheetId, [], 100);
    const mine = listed.entries.find((e: { id: bigint }) => e.id === entry.id);
    expect(mine).toBeDefined();
    const decoded = decodeEntry(
      await decryptEntryPayload(u8(mine.entry_key), u8(mine.iv), u8(mine.ciphertext), KA),
    );
    expect(decoded).toEqual(payload);
  });

  it("delete is refused while the account still has two members", async () => {
    await expect(A.actor.delete_pair(pairId)).rejects.toBeTruthy();
  });

  it("archive flips archived_at (visible in get_my_pairs); unarchive clears it", async () => {
    await A.actor.archive_pair(pairId);
    let mine = ((await A.actor.get_my_pairs()) as any[]).find((s) => s.id === pairId);
    expect(mine).toBeDefined();
    expect(optVal(mine.archived_at)).toBeTruthy(); // set

    // still can't delete — two members, even archived.
    await expect(A.actor.delete_pair(pairId)).rejects.toBeTruthy();

    await A.actor.unarchive_pair(pairId);
    mine = ((await A.actor.get_my_pairs()) as any[]).find((s) => s.id === pairId);
    expect(optVal(mine.archived_at)).toBeNull(); // cleared
  });

  it("B leaves → B is locked out; A retains the account solo", async () => {
    await B.actor.leave_pair(pairId);
    // B no longer sees the pair, and its sheet key is gone.
    expect(optVal(await B.actor.get_pair(pairId))).toBeNull();
    expect(optVal(await B.actor.get_sheet_wrapped_key(sheetId))).toBeNull();
    expect(((await B.actor.get_my_pairs()) as any[]).some((s) => s.id === pairId)).toBe(false);
    // A still owns it, now solo (members[1] anonymous), and still reads K.
    const pairA = optVal(await A.actor.get_pair(pairId));
    expect(pairA).toBeTruthy();
    const wkA = optVal(await A.actor.get_sheet_wrapped_key(sheetId));
    const KA = await unwrapSheetKey(u8(wkA!), A.kp.privateKey, A.kp.publicKey);
    expect(Array.from(KA)).toEqual(Array.from(K));
  });

  it("delete is refused until the solo account is archived, then erases it", async () => {
    // solo but not archived → refused.
    await expect(A.actor.delete_pair(pairId)).rejects.toBeTruthy();
    // archive, then delete succeeds and the pair + its sheet are gone.
    await A.actor.archive_pair(pairId);
    await A.actor.delete_pair(pairId);
    expect(optVal(await A.actor.get_pair(pairId))).toBeNull();
    expect(((await A.actor.get_my_pairs()) as any[]).some((s) => s.id === pairId)).toBe(false);
    expect(optVal(await A.actor.get_sheet_wrapped_key(sheetId))).toBeNull();
  });
});
