import { describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import { readFileSync } from "node:fs";
import {
  __testing,
  buildOpenChatRevokeChallenge,
  coordinatedDisconnectOpenChat,
  disconnectOpenChat,
  type OpenChatBindingWire,
  type OpenChatDisconnectActor,
} from "./disconnectOpenChat";

const PEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQ==\n-----END PUBLIC KEY-----\n";
const principal = (...bytes: number[]) => Principal.fromUint8Array(Uint8Array.from(bytes));

function binding(overrides: Partial<OpenChatBindingWire> = {}): OpenChatBindingWire {
  return {
    iou_principal: principal(10, 1),
    user_index_canister_id: principal(10, 2),
    app_id: 0x1122_3344,
    app_revision: 9n,
    app_canister_id: principal(10, 3),
    key_version: 0x0102_0304_0506_0708n,
    app_subject: new Array(32).fill(0).map((_, index) => index),
    subject_version: 1,
    consumer_queue_selector: new Uint8Array(32).fill(0xa5),
    consumer_queue_selector_version: 1,
    linked_at: 1n,
    ...overrides,
  };
}

function actor(
  response: Record<string, unknown>,
  current: [] | [OpenChatBindingWire] = [binding()],
) {
  return {
    get_openchat_binding: vi.fn(async () => current),
    disconnect_openchat: vi.fn(async () => response),
  } satisfies OpenChatDisconnectActor;
}

describe("OpenChat V3 disconnect proof", () => {
  it("keeps the settings flow independent of legacy raw OpenChat user-id storage", () => {
    const settings = readFileSync(
      new URL("./ActionInboxSettings.tsx", import.meta.url),
      "utf8",
    );
    expect(settings).not.toContain("./ocViewer");
    expect(settings).not.toContain("openchat_user_id");
    expect(settings).not.toContain("rememberOpenChatUserId");
    expect(settings).not.toContain("forgetOpenChatUserId");
  });

  it("matches the exact domain/scoped-subject/app/version/PEM/timestamp byte layout", () => {
    const value = binding();
    const timestamp = 0x1112_1314_1516_1718n;
    const challenge = buildOpenChatRevokeChallenge(value, PEM, timestamp);
    const domain = __testing.REVOKE_CHALLENGE_DOMAIN;
    const userIndex = value.user_index_canister_id.toUint8Array();
    const appSubject = Uint8Array.from(value.app_subject);
    const expected = new Uint8Array([
      ...domain,
      ...userIndex,
      ...appSubject,
      0x44, 0x33, 0x22, 0x11,
      0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01,
      ...new TextEncoder().encode(PEM),
      0x18, 0x17, 0x16, 0x15, 0x14, 0x13, 0x12, 0x11,
    ]);
    expect(Array.from(challenge)).toEqual(Array.from(expected));
    expect(new TextDecoder().decode(domain)).toBe("oc-revoke-ai-app-user-key-v3\0");
    expect(domain.at(-1)).toBe(0);
  });

  it("accepts OpenChat app id zero but rejects incomplete or malformed V3 scoped coordinates", () => {
    expect(() => buildOpenChatRevokeChallenge(binding({ app_id: 0 }), PEM, 1n)).not.toThrow();
    const invalid: OpenChatBindingWire[] = [
      binding({ iou_principal: Principal.anonymous() }),
      binding({ user_index_canister_id: Principal.anonymous() }),
      binding({ app_revision: 0n }),
      binding({ app_canister_id: Principal.anonymous() }),
      binding({ key_version: 0n }),
      binding({ key_version: Number.MAX_SAFE_INTEGER + 1 }),
      binding({ app_subject: new Uint8Array(31) }),
      binding({ app_subject: [...new Uint8Array(31), 256] }),
      binding({ subject_version: 2 }),
      binding({ consumer_queue_selector: new Uint8Array(31) }),
      binding({ consumer_queue_selector: [...new Uint8Array(31), -1] }),
      binding({ consumer_queue_selector_version: 2 }),
      binding({ app_id: -1 }),
      binding({ app_id: 0x1_0000_0000 }),
      binding({ linked_at: -1n }),
    ];
    for (const value of invalid) {
      expect(() => buildOpenChatRevokeChallenge(value, PEM, 1n)).toThrow();
    }
    expect(() => buildOpenChatRevokeChallenge(binding(), "", 1n)).toThrow();
  });

  it("binds the proof to the app-scoped subject without exposing a raw OpenChat user id", () => {
    const first = binding();
    const second = binding({ app_subject: new Uint8Array(32).fill(0xee) });
    expect(buildOpenChatRevokeChallenge(first, PEM, 1n)).not.toEqual(
      buildOpenChatRevokeChallenge(second, PEM, 1n),
    );
    expect(first).not.toHaveProperty("openchat_user_id");
  });

  it("queries the signed-in binding, signs once, and forwards only proof material to IOU", async () => {
    const a = actor({ Success: null });
    let signedChallenge: Uint8Array | undefined;
    const sign = vi.fn(async (challenge: Uint8Array) => {
      signedChallenge = challenge;
      return new Uint8Array(64).fill(7);
    });
    const outcome = await disconnectOpenChat(a, PEM, sign, () => 123_456);

    expect(outcome).toEqual({ kind: "success" });
    expect(a.get_openchat_binding).toHaveBeenCalledTimes(1);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(a.disconnect_openchat).toHaveBeenCalledWith(
      PEM,
      new Array(64).fill(7),
      123_456n,
    );
    expect(Array.from(signedChallenge!)).toEqual(
      Array.from(buildOpenChatRevokeChallenge(binding(), PEM, 123_456n)),
    );
  });

  it("does not sign or mutate when there is no authoritative IOU binding", async () => {
    const a = actor({ Success: null }, []);
    const sign = vi.fn(async () => new Uint8Array(64));
    await expect(disconnectOpenChat(a, PEM, sign, () => 1)).resolves.toEqual({
      kind: "not_linked",
    });
    expect(sign).not.toHaveBeenCalled();
    expect(a.disconnect_openchat).not.toHaveBeenCalled();
  });

  it("rejects a non-raw signature before calling the backend", async () => {
    const a = actor({ Success: null });
    await expect(
      disconnectOpenChat(a, PEM, async () => new Uint8Array(63), () => 1),
    ).rejects.toThrow(/64-byte/);
    expect(a.disconnect_openchat).not.toHaveBeenCalled();
  });

  it.each([
    [{ Success: null }, { kind: "success" }],
    [{ KeyNotFound: null }, { kind: "key_not_found" }],
    [{ NotLinked: null }, { kind: "not_linked" }],
    [{ NotConfigured: null }, { kind: "not_configured" }],
    [{ InvalidBinding: null }, { kind: "invalid_binding" }],
    [{ BindingChanged: null }, { kind: "binding_changed" }],
    [{ InvalidRequest: "bad proof" }, { kind: "invalid_request", message: "bad proof" }],
    [{ RemoteError: "down" }, { kind: "remote_error", message: "down" }],
  ])("decodes backend outcome %o", async (response, expected) => {
    await expect(
      disconnectOpenChat(actor(response), PEM, async () => new Uint8Array(64), () => 1),
    ).resolves.toEqual(expected);
  });

  it.each([{ Success: null }, { KeyNotFound: null }])(
    "deletes the local key only after clean backend outcome %o",
    async (response) => {
      const events: string[] = [];
      const a = actor(response);
      a.disconnect_openchat.mockImplementation(async () => {
        events.push("backend");
        return response;
      });
      const result = await coordinatedDisconnectOpenChat(
        a,
        PEM,
        async () => {
          events.push("sign");
          return new Uint8Array(64);
        },
        async () => {
          events.push("delete");
          return 7;
        },
        () => 1,
      );
      expect(events).toEqual(["sign", "backend", "delete"]);
      expect(result).toMatchObject({ localDeleteResult: 7 });
    },
  );

  it("retains the local key on every remote/non-clean outcome", async () => {
    const deleteLocal = vi.fn(async () => 7);
    const result = await coordinatedDisconnectOpenChat(
      actor({ RemoteError: "unavailable" }),
      PEM,
      async () => new Uint8Array(64),
      deleteLocal,
      () => 1,
    );
    expect(result).toEqual({
      outcome: { kind: "remote_error", message: "unavailable" },
    });
    expect(deleteLocal).not.toHaveBeenCalled();
  });
});
