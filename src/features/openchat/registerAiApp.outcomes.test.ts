// Outcome decoding for the public OpenChat registry client calls (register /
// getRegisteredInboxCanisterId) against a mocked user_index actor, plus local
// claim-token normalization. Per-user claim/revoke runs browser → IOU backend
// → authenticated C2C and is covered by disconnectOpenChat.test.ts + Rust.
// Complements registerAiApp.test.ts
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
  getRegisteredInboxCanisterId,
  isValidOpenChatClaimToken,
  normalizeOpenChatClaimToken,
} from "./registerAiApp";

const HOST = "http://127.0.0.1:8080";
const UINDEX = "uzt4z-lp777-77774-qaabq-cai";
const CLAIM_TOKEN = "ab".repeat(32);

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

describe("OpenChat claim-token validation", () => {
  it("normalizes copy/pasted uppercase tokens and accepts exactly 32 bytes of hex", () => {
    expect(normalizeOpenChatClaimToken(`  ${CLAIM_TOKEN.toUpperCase()}\n`)).toBe(
      CLAIM_TOKEN,
    );
    expect(isValidOpenChatClaimToken(CLAIM_TOKEN)).toBe(true);
  });

  it.each(["123456", "g".repeat(64), "a".repeat(63), "a".repeat(65)])(
    "rejects malformed token %s locally",
    (code) => {
      expect(isValidOpenChatClaimToken(code)).toBe(false);
    },
  );
});

describe("getRegisteredInboxCanisterId — read the registered inbox", () => {
  const INBOX = "lc6ij-px777-77777-aaadq-cai";
  const APPCAN = "ll5dv-z7777-77777-aaaca-cai";
  const app = (name: string, inbox?: string, appCanister?: string) => ({
    id: 7,
    updated: 3n,
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
