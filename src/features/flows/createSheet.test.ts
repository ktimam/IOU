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

import { publishUsernameToAllPairs } from "./createSheet";
import { newSheetKey, decryptName } from "../crypto/devVetkd";

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
