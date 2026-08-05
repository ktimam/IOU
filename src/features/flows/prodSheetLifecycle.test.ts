import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSheetForPair,
  SheetCreatedSetupError,
} from "./createSheet";
import {
  decryptName,
  newSheetKey,
} from "../crypto/devVetkd";
import {
  retryProdSheetKeyDerivation,
  type ProdSheetKeyContext,
} from "../crypto/prodVetkd";

if (!(globalThis as { crypto?: Crypto }).crypto) {
  (globalThis as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

const A = "aaaaa-aa";
const ANON = "2vxsx-fae";

function principalLike(text: string) {
  return { toText: () => text };
}

function preparedContext(): ProdSheetKeyContext {
  return {
    transport: {
      secretKey: new Uint8Array(32).fill(3),
      publicKey: new Uint8Array(48).fill(7),
      publicKeyB64: "unused-in-test",
    },
    masterPubKey: new Uint8Array(96).fill(9),
  };
}

function prodActor(events: string[]) {
  const captured: { create?: any; name?: [string, number[], number[]] } = {};
  const actor = {
    get_pair: vi.fn(async (id: string) => {
      events.push("get-pair");
      return [{ id, members: [principalLike(A), principalLike(ANON)] }];
    }),
    create_sheet: vi.fn(async (req: any) => {
      events.push("create");
      captured.create = req;
      return { id: "sheet-prod-1", pair_id: req.pair_id, ...req };
    }),
    set_sheet_name: vi.fn(async (id: string, enc: number[], iv: number[]) => {
      events.push("set-name");
      captured.name = [id, enc, iv];
    }),
  };
  return { actor, captured };
}

describe("production sheet lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("preflights before create, then encrypts the name under the authoritative id-derived key", async () => {
    const events: string[] = [];
    const prepared = preparedContext();
    const authoritative = newSheetKey();
    const { actor, captured } = prodActor(events);
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => {
        events.push("preflight");
        return prepared;
      }),
      deriveProdSheetKeyWithRetry: vi.fn(async (
        _actor,
        sheetId: string,
        _prepared: ProdSheetKeyContext,
      ) => {
        events.push("derive:" + sheetId);
        return authoritative;
      }),
    };

    const result = await createSheetForPair(
      actor as any,
      { getPrincipal: () => principalLike(A) } as any,
      { pairId: "pair-prod", closingDays: 60, name: "  August  " },
      runtime,
    );

    expect(events).toEqual([
      "get-pair",
      "preflight",
      "create",
      "derive:sheet-prod-1",
      "set-name",
    ]);
    expect(actor.create_sheet).toHaveBeenCalledTimes(1);
    expect(captured.create.name_enc).toEqual([]);
    expect(captured.create.name_iv).toEqual([]);
    expect(captured.create.wrapped_key_a).toEqual(
      Array.from(prepared.transport.publicKey),
    );
    expect(captured.create.wrapped_key_b).toEqual([]);
    expect(result.K_sheet).toBe(authoritative);

    const [sheetId, enc, iv] = captured.name!;
    expect(sheetId).toBe("sheet-prod-1");
    expect(
      await decryptName(authoritative, new Uint8Array(iv), new Uint8Array(enc)),
    ).toBe("August");
    expect(
      await decryptName(newSheetKey(), new Uint8Array(iv), new Uint8Array(enc)),
    ).toBe("");

    // A creator refresh goes through the same authoritative derivation seam,
    // not through the create-time placeholder.
    const refreshed = await runtime.deriveProdSheetKeyWithRetry(
      actor,
      result.sheet.id,
      prepared,
    );
    expect(refreshed).toBe(authoritative);
  });

  it("does not create anything when transport/master preflight fails", async () => {
    const events: string[] = [];
    const { actor } = prodActor(events);
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => {
        throw new Error("vetKD unavailable");
      }),
      deriveProdSheetKeyWithRetry: vi.fn(async () => newSheetKey()),
    };

    await expect(
      createSheetForPair(
        actor as any,
        { getPrincipal: () => principalLike(A) } as any,
        { pairId: "pair-prod", closingDays: 30 },
        runtime,
      ),
    ).rejects.toThrow("vetKD unavailable");
    expect(actor.create_sheet).not.toHaveBeenCalled();
    expect(runtime.deriveProdSheetKeyWithRetry).not.toHaveBeenCalled();
  });

  it("never retries create after a post-create derivation failure", async () => {
    const events: string[] = [];
    const { actor } = prodActor(events);
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => preparedContext()),
      deriveProdSheetKeyWithRetry: vi.fn(async () => {
        throw new Error("replica temporarily unavailable");
      }),
    };

    let thrown: unknown;
    try {
      await createSheetForPair(
        actor as any,
        { getPrincipal: () => principalLike(A) } as any,
        { pairId: "pair-prod", closingDays: 30 },
        runtime,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SheetCreatedSetupError);
    expect((thrown as SheetCreatedSetupError).sheet.id).toBe("sheet-prod-1");
    expect((thrown as SheetCreatedSetupError).stage).toBe("key-derivation");
    expect(actor.create_sheet).toHaveBeenCalledTimes(1);
  });

  it("preserves the derived key and existing sheet when the follow-up name write fails", async () => {
    const events: string[] = [];
    const { actor } = prodActor(events);
    actor.set_sheet_name.mockRejectedValue(new Error("name update rejected"));
    const authoritative = newSheetKey();
    const runtime = {
      isProdVetkd: () => true,
      prepareProdSheetKey: vi.fn(async () => preparedContext()),
      deriveProdSheetKeyWithRetry: vi.fn(async () => authoritative),
    };

    let thrown: unknown;
    try {
      await createSheetForPair(
        actor as any,
        { getPrincipal: () => principalLike(A) } as any,
        { pairId: "pair-prod", closingDays: 30, name: "August" },
        runtime,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SheetCreatedSetupError);
    expect((thrown as SheetCreatedSetupError).stage).toBe("name");
    expect((thrown as SheetCreatedSetupError).K_sheet).toBe(authoritative);
    expect(actor.create_sheet).toHaveBeenCalledTimes(1);
  });

  it("retries transient derivation failures and returns the eventual key", async () => {
    const key = newSheetKey();
    const derive = vi
      .fn<() => Promise<Uint8Array>>()
      .mockRejectedValueOnce(new Error("temporary reject"))
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValue(key);

    await expect(
      retryProdSheetKeyDerivation(derive, { attempts: 4, delayMs: 0 }),
    ).resolves.toBe(key);
    expect(derive).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-member key request", async () => {
    const denied = new Error("not a member of this sheet");
    const derive = vi.fn<() => Promise<Uint8Array>>().mockRejectedValue(denied);

    await expect(
      retryProdSheetKeyDerivation(derive, { attempts: 4, delayMs: 0 }),
    ).rejects.toBe(denied);
    expect(derive).toHaveBeenCalledTimes(1);
  });
});
