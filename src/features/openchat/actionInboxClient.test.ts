import { describe, it, expect, vi, beforeEach } from "vitest";
import { Principal } from "@dfinity/principal";
import type { OpenChatBindingWire } from "./disconnectOpenChat";

// Mock the network resolver so we can assert the cache/invalidation behaviour without a replica.
const { getRegisteredActionInboxRoute } = vi.hoisted(() => ({
  getRegisteredActionInboxRoute: vi.fn(),
}));
vi.mock("./registerAiApp", () => ({ getRegisteredActionInboxRoute }));

import {
  parseInboxPlaintext,
  getActionInboxConfig,
  invalidateInboxCache,
} from "./actionInboxClient";

// The v4 envelope OpenChat's LocalUserIndex builds around the exact confirm payload. Wrapper-less
// JSON remains a local-only compatibility case; any object claiming to be an envelope fails closed.
describe("parseInboxPlaintext (v4 envelope wrapper)", () => {
  const payload = { action_id: "iou.add", rows: [{ label: "Amount", value: "$20" }] };
  const handle = (value: number) => Buffer.from(new Uint8Array(32).fill(value)).toString("base64url");
  const context = {
    contextVersion: 1,
    appSubject: handle(1),
    chatHandle: handle(2),
    messageHandle: handle(3),
    confirmedAt: 1750000000123,
    appId: 7,
    appRevision: 1750000000100,
    actionId: "iou.add",
    contentHash: "12".repeat(32),
    confirmationLeaseGeneration: 1,
  };
  const acknowledgementSecret = Uint8Array.from({ length: 32 }, (_, index) => index);

  function base64Url(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
  }

  function envelope(contextValue = context): string {
    return JSON.stringify({
      envelopeVersion: 4,
      payloadEncoding: "base64url",
      context: contextValue,
      payload: base64Url(new TextEncoder().encode(JSON.stringify(payload))),
      acknowledgementSecret: base64Url(acknowledgementSecret),
    });
  }

  it("splits a v4 wrapper into payload + context", () => {
    const out = parseInboxPlaintext(envelope());
    expect(out.payload).toEqual(payload);
    expect(out.context).toEqual(context);
    expect(Array.from(out.acknowledgementSecret ?? [])).toEqual(Array.from(acknowledgementSecret));
  });

  it("accepts a distinct canonical app-scoped chat handle", () => {
    const scoped = { ...context, chatHandle: handle(4) };
    const out = parseInboxPlaintext(envelope(scoped));
    expect(out.context?.chatHandle).toBe(handle(4));
  });

  it("treats a wrapper-less JSON document as the payload (no context)", () => {
    const out = parseInboxPlaintext(JSON.stringify(payload));
    expect(out.payload).toEqual(payload);
    expect(out.context).toBeUndefined();
  });

  it("treats non-object JSON as the payload", () => {
    expect(parseInboxPlaintext('"just a string"')).toEqual({ payload: "just a string" });
    expect(parseInboxPlaintext("[1,2,3]")).toEqual({ payload: [1, 2, 3] });
  });

  it("does not mistake a payload that merely HAS a context field for a wrapper", () => {
    // "payload" key missing → not the wrapper shape, whole doc is the payload.
    const doc = { context: { chatHandle: handle(2) }, something_else: true };
    const out = parseInboxPlaintext(JSON.stringify(doc));
    expect(out.payload).toEqual(doc);
    expect(out.context).toBeUndefined();
  });

  it("rejects a malformed envelope context", () => {
    expect(() => parseInboxPlaintext(envelope({ ...context, chatHandle: 42 } as never))).toThrow();
  });

  it("rejects missing authenticated context fields", () => {
    const { contentHash: _omitted, ...incomplete } = context;
    expect(() => parseInboxPlaintext(envelope(incomplete as never))).toThrow();
  });

  it("throws on non-JSON input (caller drops the envelope)", () => {
    expect(() => parseInboxPlaintext("not json")).toThrow();
  });
});

describe("inbox resolver cache + invalidateInboxCache (stale-manifest fix)", () => {
  const selector = new Uint8Array(32).fill(9);
  const bindingActor = {
    get_openchat_binding: async (): Promise<[] | [OpenChatBindingWire]> => [{
      iou_principal: Principal.fromUint8Array(Uint8Array.of(10, 1)),
      user_index_canister_id: Principal.fromText("uxrrr-q7777-77774-qaaaq-cai"),
      app_id: 7,
      app_revision: 3n,
      app_canister_id: Principal.fromUint8Array(Uint8Array.of(10, 2)),
      key_version: 1n,
      app_subject: new Uint8Array(32).fill(1),
      subject_version: 1,
      consumer_queue_selector: selector,
      consumer_queue_selector_version: 1,
      linked_at: 1n,
    }],
  };

  beforeEach(() => {
    getRegisteredActionInboxRoute.mockReset();
    invalidateInboxCache();
    process.env.VITE_OPENCHAT_HOST = "http://127.0.0.1:8080";
    process.env.VITE_OC_USER_INDEX_CANISTER_ID = "uxrrr-q7777-77774-qaaaq-cai";
    process.env.VITE_IOU_BACKEND_CANISTER_ID = "ll5dv-z7777-77777-aaaca-cai";
  });

  it("memoizes the resolved inbox — repeated calls hit user_index once", async () => {
    getRegisteredActionInboxRoute.mockResolvedValue({
      canisterId: "lc6ij-px777-77777-aaadq-cai",
      appId: 7,
      appRevision: 3n,
    });
    const a = await getActionInboxConfig(bindingActor);
    const b = await getActionInboxConfig(bindingActor);
    expect(a?.canisterId).toBe("lc6ij-px777-77777-aaadq-cai");
    expect(b?.canisterId).toBe("lc6ij-px777-77777-aaadq-cai");
    expect(getRegisteredActionInboxRoute).toHaveBeenCalledTimes(1);
  });

  it("re-queries after invalidateInboxCache — a re-registration takes effect immediately", async () => {
    getRegisteredActionInboxRoute.mockResolvedValueOnce({
      canisterId: "old-inbox-canister-cai",
      appId: 7,
      appRevision: 3n,
    });
    expect((await getActionInboxConfig(bindingActor))?.canisterId).toBe("old-inbox-canister-cai");
    // A re-register moved the routed inbox; without the bust the poll would keep using the old one.
    getRegisteredActionInboxRoute.mockResolvedValueOnce({
      canisterId: "new-inbox-canister-cai",
      appId: 7,
      appRevision: 4n,
    });
    invalidateInboxCache();
    expect((await getActionInboxConfig(bindingActor))?.canisterId).toBe("new-inbox-canister-cai");
    expect(getRegisteredActionInboxRoute).toHaveBeenCalledTimes(2);
  });
});
