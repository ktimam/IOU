// Leave-time key reads against the LIVE replica (P0-1 / P0-2). Complements inviteLifecycle.e2e
// (which covers "member_b leaves → member_a retains"). Here the CREATOR (member_a) leaves and the
// staying member is PROMOTED into slot 0 — leave_pair moves each sheet's wrapped_key_b into
// wrapped_key_a and anonymizes member_b. The promoted member must still recover K live:
//   • sheet the member SELF-wrapped at accept time  → recovered via self-unwrap.
//   • sheet the departing creator CROSS-wrapped (TAGGED) for them AFTER they joined → recovered via
//     the tagged fallback, using the sealer's pubkey pinned in the blob — even though the sealer
//     (and their slot) is now gone. This is the exact scenario the tagged cross-wrap fix protects.

import { it, expect, beforeAll } from "vitest";
import { Principal } from "@dfinity/principal";
import { describeE2E, freshIdentity, iouActor, optVal } from "./env";
import {
  deriveUserKeypair,
  newSheetKey,
  wrapSheetKey,
  wrapSheetKeyTagged,
  recoverSheetKey,
} from "../../src/features/crypto/devVetkd";

function u8(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

type Member = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  actor: any;
  principal: string;
  kp: { publicKey: CryptoKey; privateKey: CryptoKey; publicKeyB64: string };
};

describeE2E("Leave-time key reads — creator leaves, promoted member still reads (P0-1/P0-2)", () => {
  let A: Member; // creator (member_a) — will LEAVE
  let B: Member; // invitee — will be promoted
  let pairId: string;
  let sheet1: string; // B self-wrapped at accept
  let sheet2: string; // A cross-wrapped (tagged) FOR B after B joined
  let K1: Uint8Array;
  let K2: Uint8Array;

  beforeAll(async () => {
    const aId = freshIdentity();
    const bId = freshIdentity();
    A = { actor: await iouActor(aId), principal: aId.getPrincipal().toText(), kp: await deriveUserKeypair(aId.getPrincipal().toText()) };
    B = { actor: await iouActor(bId), principal: bId.getPrincipal().toText(), kp: await deriveUserKeypair(bId.getPrincipal().toText()) };

    // A creates a solo account + sheet1 (A self-wrap, member_b empty).
    const cp = await A.actor.create_pair();
    pairId = cp.pair_id;
    K1 = newSheetKey();
    const wrapA1 = await wrapSheetKey(K1, A.kp.publicKey, A.kp.privateKey);
    sheet1 = (await A.actor.create_sheet({
      pair_id: pairId, enabled_currencies: ["USD"], closing_window_days: 30,
      wrapped_key_a: Array.from(wrapA1), wrapped_key_b: [], name_enc: [], name_iv: [],
    })).id;

    // B accepts, self-wrapping sheet1's key under B's own key.
    const selfWrapB = await wrapSheetKey(K1, B.kp.publicKey, B.kp.privateKey);
    await B.actor.accept_invite(
      cp.invite_code,
      [{ sheet_id: sheet1, wrapped_key_for_partner: Array.from(selfWrapB) }],
      Array.from(new TextEncoder().encode(B.kp.publicKeyB64)),
    );

    // A pair allows only ONE active sheet, so rotate: close sheet1 (now archived but still readable),
    // then A creates sheet2 as the new active sheet. A can't self-wrap for B (no B private key), so
    // B's slot is a TAGGED cross-wrap embedding A's pubkey.
    await A.actor.close_sheet(sheet1, []);
    K2 = newSheetKey();
    const wrapA2 = await wrapSheetKey(K2, A.kp.publicKey, A.kp.privateKey);
    const crossB2 = await wrapSheetKeyTagged(K2, B.kp.publicKey, A.kp.privateKey, A.kp.publicKeyB64);
    sheet2 = (await A.actor.create_sheet({
      pair_id: pairId, enabled_currencies: ["USD"], closing_window_days: 30,
      wrapped_key_a: Array.from(wrapA2), wrapped_key_b: Array.from(crossB2), name_enc: [], name_iv: [],
    })).id;
  });

  it("before the leave: B reads both sheets (self-wrapped sheet1, tagged-cross-wrapped sheet2)", async () => {
    const KB1 = await recoverSheetKey(u8(optVal(await B.actor.get_sheet_wrapped_key(sheet1))!), B.kp);
    expect(Array.from(KB1)).toEqual(Array.from(K1));
    const KB2 = await recoverSheetKey(u8(optVal(await B.actor.get_sheet_wrapped_key(sheet2))!), B.kp);
    expect(Array.from(KB2)).toEqual(Array.from(K2));
  });

  it("the CREATOR (A) leaves → B is promoted to member_a on every sheet; A is locked out", async () => {
    await A.actor.leave_pair(pairId);
    // A is gone.
    expect(optVal(await A.actor.get_pair(pairId))).toBeNull();
    expect(optVal(await A.actor.get_sheet_wrapped_key(sheet1))).toBeNull();
    expect(optVal(await A.actor.get_sheet_wrapped_key(sheet2))).toBeNull();
    // B is promoted into slot 0.
    const pairB = optVal(await B.actor.get_pair(pairId)) as { members: unknown[] };
    expect(pairB).toBeTruthy();
    const m0 = pairB.members[0] as { toText?: () => string };
    expect(typeof m0.toText === "function" ? m0.toText() : String(m0)).toBe(B.principal);
  });

  it("P0-1: promoted B still recovers K1 from the self-wrapped slot moved into member_a", async () => {
    const KB1 = await recoverSheetKey(u8(optVal(await B.actor.get_sheet_wrapped_key(sheet1))!), B.kp);
    expect(Array.from(KB1)).toEqual(Array.from(K1));
  });

  it("P0-2: promoted B still recovers K2 from the TAGGED cross-wrap — the sealer (A) is gone but its pubkey is pinned in the blob", async () => {
    const blob = u8(optVal(await B.actor.get_sheet_wrapped_key(sheet2))!);
    const KB2 = await recoverSheetKey(blob, B.kp);
    expect(Array.from(KB2)).toEqual(Array.from(K2));
  });

  // E9 (P1): the promoted member's account summary reads as solo — partner anonymous, the active
  // sheet is the post-join sheet2, and it isn't archived.
  it("get_my_pairs shows the promoted member as solo (partner anonymous, active sheet2, not archived)", async () => {
    const s = ((await B.actor.get_my_pairs()) as any[]).find((x) => x.id === pairId);
    expect(s).toBeDefined();
    const op = s.other_principal;
    expect(typeof op.toText === "function" ? op.toText() : String(op)).toBe(Principal.anonymous().toText());
    expect(optVal(s.active_sheet_id)).toBe(sheet2);
    expect(optVal(s.archived_at)).toBeNull();
  });
});
