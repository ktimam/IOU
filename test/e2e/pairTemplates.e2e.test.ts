// E2E for SHARED transaction types per account (v1.12.0).
//
// The design under test: templates a member chooses to share live in
// per-member encrypted slots on the Pair (templates_a_* / templates_b_*),
// sealed under the active sheet's K_sheet via set_pair_templates; both
// members read BOTH slots through the existing get_pair and merge
// client-side (src/features/templates/pairTemplates.ts).
//
// The headline case is the exact reported gap: A publishes a "Reservation"
// type; B — using only B's OWN identity and B's OWN wrapped sheet key
// (never A's self-derived user key) — sees it. Runs against the LIVE local
// replica (:8080); skips cleanly when it's down (env.ts).

import { it, expect } from "vitest";
import { describeE2E, freshIdentity, iouActor, optVal } from "./env";
import {
  deriveUserKeypair,
  newSheetKey,
  wrapSheetKey,
  unwrapSheetKey,
  encryptWithSheetKey,
  decryptWithSheetKey,
} from "../../src/features/crypto/devVetkd";
import {
  type SharedTemplate,
  encodePairSlot,
  decodePairSlot,
  mergePairTemplates,
  visibleTemplates,
  nextRev,
  upsertSlot,
} from "../../src/features/templates/pairTemplates";
import { rotateMyPairTemplates } from "../../src/features/templates/pairTemplatesActor";

function u8(v: Uint8Array | number[]): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

async function member(id = freshIdentity()) {
  const kp = await deriveUserKeypair(id.getPrincipal().toText());
  return { actor: await iouActor(id), principal: id.getPrincipal().toText(), kp };
}

// A creates a solo account + one sheet; returns ids + the sheet key K.
async function soloAccount(A: Awaited<ReturnType<typeof member>>) {
  const cp = await A.actor.create_pair();
  const K = newSheetKey();
  const wrapA = await wrapSheetKey(K, A.kp.publicKey, A.kp.privateKey);
  const sheet = await A.actor.create_sheet({
    pair_id: cp.pair_id,
    enabled_currencies: ["EGP"],
    closing_window_days: 30,
    wrapped_key_a: Array.from(wrapA),
    wrapped_key_b: [],
    name_enc: [],
    name_iv: [],
  });
  return { pairId: cp.pair_id as string, sheetId: sheet.id as string, K };
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

/** A pair with two real members who both hold K (via their OWN wrapped slots). */
async function pairedAccount() {
  const A = await member();
  const { pairId, sheetId, K } = await soloAccount(A);
  const B = await member();
  await B.actor.accept_invite(
    (await A.actor.issue_invite(pairId)) as string,
    [await rewrapFor(B, sheetId, K)],
    pubkeyOf(B),
  );
  return { A, B, pairId, sheetId, K };
}

/** Encrypt + publish a member's slot under K_sheet. */
async function publishSlot(
  m: Awaited<ReturnType<typeof member>>,
  pairId: string,
  K: Uint8Array,
  slot: SharedTemplate[],
) {
  const { iv, ciphertext } = await encryptWithSheetKey(K, encodePairSlot(slot));
  await m.actor.set_pair_templates(pairId, Array.from(ciphertext), Array.from(iv));
}

/** Decrypt one slot pair (enc/iv opt fields off a fetched Pair) with K. */
async function readSlot(
  K: Uint8Array,
  enc: [] | [Uint8Array | number[]],
  iv: [] | [Uint8Array | number[]],
): Promise<SharedTemplate[]> {
  const e = optVal(enc);
  const i = optVal(iv);
  if (!e || !i) return [];
  return decodePairSlot(await decryptWithSheetKey(K, u8(i), u8(e)));
}

const reservation: SharedTemplate = {
  id: "resv-1",
  name: "Reservation",
  direction: "credit",
  txn_type: "iou",
  currency: "EGP",
  fee_percent: 20,
  fee_fixed_minor: 100_000, // 1000 EGP
  keywords: ["reservation", "deposit"],
  rev: 1,
  updatedAt: Date.now(),
};

describeE2E("IOU shared transaction types per account (pair template slots)", () => {
  // The LITERAL reported gap, now fixed: A publishes; B sees it with B's own key.
  it("A publishes 'Reservation'; B decrypts it via get_pair + B's OWN wrapped K_sheet and sees it merged", async () => {
    const { A, B, pairId, sheetId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, [reservation]);

    // B's view: B's own identity, B's own wrapped key — never A's user key.
    const K_B = await unwrapSheetKey(
      u8(optVal(await B.actor.get_sheet_wrapped_key(sheetId))!),
      B.kp.privateKey,
      B.kp.publicKey,
    );
    const pairB = optVal(await B.actor.get_pair(pairId)) as any;
    expect(pairB).toBeTruthy();
    const slotA = await readSlot(K_B, pairB.templates_a_enc, pairB.templates_a_iv);
    const slotB = await readSlot(K_B, pairB.templates_b_enc, pairB.templates_b_iv);
    const shared = visibleTemplates(mergePairTemplates(slotA, slotB));

    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe("Reservation");
    expect(shared[0].fee_percent).toBe(20);
    expect(shared[0].fee_fixed_minor).toBe(100_000);
    expect(shared[0].keywords).toEqual(["reservation", "deposit"]);
  });

  it("slot routing: B's publish fills the b-slot and leaves A's a-slot byte-identical", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, [reservation]);
    const before = optVal((optVal(await A.actor.get_pair(pairId)) as any).templates_a_enc)!;

    const bTemplate: SharedTemplate = {
      id: "rent-1",
      name: "Rent",
      direction: "debt",
      txn_type: "iou",
      rev: 1,
      updatedAt: Date.now(),
    };
    await publishSlot(B, pairId, K, [bTemplate]);

    const pair = optVal(await A.actor.get_pair(pairId)) as any;
    expect(optVal(pair.templates_b_enc)).toBeTruthy(); // B's write landed in b
    expect(Array.from(u8(optVal(pair.templates_a_enc)!))).toEqual(Array.from(u8(before))); // a untouched

    // and the merged view (either member) now shows BOTH types
    const slotA = await readSlot(K, pair.templates_a_enc, pair.templates_a_iv);
    const slotB = await readSlot(K, pair.templates_b_enc, pair.templates_b_iv);
    const names = visibleTemplates(mergePairTemplates(slotA, slotB)).map((t) => t.name);
    expect(names).toEqual(["Rent", "Reservation"]);
  });

  it("copy-on-write edit: B overrides A's template at rev+1 in B's OWN slot; both converge on B's version", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, [reservation]);
    const aBytesBefore = optVal((optVal(await A.actor.get_pair(pairId)) as any).templates_a_enc)!;

    // B edits A's "Reservation" — same id, next rev, into B's slot.
    const pair0 = optVal(await B.actor.get_pair(pairId)) as any;
    const merged0 = mergePairTemplates(
      await readSlot(K, pair0.templates_a_enc, pair0.templates_a_iv),
      await readSlot(K, pair0.templates_b_enc, pair0.templates_b_iv),
    );
    const override: SharedTemplate = {
      ...reservation,
      name: "Reservation (25%)",
      fee_percent: 25,
      rev: nextRev(merged0, reservation.id),
      updatedAt: Date.now(),
    };
    await publishSlot(B, pairId, K, upsertSlot([], override));

    const pair1 = optVal(await A.actor.get_pair(pairId)) as any;
    const shared = visibleTemplates(
      mergePairTemplates(
        await readSlot(K, pair1.templates_a_enc, pair1.templates_a_iv),
        await readSlot(K, pair1.templates_b_enc, pair1.templates_b_iv),
      ),
    );
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe("Reservation (25%)");
    expect(shared[0].rev).toBe(2);
    // A's slot bytes untouched by B's edit
    expect(Array.from(u8(optVal(pair1.templates_a_enc)!))).toEqual(
      Array.from(u8(aBytesBefore)),
    );
  });

  it("tombstone unshare: a rev+1 deleted envelope hides the type for both members", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, [reservation]);
    await publishSlot(B, pairId, K, [
      { ...reservation, rev: 2, updatedAt: Date.now(), deleted: true },
    ]);
    const pair = optVal(await A.actor.get_pair(pairId)) as any;
    const merged = mergePairTemplates(
      await readSlot(K, pair.templates_a_enc, pair.templates_a_iv),
      await readSlot(K, pair.templates_b_enc, pair.templates_b_iv),
    );
    expect(visibleTemplates(merged)).toEqual([]);
    // and the rev bookkeeping still sees the tombstone for resurrection
    expect(nextRev(merged, reservation.id)).toBe(3);
  });

  it("solo account: publish fills the a-slot only; merged view = slot A", async () => {
    const A = await member();
    const { pairId, K } = await soloAccount(A);
    await publishSlot(A, pairId, K, [reservation]);
    const pair = optVal(await A.actor.get_pair(pairId)) as any;
    expect(optVal(pair.templates_a_enc)).toBeTruthy();
    expect(optVal(pair.templates_b_enc)).toBeNull();
    const shared = visibleTemplates(
      mergePairTemplates(await readSlot(K, pair.templates_a_enc, pair.templates_a_iv), []),
    );
    expect(shared.map((t) => t.name)).toEqual(["Reservation"]);
  });

  it("privacy: a non-member can neither write a slot nor read the pair; stored bytes are ciphertext", async () => {
    const { A, pairId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, [reservation]);

    const D = await member(); // stranger
    const { iv, ciphertext } = await encryptWithSheetKey(K, encodePairSlot([reservation]));
    await expect(
      D.actor.set_pair_templates(pairId, Array.from(ciphertext), Array.from(iv)),
    ).rejects.toThrow(/not a member of this pair/i);
    expect(optVal(await D.actor.get_pair(pairId))).toBeNull(); // member gate holds

    // ciphertext-only at rest: the stored blob is NOT the plaintext JSON
    const stored = u8(optVal((optVal(await A.actor.get_pair(pairId)) as any).templates_a_enc)!);
    expect(Array.from(stored)).not.toEqual(Array.from(encodePairSlot([reservation])));
  });

  it("size guards: empty enc, >64000-byte enc and out-of-range iv all trap", async () => {
    const A = await member();
    const { pairId } = await soloAccount(A);
    const iv12 = Array.from({ length: 12 }, () => 0);
    await expect(A.actor.set_pair_templates(pairId, [], iv12)).rejects.toThrow(
      /templates ciphertext is empty/i,
    );
    await expect(
      A.actor.set_pair_templates(pairId, new Array(64_001).fill(0), iv12),
    ).rejects.toThrow(/templates blob too large/i);
    await expect(
      A.actor.set_pair_templates(pairId, [1, 2, 3], new Array(8).fill(0)),
    ).rejects.toThrow(/templates iv length out of range/i);
  });

  it("K_sheet rotation: the closer re-seals their OWN slot; the stale partner slot degrades then self-heals", async () => {
    const { A, B, pairId, sheetId, K } = await pairedAccount();
    const bTemplate: SharedTemplate = {
      id: "rent-1",
      name: "Rent",
      direction: "debt",
      txn_type: "iou",
      rev: 1,
      updatedAt: Date.now(),
    };
    await publishSlot(A, pairId, K, [reservation]);
    await publishSlot(B, pairId, K, [bTemplate]);

    // Rotate: close the sheet, start a new one under a fresh K2 (what
    // CloseSheetButton does), then run the production rotation helper for
    // A's own slot.
    await A.actor.close_sheet(sheetId, []);
    const K2 = newSheetKey();
    await A.actor.create_sheet({
      pair_id: pairId,
      enabled_currencies: ["EGP"],
      closing_window_days: 30,
      wrapped_key_a: Array.from(await wrapSheetKey(K2, A.kp.publicKey, A.kp.privateKey)),
      wrapped_key_b: Array.from(await wrapSheetKey(K2, B.kp.publicKey, B.kp.privateKey)),
      name_enc: [],
      name_iv: [],
    });
    await rotateMyPairTemplates(A.actor, A.principal, pairId, async () => K, K2);

    // Under the NEW key: A's slot decrypts, B's stale slot fails AES-GCM …
    const pair = optVal(await B.actor.get_pair(pairId)) as any;
    const slotA = await readSlot(K2, pair.templates_a_enc, pair.templates_a_iv);
    expect(slotA.map((t) => t.name)).toEqual(["Reservation"]);
    await expect(
      decryptWithSheetKey(
        K2,
        u8(optVal(pair.templates_b_iv)!),
        u8(optVal(pair.templates_b_enc)!),
      ),
    ).rejects.toThrow();
    // … so the loader degrades to the decryptable slot only (no throw).
    expect(
      visibleTemplates(mergePairTemplates(slotA, [])).map((t) => t.name),
    ).toEqual(["Reservation"]);

    // Self-heal: B republishes under K2 → both types visible again.
    await publishSlot(B, pairId, K2, [bTemplate]);
    const healed = optVal(await A.actor.get_pair(pairId)) as any;
    const names = visibleTemplates(
      mergePairTemplates(
        await readSlot(K2, healed.templates_a_enc, healed.templates_a_iv),
        await readSlot(K2, healed.templates_b_enc, healed.templates_b_iv),
      ),
    ).map((t) => t.name);
    expect(names).toEqual(["Rent", "Reservation"]);
  });

  it("regression: user-scoped set_user_templates still round-trips unchanged alongside the pair slots", async () => {
    const A = await member();
    const blob = Array.from(new TextEncoder().encode("personal-blob"));
    const iv = Array.from({ length: 12 }, (_, i) => i);
    await A.actor.set_user_templates(blob, iv);
    const user = optVal(await A.actor.get_my_user()) as any;
    expect(Array.from(u8(optVal(user.templates_enc)!))).toEqual(blob);
    expect(Array.from(u8(optVal(user.templates_iv)!))).toEqual(iv);
  });
});
