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
} from "../../src/features/crypto/devVetkd";

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
    enabled_currencies: ["USD"],
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
});
