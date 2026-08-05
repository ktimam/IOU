import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { acceptInviteForSheet } from "./acceptInvite";
import {
  deriveUserKeypair,
  newSheetKey,
  recoverSheetKey,
  wrapSheetKey,
} from "../crypto/devVetkd";
import { b64uEncode } from "../flows/inviteLink";
import type { ProdSheetKeyContext } from "../crypto/prodVetkd";

if (!(globalThis as { crypto?: Crypto }).crypto) {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
const local = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage ??= {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => {
    local.set(key, value);
  },
  removeItem: (key: string) => {
    local.delete(key);
  },
  clear: () => local.clear(),
  key: (index: number) => [...local.keys()][index] ?? null,
  get length() {
    return local.size;
  },
};

function preparedContext(): ProdSheetKeyContext {
  return {
    transport: {
      secretKey: new Uint8Array(32).fill(2),
      publicKey: new Uint8Array(48).fill(4),
      publicKeyB64: "unused-in-test",
    },
    masterPubKey: new Uint8Array(96).fill(6),
  };
}

describe("acceptInviteForSheet", () => {
  it("establishes the production sheet member and derives the key on the partner's first load", async () => {
    const partner = "bbbbb-bb";
    const prepared = preparedContext();
    const authoritative = newSheetKey();
    let sheetMemberB = "2vxsx-fae";
    const actor = {
      accept_invite: vi.fn(
        async (
          _code: string,
          rewraps: { sheet_id: string; wrapped_key_for_partner: number[] }[],
        ) => {
          if (rewraps.some((rewrap) => rewrap.sheet_id === "sheet-1")) {
            sheetMemberB = partner;
          }
        },
      ),
    };
    const devKeypair = vi.fn(async () => {
      throw new Error("production must not generate a P-256 keypair");
    });
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => prepared),
      deriveProdSheetKeyWithRetry: vi.fn(async () => {
        if (sheetMemberB !== partner) throw new Error("not a member of this sheet");
        return authoritative;
      }),
      deriveUserKeypair: devKeypair,
      wrapSheetKey,
    };

    const result = await acceptInviteForSheet(
      actor,
      partner,
      { code: "invite", sheetId: "sheet-1" },
      runtime,
    );

    expect(result.K_sheet).toBe(authoritative);
    expect(actor.accept_invite).toHaveBeenCalledWith(
      "invite",
      [{ sheet_id: "sheet-1", wrapped_key_for_partner: [] }],
      Array.from(prepared.transport.publicKey),
    );
    expect(sheetMemberB).toBe(partner);
    expect(devKeypair).not.toHaveBeenCalled();
  });

  it("treats post-accept derivation failure as a cold first load, not a failed acceptance", async () => {
    const actor = { accept_invite: vi.fn(async () => undefined) };
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => preparedContext()),
      deriveProdSheetKeyWithRetry: vi.fn(async () => {
        throw new Error("temporary key service failure");
      }),
      deriveUserKeypair,
      wrapSheetKey,
    };

    await expect(
      acceptInviteForSheet(
        actor,
        "bbbbb-bb",
        { code: "invite", sheetId: "sheet-1" },
        runtime,
      ),
    ).resolves.toEqual({ K_sheet: null });
    expect(actor.accept_invite).toHaveBeenCalledTimes(1);
  });

  it("preflights production key material before consuming the single-use invite", async () => {
    const actor = { accept_invite: vi.fn(async () => undefined) };
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => {
        throw new Error("invalid vetKD master public key");
      }),
      deriveProdSheetKeyWithRetry: vi.fn(async () => newSheetKey()),
      deriveUserKeypair,
      wrapSheetKey,
    };

    await expect(
      acceptInviteForSheet(
        actor,
        "bbbbb-bb",
        { code: "invite", sheetId: "sheet-1" },
        runtime,
      ),
    ).rejects.toThrow(/master public key/i);
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });

  it("keeps the development self-wrap flow unchanged", async () => {
    const principal = "ccccc-cc";
    const K_sheet = newSheetKey();
    let accepted:
      | {
          rewraps: { sheet_id: string; wrapped_key_for_partner: number[] }[];
          pubkey: number[];
        }
      | undefined;
    const actor = {
      accept_invite: vi.fn(
        async (
          _code: string,
          rewraps: { sheet_id: string; wrapped_key_for_partner: number[] }[],
          pubkey: number[],
        ) => {
          accepted = { rewraps, pubkey };
        },
      ),
    };
    const runtime = {
      isProdVetkd: () => false,
      prepareProdSheetKey: vi.fn(async () => preparedContext()),
      deriveProdSheetKeyWithRetry: vi.fn(async () => newSheetKey()),
      deriveUserKeypair,
      wrapSheetKey,
    };

    const result = await acceptInviteForSheet(
      actor,
      principal,
      {
        code: "invite-dev",
        sheetId: "sheet-dev",
        keyB64u: b64uEncode(K_sheet),
      },
      runtime,
    );

    expect(Array.from(result.K_sheet!)).toEqual(Array.from(K_sheet));
    const kp = await deriveUserKeypair(principal);
    const recovered = await recoverSheetKey(
      new Uint8Array(accepted!.rewraps[0].wrapped_key_for_partner),
      kp,
    );
    expect(Array.from(recovered)).toEqual(Array.from(K_sheet));
    expect(new TextDecoder().decode(new Uint8Array(accepted!.pubkey))).toBe(
      kp.publicKeyB64,
    );
    expect(runtime.prepareProdSheetKey).not.toHaveBeenCalled();
  });

  it("rejects a malformed dev invite before consuming it", async () => {
    const actor = { accept_invite: vi.fn(async () => undefined) };
    const runtime = {
      isProdVetkd: () => false,
      prepareProdSheetKey: vi.fn(async () => preparedContext()),
      deriveProdSheetKeyWithRetry: vi.fn(async () => newSheetKey()),
      deriveUserKeypair,
      wrapSheetKey,
    };

    await expect(
      acceptInviteForSheet(
        actor,
        "ddddd-dd",
        { code: "invite-dev", sheetId: "sheet-dev" },
        runtime,
      ),
    ).rejects.toThrow(/missing the sheet key/i);
    expect(actor.accept_invite).not.toHaveBeenCalled();
  });
});
