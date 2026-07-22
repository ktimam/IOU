// E2E for SHARED transaction types per account + cross-member dismissals.
//
// The design under test (v2): types are ALWAYS shared to the account — each
// member's encrypted slot on the Pair (templates_a_* / templates_b_*,
// sealed under the active sheet's K_sheet via set_pair_templates) is a
// MIRROR of their personal template list, computed by the pure
// reconcileSlot and published only on drift. The encoded blob is a
// versioned v2 envelope {v:2, templates, dismissed} — `dismissed` carries
// the OpenChat messageIds of "✕ dismissed" pending cards so a dismissal
// syncs to ALL members; legacy v1 bare-array blobs still decode. Both
// members read BOTH slots through the existing get_pair and merge
// client-side (src/features/templates/pairTemplates.ts). The canister is
// untouched: the blob stays opaque bytes under the same 64 000-byte guard.
//
// The headline case: A SAVES a personal "Reservation" type (no share
// action exists); the mirror publishes it; B — using only B's OWN identity
// and B's OWN wrapped sheet key (never A's self-derived user key) — sees
// it. Runs against the LIVE local replica (:8080); skips cleanly when it's
// down (env.ts).

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
  type PairSlotPayload,
  DISMISSED_CAP,
  encodePairSlot,
  decodePairSlot,
  mergePairTemplates,
  mergeDismissed,
  reconcileSlot,
  visibleTemplates,
  nextRev,
} from "../../src/features/templates/pairTemplates";
import type { TxnTemplate } from "../../src/features/templates/TemplatesContext";
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

/** Encrypt + publish a member's slot (v2 payload) under K_sheet. */
async function publishSlot(
  m: Awaited<ReturnType<typeof member>>,
  pairId: string,
  K: Uint8Array,
  slot: SharedTemplate[],
  dismissed: string[] = [],
) {
  const { iv, ciphertext } = await encryptWithSheetKey(K, encodePairSlot(slot, dismissed));
  await m.actor.set_pair_templates(pairId, Array.from(ciphertext), Array.from(iv));
}

/** Decrypt one slot pair (enc/iv opt fields off a fetched Pair) with K. */
async function readSlot(
  K: Uint8Array,
  enc: [] | [Uint8Array | number[]],
  iv: [] | [Uint8Array | number[]],
): Promise<PairSlotPayload> {
  const e = optVal(enc);
  const i = optVal(iv);
  if (!e || !i) return { templates: [], dismissed: [] };
  return decodePairSlot(await decryptWithSheetKey(K, u8(i), u8(e)));
}

/** Both decrypted slots of a pair, as seen by whichever member fetched it. */
async function readPairSlots(
  m: Awaited<ReturnType<typeof member>>,
  pairId: string,
  K: Uint8Array,
): Promise<{ a: PairSlotPayload; b: PairSlotPayload }> {
  const pair = optVal(await m.actor.get_pair(pairId)) as any;
  expect(pair).toBeTruthy();
  return {
    a: await readSlot(K, pair.templates_a_enc, pair.templates_a_iv),
    b: await readSlot(K, pair.templates_b_enc, pair.templates_b_iv),
  };
}

// The PERSONAL template (no rev/updatedAt bookkeeping — that's the mirror's
// job) and its published envelope shape.
const reservationPersonal: TxnTemplate = {
  id: "resv-1",
  name: "Reservation",
  direction: "credit",
  txn_type: "iou",
  currency: "EGP",
  fee_percent: 20,
  fee_fixed_minor: 100_000, // 1000 EGP
  keywords: ["reservation", "deposit"],
};

const reservation: SharedTemplate = {
  ...reservationPersonal,
  rev: 1,
  updatedAt: Date.now(),
};

describeE2E("IOU shared transaction types per account (pair template slots)", () => {
  // The headline path under MIRROR semantics: saving a personal type IS the
  // share — A's reconcile publishes it; B sees it with B's own key.
  it("mirror: A saves a personal type; the reconciled slot publishes; B decrypts it via get_pair + B's OWN wrapped K_sheet", async () => {
    const { A, B, pairId, sheetId, K } = await pairedAccount();

    // What the reconcile effect does after addTemplate: personal vs empty slot.
    const slot = reconcileSlot([reservationPersonal], [], [], Date.now());
    expect(slot).not.toBeNull(); // drift: brand-new type
    expect(slot![0].rev).toBe(1);
    await publishSlot(A, pairId, K, slot!);

    // B's view: B's own identity, B's own wrapped key — never A's user key.
    const K_B = await unwrapSheetKey(
      u8(optVal(await B.actor.get_sheet_wrapped_key(sheetId))!),
      B.kp.privateKey,
      B.kp.publicKey,
    );
    const { a, b } = await readPairSlots(B, pairId, K_B);
    const shared = visibleTemplates(mergePairTemplates(a.templates, b.templates));

    expect(shared).toHaveLength(1);
    expect(shared[0].name).toBe("Reservation");
    expect(shared[0].fee_percent).toBe(20);
    expect(shared[0].fee_fixed_minor).toBe(100_000);
    expect(shared[0].keywords).toEqual(["reservation", "deposit"]);

    // And a second reconcile pass against the published slot is a NO-OP —
    // the mirror only publishes on real drift (no publish loop).
    expect(reconcileSlot([reservationPersonal], slot!, slot!, Date.now())).toBeNull();
  });

  it("mirror: deleting the personal type publishes a slot WITHOUT it (absence, not tombstone) — it disappears for both members", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    const slot = reconcileSlot([reservationPersonal], [], [], Date.now())!;
    await publishSlot(A, pairId, K, slot);

    // A deletes the personal type → the mirror reconciles to an EMPTY slot.
    const next = reconcileSlot([], slot, slot, Date.now());
    expect(next).toEqual([]); // drop, no deleted:true envelope
    await publishSlot(A, pairId, K, next!);

    const { a, b } = await readPairSlots(B, pairId, K);
    expect(a.templates).toEqual([]); // truly absent — not a tombstone
    expect(visibleTemplates(mergePairTemplates(a.templates, b.templates))).toEqual([]);
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
    const a = await readSlot(K, pair.templates_a_enc, pair.templates_a_iv);
    const b = await readSlot(K, pair.templates_b_enc, pair.templates_b_iv);
    const names = visibleTemplates(mergePairTemplates(a.templates, b.templates)).map(
      (t) => t.name,
    );
    expect(names).toEqual(["Rent", "Reservation"]);
  });

  it("mirror copy-on-write: B's personal copy (same id) overrides A's type; deleting B's copy resurfaces A's original", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, reconcileSlot([reservationPersonal], [], [], Date.now())!);
    const aBytesBefore = optVal((optVal(await A.actor.get_pair(pairId)) as any).templates_a_enc)!;

    // B "edits a copy": the edited copy joins B's PERSONAL list under the
    // SAME id; B's mirror publishes it as a same-id override at nextRev.
    const slots0 = await readPairSlots(B, pairId, K);
    const merged0 = mergePairTemplates(slots0.a.templates, slots0.b.templates);
    const personalCopy: TxnTemplate = {
      ...reservationPersonal,
      name: "Reservation (25%)",
      fee_percent: 25,
    };
    const bSlot = reconcileSlot([personalCopy], slots0.b.templates, merged0, Date.now());
    expect(bSlot).not.toBeNull();
    expect(bSlot![0].rev).toBe(2); // above A's rev-1 original
    await publishSlot(B, pairId, K, bSlot!);

    const slots1 = await readPairSlots(A, pairId, K);
    const shared1 = visibleTemplates(mergePairTemplates(slots1.a.templates, slots1.b.templates));
    expect(shared1).toHaveLength(1);
    expect(shared1[0].name).toBe("Reservation (25%)");
    expect(shared1[0].rev).toBe(2);
    // A's slot bytes untouched by B's override
    expect(Array.from(u8(optVal((optVal(await A.actor.get_pair(pairId)) as any).templates_a_enc)!))).toEqual(
      Array.from(u8(aBytesBefore)),
    );

    // B deletes the personal copy → B's mirror DROPS the id → A's original
    // (still in A's untouched slot) resurfaces for both members.
    const merged1 = mergePairTemplates(slots1.a.templates, slots1.b.templates);
    const bSlot2 = reconcileSlot([], bSlot!, merged1, Date.now());
    expect(bSlot2).toEqual([]);
    await publishSlot(B, pairId, K, bSlot2!);

    const slots2 = await readPairSlots(A, pairId, K);
    const shared2 = visibleTemplates(mergePairTemplates(slots2.a.templates, slots2.b.templates));
    expect(shared2).toHaveLength(1);
    expect(shared2[0].name).toBe("Reservation");
    expect(shared2[0].rev).toBe(1);
  });

  it("legacy tombstone interop: an old-client deleted:true envelope still hides the type and keeps rev bookkeeping", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    await publishSlot(A, pairId, K, [reservation]);
    // An OLD client's unshare wrote a tombstone into B's slot. New clients
    // never write these, but must still honor them in the merge.
    await publishSlot(B, pairId, K, [
      { ...reservation, rev: 2, updatedAt: Date.now(), deleted: true },
    ]);
    const { a, b } = await readPairSlots(A, pairId, K);
    const merged = mergePairTemplates(a.templates, b.templates);
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
    const a = await readSlot(K, pair.templates_a_enc, pair.templates_a_iv);
    const shared = visibleTemplates(mergePairTemplates(a.templates, []));
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

  it("size guards: empty enc, >64000-byte enc and out-of-range iv all trap; a FULL v2 payload (templates + capped dismissed) fits comfortably", async () => {
    const A = await member();
    const { pairId, K } = await soloAccount(A);
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

    // Worst-case-ish v2 payload: 20 rich templates + DISMISSED_CAP ids at
    // OpenChat's maximum messageId width (u128 → 39 digits). Must encode
    // well under the 64 000-byte guard AND publish + round-trip intact.
    const bigTemplates = Array.from({ length: 20 }, (_, i) => ({
      ...reservation,
      id: `resv-${i}`,
      name: `Reservation flavour number ${i} with a longish name`,
      keywords: ["reservation", "deposit", "booking", `flavour-${i}`],
    }));
    const maxId = "340282366920938463463374607431768211455"; // 2^128 - 1
    const fullDismissed = Array.from(
      { length: DISMISSED_CAP },
      (_, i) => `${maxId.slice(String(i).length)}${i}`,
    );
    expect(encodePairSlot(bigTemplates, fullDismissed).length).toBeLessThan(40_000);
    await publishSlot(A, pairId, K, bigTemplates, fullDismissed);
    const pair = optVal(await A.actor.get_pair(pairId)) as any;
    const a = await readSlot(K, pair.templates_a_enc, pair.templates_a_iv);
    expect(a.templates).toHaveLength(20);
    expect(a.dismissed).toHaveLength(DISMISSED_CAP);
  });

  it("K_sheet rotation: the closer re-seals their OWN slot — the FULL v2 payload (templates + dismissed) survives; the stale partner slot degrades then self-heals", async () => {
    const { A, B, pairId, sheetId, K } = await pairedAccount();
    const bTemplate: SharedTemplate = {
      id: "rent-1",
      name: "Rent",
      direction: "debt",
      txn_type: "iou",
      rev: 1,
      updatedAt: Date.now(),
    };
    await publishSlot(A, pairId, K, [reservation], ["msg-11", "msg-22"]);
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

    // Under the NEW key: A's slot decrypts — templates AND dismissed intact
    // (the rotation re-seals the plaintext verbatim, so the v2 envelope
    // survives byte-identically); B's stale slot fails AES-GCM …
    const pair = optVal(await B.actor.get_pair(pairId)) as any;
    const a = await readSlot(K2, pair.templates_a_enc, pair.templates_a_iv);
    expect(a.templates.map((t) => t.name)).toEqual(["Reservation"]);
    expect(a.dismissed).toEqual(["msg-11", "msg-22"]);
    await expect(
      decryptWithSheetKey(
        K2,
        u8(optVal(pair.templates_b_iv)!),
        u8(optVal(pair.templates_b_enc)!),
      ),
    ).rejects.toThrow();
    // … so the loader degrades to the decryptable slot only (no throw).
    expect(
      visibleTemplates(mergePairTemplates(a.templates, [])).map((t) => t.name),
    ).toEqual(["Reservation"]);

    // Self-heal: B republishes under K2 → both types visible again.
    await publishSlot(B, pairId, K2, [bTemplate]);
    const { a: a2, b: b2 } = await readPairSlots(A, pairId, K2);
    const names = visibleTemplates(mergePairTemplates(a2.templates, b2.templates)).map(
      (t) => t.name,
    );
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

describeE2E("IOU cross-member dismissed pending cards (pair slot v2 payload)", () => {
  it("dismiss round-trip: A dismisses mid X; B (own agent + own wrapped key) reads the pair and the merged union contains X — and B's dismissal reaches A", async () => {
    const { A, B, pairId, sheetId, K } = await pairedAccount();
    const X = "123456789012345678901234567890";

    // A's client: dismissCard appends X to A's slot and republishes.
    await publishSlot(A, pairId, K, [reservation], mergeDismissed([], [X]));

    // B's independent view — B's own actor and own wrapped sheet key.
    const K_B = await unwrapSheetKey(
      u8(optVal(await B.actor.get_sheet_wrapped_key(sheetId))!),
      B.kp.privateKey,
      B.kp.publicKey,
    );
    const slotsB = await readPairSlots(B, pairId, K_B);
    const unionAtB = mergeDismissed(slotsB.b.dismissed, slotsB.a.dismissed);
    expect(unionAtB).toContain(X);
    // …and B's own templates/dismissals are unaffected.
    expect(slotsB.b.dismissed).toEqual([]);

    // B dismisses Y into B's OWN slot; A now sees the union {X, Y}.
    const Y = "987654321098765432109876543210";
    await publishSlot(B, pairId, K_B, slotsB.b.templates, mergeDismissed(slotsB.b.dismissed, [Y]));
    const slotsA = await readPairSlots(A, pairId, K);
    const unionAtA = new Set(mergeDismissed(slotsA.a.dismissed, slotsA.b.dismissed));
    expect(unionAtA.has(X)).toBe(true);
    expect(unionAtA.has(Y)).toBe(true);
    // A's slot still only carries A's OWN dismissal (per-member slots).
    expect(slotsA.a.dismissed).toEqual([X]);
  });

  it(`cap enforcement: appending to a full ${DISMISSED_CAP}-id list drops the OLDEST on publish`, async () => {
    const { A, pairId, K } = await pairedAccount();
    const full = Array.from({ length: DISMISSED_CAP }, (_, i) => `d${i}`);
    await publishSlot(A, pairId, K, [], full);

    // The dismissCard path: read my slot, mergeDismissed in the new id, publish.
    const mine = (await readPairSlots(A, pairId, K)).a;
    expect(mine.dismissed).toHaveLength(DISMISSED_CAP);
    await publishSlot(A, pairId, K, mine.templates, mergeDismissed(mine.dismissed, ["fresh"]));

    const after = (await readPairSlots(A, pairId, K)).a;
    expect(after.dismissed).toHaveLength(DISMISSED_CAP); // capped, not grown
    expect(after.dismissed).not.toContain("d0"); // oldest pruned
    expect(after.dismissed[0]).toBe("d1");
    expect(after.dismissed[after.dismissed.length - 1]).toBe("fresh");
  });

  it("legacy-blob interop: a v1 BARE-ARRAY blob written directly still decodes through the new codec as {templates, dismissed: []}", async () => {
    const { A, B, pairId, K } = await pairedAccount();
    // Write EXACTLY what a v1 client wrote: JSON of a bare envelope array.
    const v1Bytes = new TextEncoder().encode(JSON.stringify([reservation]));
    const { iv, ciphertext } = await encryptWithSheetKey(K, v1Bytes);
    await A.actor.set_pair_templates(pairId, Array.from(ciphertext), Array.from(iv));

    const { a, b } = await readPairSlots(B, pairId, K);
    expect(a).toEqual({ templates: [reservation], dismissed: [] });
    const shared = visibleTemplates(mergePairTemplates(a.templates, b.templates));
    expect(shared.map((t) => t.name)).toEqual(["Reservation"]);
  });
});
