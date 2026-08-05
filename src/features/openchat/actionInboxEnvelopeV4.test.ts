import { describe, expect, it } from "vitest";
import { parseInboxPlaintext } from "./actionInboxClient";

const CONTEXT = {
  contextVersion: 1,
  appSubject: Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
  chatHandle: Buffer.from(new Uint8Array(32).fill(2)).toString("base64url"),
  messageHandle: Buffer.from(new Uint8Array(32).fill(3)).toString("base64url"),
  confirmedAt: 1_750_000_000_123,
  appId: 9,
  appRevision: 1_750_000_000_100,
  actionId: "sample.confirm",
  contentHash: "ab".repeat(32),
  confirmationLeaseGeneration: 3,
};

const ACKNOWLEDGEMENT_SECRET = Uint8Array.from({ length: 32 }, (_, index) => index);

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function v4Envelope(
  payload: unknown,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    envelopeVersion: 4,
    payloadEncoding: "base64url",
    context: CONTEXT,
    payload: base64Url(new TextEncoder().encode(JSON.stringify(payload))),
    acknowledgementSecret: base64Url(ACKNOWLEDGEMENT_SECRET),
    ...overrides,
  });
}

describe("OpenChat action-inbox v4 envelope", () => {
  it("losslessly decodes the exact v4 payload, context, and acknowledgement secret", () => {
    const payload = { action_id: "iou.add", note: "Résumé 🧪", amount: 20 };
    const parsed = parseInboxPlaintext(v4Envelope(payload));

    expect(parsed.payload).toEqual(payload);
    expect(parsed.context).toEqual(CONTEXT);
    expect(Array.from(parsed.acknowledgementSecret ?? [])).toEqual(Array.from(ACKNOWLEDGEMENT_SECRET));
  });

  it.each([
    ["legacy wrapper", { context: CONTEXT, payload: { action_id: "iou.add" } }],
    ["wrong version", { envelopeVersion: 3 }],
    ["wrong encoding", { payloadEncoding: "utf8" }],
    ["missing acknowledgement", { acknowledgementSecret: undefined }],
    ["padded payload", { payload: base64Url(new TextEncoder().encode("{}")) + "=" }],
    ["non-json payload", { payload: base64Url(new TextEncoder().encode("not json")) }],
    ["invalid utf8 payload", { payload: base64Url(Uint8Array.from([0xff, 0xfe])) }],
    ["non-canonical message handle", { context: { ...CONTEXT, messageHandle: CONTEXT.messageHandle + "=" } }],
    ["short app subject", { context: { ...CONTEXT, appSubject: "AQ" } }],
    ["unknown context version", { context: { ...CONTEXT, contextVersion: 2 } }],
    ["zero lease", { context: { ...CONTEXT, confirmationLeaseGeneration: 0 } }],
    ["wrong content hash", { context: { ...CONTEXT, contentHash: "AB".repeat(32) } }],
    ["unknown outer field", { unexpected: true }],
    ["unknown context field", { context: { ...CONTEXT, unexpected: true } }],
  ])("rejects %s instead of silently downgrading", (_label, overrides) => {
    const input =
      "envelopeVersion" in overrides || "payloadEncoding" in overrides || "acknowledgementSecret" in overrides ||
      "payload" in overrides || "unexpected" in overrides || "context" in overrides
        ? v4Envelope({ action_id: "iou.add" }, overrides)
        : JSON.stringify(overrides);
    expect(() => parseInboxPlaintext(input)).toThrow();
  });

  it("accepts exactly 16 KiB of decoded JSON and rejects one byte more", () => {
    const exact = '"' + "x".repeat(16 * 1024 - 2) + '"';
    const oneOver = '"' + "x".repeat(16 * 1024 - 1) + '"';
    expect(parseInboxPlaintext(v4Envelope(null, { payload: base64Url(new TextEncoder().encode(exact)) })).payload).toHaveLength(
      16 * 1024 - 2,
    );
    expect(() =>
      parseInboxPlaintext(v4Envelope(null, { payload: base64Url(new TextEncoder().encode(oneOver)) })),
    ).toThrow();
  });

  it("keeps wrapper-less JSON as the adjacent legacy-safe payload case", () => {
    const payload = { action_id: "legacy.local-only" };
    expect(parseInboxPlaintext(JSON.stringify(payload))).toEqual({ payload });
  });
});
