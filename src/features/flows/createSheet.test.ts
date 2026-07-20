// Unit tests for publishUsernameToAllPairs (createSheet.ts) — the eager global-username
// publish that makes "set your username once" reach every existing account. Uses the REAL
// crypto (newSheetKey / encryptName / decryptName) with a mocked backend actor + unwrapFor,
// so we assert the loop logic AND that each name is encrypted under that sheet's own key.

import { describe, it, expect, vi } from "vitest";
import { webcrypto } from "node:crypto";

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}
// devVetkd touches localStorage on some paths — shim it for the node env.
const _ls = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => { _ls.set(k, v); },
  removeItem: (k: string) => { _ls.delete(k); },
};

import { publishUsernameToAllPairs, createSheetForPair } from "./createSheet";
import {
  newSheetKey,
  decryptName,
  deriveUserKeypair,
  unwrapSheetKey,
  unwrapTaggedSheetKey,
  wrapSheetKeyTagged,
  recoverSheetKey,
} from "../crypto/devVetkd";

type Pair = { id: string; active_sheet_id?: [] | [string] };
type Call = { pairId: string; enc: number[]; iv: number[] };

function makeActor(pairs: Pair[]) {
  const calls: Call[] = [];
  return {
    calls,
    get_my_pairs: async () => pairs,
    set_member_name: async (pairId: string, enc: number[], iv: number[]) => {
      calls.push({ pairId, enc, iv });
    },
  };
}

describe("publishUsernameToAllPairs", () => {
  it("publishes the (trimmed) username to every pair with an active sheet, encrypted under that sheet's own key", async () => {
    const kA = newSheetKey();
    const kB = newSheetKey();
    const keys: Record<string, Uint8Array> = { sheetA: kA, sheetB: kB };
    const unwrapFor = vi.fn(async (id: string) => keys[id]);
    const actor = makeActor([
      { id: "pairA", active_sheet_id: ["sheetA"] },
      { id: "pairB", active_sheet_id: ["sheetB"] },
    ]);

    const res = await publishUsernameToAllPairs(actor, unwrapFor, "  manager  ");

    expect(res).toEqual({ published: 2, total: 2 });
    expect(actor.calls.map((c) => c.pairId).sort()).toEqual(["pairA", "pairB"]);
    expect(unwrapFor).toHaveBeenCalledWith("sheetA");
    expect(unwrapFor).toHaveBeenCalledWith("sheetB");

    // Each entry decrypts to the TRIMMED name under THAT pair's sheet key, and the
    // stored ciphertext never contains the plaintext.
    for (const c of actor.calls) {
      const k = c.pairId === "pairA" ? kA : kB;
      const back = await decryptName(k, new Uint8Array(c.iv), new Uint8Array(c.enc));
      expect(back).toBe("manager");
      expect(new TextDecoder().decode(new Uint8Array(c.enc))).not.toContain("manager");
      // it must NOT decrypt under the OTHER sheet's key (per-sheet isolation)
      const wrong = c.pairId === "pairA" ? kB : kA;
      expect(await decryptName(wrong, new Uint8Array(c.iv), new Uint8Array(c.enc))).toBe("");
    }
  });

  it("skips a pair with no active sheet (opt = []) — no unwrap, no publish for it", async () => {
    const unwrapFor = vi.fn(async () => newSheetKey());
    const actor = makeActor([
      { id: "pairA", active_sheet_id: ["sheetA"] },
      { id: "pairB", active_sheet_id: [] },
      { id: "pairC" }, // active_sheet_id absent entirely
    ]);

    const res = await publishUsernameToAllPairs(actor, unwrapFor, "manager");

    expect(res).toEqual({ published: 1, total: 3 });
    expect(actor.calls.map((c) => c.pairId)).toEqual(["pairA"]);
    expect(unwrapFor).toHaveBeenCalledTimes(1);
  });

  it("empty / whitespace-only username publishes nothing but still reports the pair total", async () => {
    const unwrapFor = vi.fn(async () => newSheetKey());
    const actor = makeActor([{ id: "pairA", active_sheet_id: ["sheetA"] }]);

    for (const name of ["", "   ", "\t\n"]) {
      actor.calls.length = 0;
      const res = await publishUsernameToAllPairs(actor, unwrapFor, name);
      expect(res).toEqual({ published: 0, total: 1 });
      expect(actor.calls).toHaveLength(0);
    }
    expect(unwrapFor).not.toHaveBeenCalled(); // returns before unwrapping
  });

  it("is best-effort: a pair whose key can't be unwrapped is skipped, the rest still publish", async () => {
    const kA = newSheetKey();
    const kC = newSheetKey();
    const unwrapFor = vi.fn(async (id: string) => {
      if (id === "sheetB") throw new Error("no key on this device");
      return id === "sheetA" ? kA : kC;
    });
    const actor = makeActor([
      { id: "pairA", active_sheet_id: ["sheetA"] },
      { id: "pairB", active_sheet_id: ["sheetB"] }, // unwrap throws → skipped
      { id: "pairC", active_sheet_id: ["sheetC"] },
    ]);

    const res = await publishUsernameToAllPairs(actor, unwrapFor, "manager");

    expect(res).toEqual({ published: 2, total: 3 });
    expect(actor.calls.map((c) => c.pairId).sort()).toEqual(["pairA", "pairC"]);
  });

  it("no pairs at all → published 0 / total 0, nothing unwrapped or published", async () => {
    const unwrapFor = vi.fn(async () => newSheetKey());
    const actor = makeActor([]);

    const res = await publishUsernameToAllPairs(actor, unwrapFor, "manager");

    expect(res).toEqual({ published: 0, total: 0 });
    expect(unwrapFor).not.toHaveBeenCalled();
    expect(actor.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: the "partner locked out of sheets created after they join" blocker.
// createSheetForPair must seal member_b's slot so the PARTNER can read it. A
// self-wrap under the creator's OWN key would lock the partner out (they don't
// hold the creator's private key). Dev/P-256 path; mock actor + real crypto.
// ─────────────────────────────────────────────────────────────────────────────

const A_PRINCIPAL = "aaaaa-aa"; // member_a / creator
const B_PRINCIPAL = "bbbbb-bb"; // member_b / partner

function principalLike(text: string) {
  return { toText: () => text };
}

/** Mock IOU actor with an in-memory PARTNER_PUBKEYS map + captured create_sheet req.
 *  `self` is the principal register_sheet_pubkey attributes the registration to (the
 *  caller creating the sheet — A by default; pass B for the partner-creates case). */
function makeSheetActor(registered: Record<string, number[]>, self: string = A_PRINCIPAL) {
  const pubkeys: Record<string, number[]> = { ...registered };
  const captured: { req?: any } = {};
  const actor = {
    get_pair: async (id: string) => [
      { id, members: [principalLike(A_PRINCIPAL), principalLike(B_PRINCIPAL)] },
    ],
    get_sheet_pubkey: async (p: any) => {
      const key = typeof p?.toText === "function" ? p.toText() : String(p);
      return pubkeys[key] ? [pubkeys[key]] : [];
    },
    register_sheet_pubkey: async (bytes: number[]) => {
      pubkeys[self] = bytes;
    },
    create_sheet: async (req: any) => {
      captured.req = req;
      return { id: "sheet-post-join", ...req };
    },
  };
  return { actor, captured, pubkeys };
}

describe("createSheetForPair — partner can read a sheet created after they join", () => {
  it("cross-wraps member_b's slot under B's registered pubkey (not a self-wrap)", async () => {
    const aKp = await deriveUserKeypair(A_PRINCIPAL);
    const bKp = await deriveUserKeypair(B_PRINCIPAL);
    // B has already registered their wrap pubkey (as accept_invite does at join).
    const bPubBytes = Array.from(new TextEncoder().encode(bKp.publicKeyB64));
    const { actor, captured, pubkeys } = makeSheetActor({ [B_PRINCIPAL]: bPubBytes });

    const identity = { getPrincipal: () => principalLike(A_PRINCIPAL) } as any;
    await createSheetForPair(actor as any, identity, {
      pairId: "pair-1",
      currencies: ["USD"],
      closingDays: 30,
    });

    const req = captured.req;
    expect(req).toBeTruthy();
    expect(req.wrapped_key_a.length).toBeGreaterThan(0);
    expect(req.wrapped_key_b.length).toBeGreaterThan(0);

    // Creator (A, member_a) reads its own slot via self-unwrap.
    const kFromA = await unwrapSheetKey(
      new Uint8Array(req.wrapped_key_a),
      aKp.privateKey,
      aKp.publicKey,
    );

    // Partner's read path: plain self-unwrap FAILS (slot was cross-wrapped by A)…
    await expect(
      unwrapSheetKey(new Uint8Array(req.wrapped_key_b), bKp.privateKey, bKp.publicKey),
    ).rejects.toBeTruthy();

    // …then the TAGGED unwrap SUCCEEDS using only B's private key (the sealer's pubkey
    // is embedded in the blob — no external lookup), yielding the SAME K_sheet.
    const kFromB = await unwrapTaggedSheetKey(
      new Uint8Array(req.wrapped_key_b),
      bKp.privateKey,
    );
    expect(kFromB).not.toBeNull();
    expect(Array.from(kFromB!)).toEqual(Array.from(kFromA));

    // Creator (re)registered their own pubkey so they can be a cross-wrap recipient.
    expect(pubkeys[A_PRINCIPAL]).toBeTruthy();
    expect(new TextDecoder().decode(new Uint8Array(pubkeys[A_PRINCIPAL]))).toBe(
      aKp.publicKeyB64,
    );
  });

  it("the partner's cross-wrapped slot stays readable after the creator LEAVES (slot anonymized)", async () => {
    // Reproduces the leave-time blocker: A creates a post-join sheet (wrapped_key_b =
    // tagged cross-wrap for B). A leaves → leave_pair promotes B and MOVES that blob
    // into wrapped_key_a, anonymizing member_b — the sheet no longer references A at
    // all. Because the blob is TAGGED with A's pubkey, B still unwraps it with only
    // their own private key (no member-slot lookup needed).
    const aKp = await deriveUserKeypair(A_PRINCIPAL);
    const bKp = await deriveUserKeypair(B_PRINCIPAL);
    const bPubBytes = Array.from(new TextEncoder().encode(bKp.publicKeyB64));
    const { actor, captured } = makeSheetActor({ [B_PRINCIPAL]: bPubBytes });

    const identity = { getPrincipal: () => principalLike(A_PRINCIPAL) } as any;
    await createSheetForPair(actor as any, identity, {
      pairId: "pair-1",
      currencies: ["USD"],
      closingDays: 30,
    });

    // The blob leave_pair would promote into wrapped_key_a, read with ONLY B's key
    // and zero knowledge of A (A's slot is gone).
    const promotedBlob = new Uint8Array(captured.req.wrapped_key_b);
    const kFromB = await unwrapTaggedSheetKey(promotedBlob, bKp.privateKey);
    expect(kFromB).not.toBeNull();
    // consistency: same K the creator sealed
    const kFromA = await unwrapSheetKey(
      new Uint8Array(captured.req.wrapped_key_a),
      aKp.privateKey,
      aKp.publicKey,
    );
    expect(Array.from(kFromB!)).toEqual(Array.from(kFromA));
  });

  it("member_a can read a sheet the PARTNER (member_b) created, even after member_b LEAVES", async () => {
    // Mirror of the creator-leaves blocker. When B (member_b) creates a post-join sheet, it is
    // member_A's slot (wrapped_key_a) that is the TAGGED cross-wrap (sealed for A, embedding B's
    // pubkey). B leaves → leave_pair clears slot B and leaves wrapped_key_a UNTOUCHED, so A must
    // still read it with only their own key (the sheet no longer references B at all).
    const aKp = await deriveUserKeypair(A_PRINCIPAL);
    const bKp = await deriveUserKeypair(B_PRINCIPAL);
    // A has already published their wrap pubkey (opened the account); B is the creator here.
    const aPubBytes = Array.from(new TextEncoder().encode(aKp.publicKeyB64));
    const { actor, captured } = makeSheetActor({ [A_PRINCIPAL]: aPubBytes }, B_PRINCIPAL);

    const identity = { getPrincipal: () => principalLike(B_PRINCIPAL) } as any;
    await createSheetForPair(actor as any, identity, {
      pairId: "pair-1",
      currencies: ["USD"],
      closingDays: 30,
    });

    const req = captured.req;
    // B (creator, member_b) reads its own slot via self-unwrap.
    const kFromB = await unwrapSheetKey(
      new Uint8Array(req.wrapped_key_b),
      bKp.privateKey,
      bKp.publicKey,
    );
    // member_a's slot: plain self-unwrap FAILS (it was cross-wrapped by B)…
    await expect(
      unwrapSheetKey(new Uint8Array(req.wrapped_key_a), aKp.privateKey, aKp.publicKey),
    ).rejects.toBeTruthy();
    // …the TAGGED unwrap succeeds with only A's private key — identical after B leaves, since
    // leave_pair leaves wrapped_key_a in place — yielding the SAME K_sheet.
    const kFromA = await unwrapTaggedSheetKey(new Uint8Array(req.wrapped_key_a), aKp.privateKey);
    expect(kFromA).not.toBeNull();
    expect(Array.from(kFromA!)).toEqual(Array.from(kFromB));
  });

  it("a tagged cross-wrap is unwrapped via the PINNED sender key, not the sealer's current key (survives rotation/leave)", async () => {
    // The tag embeds the EXACT sender pubkey used to seal; the recipient unwraps with only that
    // pinned key + their own private key, never the sealer's *current* registered key — which is
    // what lets a sheet survive the sealer rotating their key or leaving (slot anonymized).
    const aKp = await deriveUserKeypair(A_PRINCIPAL); // sealer, at seal time
    const bKp = await deriveUserKeypair(B_PRINCIPAL); // recipient
    const rotatedKp = await deriveUserKeypair("ccccc-cc"); // the sealer's DIFFERENT key after rotating
    expect(rotatedKp.publicKeyB64).not.toBe(aKp.publicKeyB64);

    const K = newSheetKey();
    const blob = await wrapSheetKeyTagged(K, bKp.publicKey, aKp.privateKey, aKp.publicKeyB64);

    // Tagged unwrap recovers K using the pinned key alone — no registry/lookup involved.
    const back = await unwrapTaggedSheetKey(blob, bKp.privateKey);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(K));

    // The pin is load-bearing: the SAME ciphertext body does NOT unwrap under the sealer's ROTATED
    // key — so a read path that resolved the sealer's *current* registered key instead of the
    // pinned tag would fail here. Blob layout: [MAGIC(1) | pubLen(1) | senderPubRaw(pubLen) | IV | ct].
    const body = blob.subarray(2 + blob[1]);
    await expect(
      unwrapSheetKey(body, bKp.privateKey, rotatedKp.publicKey),
    ).rejects.toBeTruthy();
    // …and it DOES unwrap under the pinned (original) key, confirming that's the one the tag carries.
    const viaPinned = await unwrapSheetKey(body, bKp.privateKey, aKp.publicKey);
    expect(Array.from(viaPinned)).toEqual(Array.from(K));
  });

  it("fails loudly if the partner hasn't published their wrap pubkey yet", async () => {
    const { actor } = makeSheetActor({}); // B not registered
    const identity = { getPrincipal: () => principalLike(A_PRINCIPAL) } as any;
    await expect(
      createSheetForPair(actor as any, identity, {
        pairId: "pair-1",
        currencies: ["USD"],
        closingDays: 30,
      }),
    ).rejects.toThrow(/hasn't published their key/i);
  });
});

// P1 (U1): a SOLO account (member_b not yet joined) seals a self-wrap in slot A and leaves slot B an
// EMPTY placeholder that accept_invite fills when a partner joins.
describe("createSheetForPair — solo account seal", () => {
  it("self-wraps slot A and leaves slot B an empty placeholder", async () => {
    const ANON = "2vxsx-fae";
    const aKp = await deriveUserKeypair(A_PRINCIPAL);
    const captured: { req?: any } = {};
    const actor = {
      // member_b is the anonymous placeholder → isSolo.
      get_pair: async (id: string) => [{ id, members: [principalLike(A_PRINCIPAL), principalLike(ANON)] }],
      register_sheet_pubkey: async () => {},
      create_sheet: async (req: any) => {
        captured.req = req;
        return { id: "solo-sheet", ...req };
      },
    };
    const identity = { getPrincipal: () => principalLike(A_PRINCIPAL) } as any;

    const { K_sheet } = await createSheetForPair(actor as any, identity, {
      pairId: "pair-solo",
      currencies: ["USD"],
      closingDays: 30,
    });

    const req = captured.req;
    expect(req.wrapped_key_b).toEqual([]); // empty placeholder for the not-yet-joined partner
    expect(req.wrapped_key_a.length).toBeGreaterThan(0);
    // The creator recovers the SAME K from its self-wrapped slot A.
    const back = await recoverSheetKey(new Uint8Array(req.wrapped_key_a), aKp);
    expect(Array.from(back)).toEqual(Array.from(K_sheet));
  });
});
