// Outcome decoding for the OpenChat registry client calls (register / claim /
// revoke / getRegisteredInboxCanisterId) against a mocked user_index actor, plus
// the exact revoke-challenge preimage layout. Complements registerAiApp.test.ts
// (which pins the manifest wire value + IDL encode).

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Principal } from "@dfinity/principal";

const h = vi.hoisted(() => ({ actor: null as unknown as Record<string, (a: unknown) => unknown> }));

vi.mock("@dfinity/agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    HttpAgent: class {
      async fetchRootKey() {
        return new Uint8Array();
      }
    },
    Actor: { createActor: () => h.actor },
  };
});

import {
  registerAiApp,
  claimAiAppLinkCode,
  revokeAiAppUserKey,
  getRegisteredInboxCanisterId,
} from "./registerAiApp";

const HOST = "http://127.0.0.1:8080";
const UINDEX = "uzt4z-lp777-77774-qaabq-cai";
const PEM = "-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQ==\n-----END PUBLIC KEY-----\n";

beforeEach(() => {
  h.actor = {};
});

describe("registerAiApp — outcome decode + inbox pass-through", () => {
  it("decodes Success and forwards the per-app inbox override in the manifest", async () => {
    let sentManifest: Record<string, unknown> | undefined;
    h.actor = {
      register_ai_app: (a) => {
        sentManifest = (a as { manifest: Record<string, unknown> }).manifest;
        return { Success: { id: 7, owner: Principal.fromText(UINDEX) } };
      },
    };
    const out = await registerAiApp({
      host: HOST,
      userIndexCanisterId: UINDEX,
      consumerPublicKeyPem: "",
      inboxCanisterId: "lc6ij-px777-77777-aaadq-cai",
    });
    expect(out).toEqual({ kind: "success", appId: 7, owner: UINDEX });
    // Regression guard: the upsert MUST carry inbox_canister_id or later deposits are NotConfigured.
    expect(sentManifest?.inbox_canister_id).toHaveLength(1);
  });

  it("decodes InvalidRequest and Error(code,message)", async () => {
    h.actor = { register_ai_app: () => ({ InvalidRequest: "manifest too big" }) };
    expect(await registerAiApp({ host: HOST, userIndexCanisterId: UINDEX, consumerPublicKeyPem: "" })).toEqual({
      kind: "invalid_request",
      message: "manifest too big",
    });

    h.actor = { register_ai_app: () => ({ Error: [429, ["rate limited"]] }) };
    expect(await registerAiApp({ host: HOST, userIndexCanisterId: UINDEX, consumerPublicKeyPem: "" })).toEqual({
      kind: "oc_error",
      code: 429,
      message: "rate limited",
    });

    h.actor = { register_ai_app: () => ({ Error: [500, []] }) };
    expect(await registerAiApp({ host: HOST, userIndexCanisterId: UINDEX, consumerPublicKeyPem: "" })).toEqual({
      kind: "oc_error",
      code: 500,
      message: undefined,
    });
  });
});

describe("claimAiAppLinkCode — outcome decode", () => {
  const call = () =>
    claimAiAppLinkCode({ host: HOST, userIndexCanisterId: UINDEX, code: "123456", publicKeyPem: PEM });

  it("maps each response variant", async () => {
    h.actor = { claim_ai_app_link_code: () => ({ Success: null }) };
    expect(await call()).toEqual({ kind: "success" });
    h.actor = { claim_ai_app_link_code: () => ({ CodeNotFound: null }) };
    expect(await call()).toEqual({ kind: "code_not_found" });
    h.actor = { claim_ai_app_link_code: () => ({ CodeExpired: null }) };
    expect(await call()).toEqual({ kind: "code_expired" });
    h.actor = { claim_ai_app_link_code: () => ({ InvalidRequest: "bad code" }) };
    expect(await call()).toEqual({ kind: "invalid_request", message: "bad code" });
    h.actor = { claim_ai_app_link_code: () => ({ Error: [503, ["down"]] }) };
    expect(await call()).toEqual({ kind: "oc_error", code: 503, message: "down" });
  });

  it("forwards the code + public key to the canister", async () => {
    let seen: { code: string; public_key: string } | undefined;
    h.actor = {
      claim_ai_app_link_code: (a) => {
        seen = a as typeof seen;
        return { Success: null };
      },
    };
    await call();
    expect(seen).toEqual({ code: "123456", public_key: PEM });
  });
});

describe("revokeAiAppUserKey — outcome decode + challenge preimage", () => {
  const DOMAIN = new TextEncoder().encode("oc-revoke-ai-app-user-key-v1");

  it("signs the canonical challenge (domain ‖ userIndex ‖ pem ‖ ts LE) and decodes Success", async () => {
    let preimage: Uint8Array | undefined;
    let sentArgs: { public_key: string; signature: number[]; timestamp: bigint } | undefined;
    h.actor = {
      revoke_ai_app_user_key: (a) => {
        sentArgs = a as typeof sentArgs;
        return { Success: null };
      },
    };
    const out = await revokeAiAppUserKey({
      host: HOST,
      userIndexCanisterId: UINDEX,
      publicKeyPem: PEM,
      sign: async (p) => {
        preimage = p;
        return new Uint8Array([1, 2, 3, 4]);
      },
    });
    expect(out).toEqual({ kind: "success" });

    // Reconstruct the expected preimage and compare each segment.
    const idBytes = Principal.fromText(UINDEX).toUint8Array();
    const pemBytes = new TextEncoder().encode(PEM);
    const ts = sentArgs!.timestamp;
    const tsLe = new Uint8Array(8);
    let v = ts;
    for (let i = 0; i < 8; i++) {
      tsLe[i] = Number(v & 0xffn);
      v >>= 8n;
    }
    const expected = new Uint8Array([...DOMAIN, ...idBytes, ...pemBytes, ...tsLe]);
    expect(Array.from(preimage!)).toEqual(Array.from(expected));
    // The signed timestamp and the wire timestamp must be the same value.
    const tail = preimage!.slice(preimage!.length - 8);
    expect(new DataView(tail.slice().buffer).getBigUint64(0, true)).toBe(ts);
    expect(sentArgs!.public_key).toBe(PEM);
    expect(sentArgs!.signature).toEqual([1, 2, 3, 4]);
  });

  it("maps KeyNotFound and Error", async () => {
    h.actor = { revoke_ai_app_user_key: () => ({ KeyNotFound: null }) };
    expect(
      await revokeAiAppUserKey({ host: HOST, userIndexCanisterId: UINDEX, publicKeyPem: PEM, sign: async () => new Uint8Array(64) }),
    ).toEqual({ kind: "key_not_found" });
    h.actor = { revoke_ai_app_user_key: () => ({ Error: [401, ["nope"]] }) };
    expect(
      await revokeAiAppUserKey({ host: HOST, userIndexCanisterId: UINDEX, publicKeyPem: PEM, sign: async () => new Uint8Array(64) }),
    ).toEqual({ kind: "oc_error", code: 401, message: "nope" });
  });
});

describe("getRegisteredInboxCanisterId — read the registered inbox", () => {
  const INBOX = "lc6ij-px777-77777-aaadq-cai";
  const APPCAN = "ll5dv-z7777-77777-aaaca-cai";
  const app = (name: string, inbox?: string, appCanister?: string) => ({
    manifest: {
      name,
      inbox_canister_id: inbox ? [Principal.fromText(inbox)] : [],
      app_canister_id: appCanister ? [Principal.fromText(appCanister)] : [],
    },
  });

  it("returns the registered inbox principal text for the named app", async () => {
    h.actor = { ai_apps: () => ({ Success: { apps: [app("other"), app("iou", INBOX)] } }) };
    expect(await getRegisteredInboxCanisterId({ host: HOST, userIndexCanisterId: UINDEX, appName: "iou" })).toBe(INBOX);
  });

  it("returns null when the app declares no per-app inbox ([] → OpenChat global inbox)", async () => {
    h.actor = { ai_apps: () => ({ Success: { apps: [app("iou")] } }) };
    expect(await getRegisteredInboxCanisterId({ host: HOST, userIndexCanisterId: UINDEX, appName: "iou" })).toBeNull();
  });

  it("returns null when the app is not registered", async () => {
    h.actor = { ai_apps: () => ({ Success: { apps: [app("other", INBOX)] } }) };
    expect(await getRegisteredInboxCanisterId({ host: HOST, userIndexCanisterId: UINDEX, appName: "iou" })).toBeNull();
  });

  it("prefers the app whose app_canister_id matches (anti-squatting tie-break)", async () => {
    const decoy = "aaaaa-aa";
    h.actor = {
      ai_apps: () => ({ Success: { apps: [app("iou", decoy, "aaaaa-aa"), app("iou", INBOX, APPCAN)] } }),
    };
    expect(
      await getRegisteredInboxCanisterId({ host: HOST, userIndexCanisterId: UINDEX, appName: "iou", appCanisterId: APPCAN }),
    ).toBe(INBOX);
  });
});
