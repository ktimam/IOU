import { describe, expect, it } from "vitest";
import {
  cardContextMatchesInit,
  createCardTransportSession,
  decodeCanonicalCapability,
  destroyCardTransportSession,
  destroyLoadedCardContext,
  parseAuthoritativeCardContext,
  type AuthoritativeCardContext,
} from "./cardPrivateContext";
import type { CardInitContext } from "./cardBridge";

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const AUTHORITATIVE: AuthoritativeCardContext = {
  sheetId: "000000000000002a",
  contextVersion: 1,
  appSubject: base64Url(new Uint8Array(32).fill(1)),
  chatHandle: base64Url(new Uint8Array(32).fill(2)),
  messageHandle: base64Url(new Uint8Array(32).fill(3)),
  appId: 23,
  appRevision: 5n,
  actionId: "iou.entry.import",
};

const INIT: CardInitContext = {
  appId: 23,
  appRevision: 5n,
  actionId: "iou.entry.import",
  theme: "dark",
  readonly: false,
  privateContext: {
    capability: base64Url(new Uint8Array(32).fill(9)),
    expiresAt: 10_000n,
    context: {
      contextVersion: 1,
      appSubject: AUTHORITATIVE.appSubject,
      chatHandle: AUTHORITATIVE.chatHandle,
      messageHandle: AUTHORITATIVE.messageHandle,
      appId: 23,
      appRevision: 5n,
      actionId: "iou.entry.import",
    },
  },
};

describe("private card capability parsing", () => {
  it("accepts exactly one canonical 32-byte base64url token", () => {
    const encoded = base64Url(new Uint8Array(32).fill(7));
    expect(decodeCanonicalCapability(encoded)).toEqual(new Uint8Array(32).fill(7));
  });

  it("rejects wrong sizes, padding, bad characters, and non-canonical pad bits", () => {
    for (const value of [
      "",
      base64Url(new Uint8Array(31)),
      base64Url(new Uint8Array(33)),
      base64Url(new Uint8Array(32)) + "=",
      "!" + base64Url(new Uint8Array(32)).slice(1),
      base64Url(new Uint8Array(32)).slice(0, -1) + "B",
    ]) {
      expect(() => decodeCanonicalCapability(value)).toThrow("invalid OpenChat card capability");
    }
  });
});

describe("authoritative card context binding", () => {
  it("requires every app subject, chat/message handle, app revision, and action coordinate to match", () => {
    expect(cardContextMatchesInit(AUTHORITATIVE, INIT)).toBe(true);
    const mismatches: CardInitContext[] = [
      { ...INIT, privateContext: undefined },
      {
        ...INIT,
        privateContext: {
          ...INIT.privateContext!,
          context: { ...INIT.privateContext!.context, appSubject: base64Url(new Uint8Array(32).fill(8)) },
        },
      },
      {
        ...INIT,
        privateContext: {
          ...INIT.privateContext!,
          context: { ...INIT.privateContext!.context, chatHandle: base64Url(new Uint8Array(32).fill(8)) },
        },
      },
      {
        ...INIT,
        privateContext: {
          ...INIT.privateContext!,
          context: { ...INIT.privateContext!.context, messageHandle: base64Url(new Uint8Array(32).fill(8)) },
        },
      },
      { ...INIT, appId: 24 },
      { ...INIT, appRevision: 6n },
      { ...INIT, actionId: "other.action" },
    ];
    for (const mismatch of mismatches) {
      expect(cardContextMatchesInit(AUTHORITATIVE, mismatch)).toBe(false);
    }
  });

  it("maps the exact safe Candid response and rejects malformed pseudonym bytes", () => {
    const raw: Parameters<typeof parseAuthoritativeCardContext>[0] = {
      sheet_id: AUTHORITATIVE.sheetId,
      context_version: 1,
      app_subject: new Uint8Array(32).fill(1),
      chat_handle: new Uint8Array(32).fill(2),
      message_handle: new Uint8Array(32).fill(3),
      app_id: 23,
      app_revision: 5n,
      action_id: "iou.entry.import",
      vetkd_public_key: new Uint8Array(96),
      encrypted_vet_key: new Uint8Array([1]),
      templates_a_enc: [],
      templates_a_iv: [],
      templates_b_enc: [],
      templates_b_iv: [],
    };
    expect(parseAuthoritativeCardContext(raw)).toEqual(AUTHORITATIVE);
    expect(() => parseAuthoritativeCardContext({ ...raw, context_version: 2 })).toThrow(
      "invalid private card context",
    );
    expect(() => parseAuthoritativeCardContext({ ...raw, chat_handle: new Uint8Array(31) })).toThrow(
      "invalid private card context",
    );
    expect(() => parseAuthoritativeCardContext({ ...raw, message_handle: [0, 256] })).toThrow(
      "invalid private card context",
    );
  });
});

describe("private key material lifecycle", () => {
  it("creates a valid vetKD recipient and zeroes its secret on destroy", () => {
    const session = createCardTransportSession();
    expect(session.transport.secretKey).toHaveLength(32);
    expect(session.transport.publicKey).toHaveLength(48);
    expect(session.publicKeyBase64Url).toMatch(/^[A-Za-z0-9_-]{64}$/);
    destroyCardTransportSession(session);
    expect(Array.from(session.transport.secretKey).every((byte) => byte === 0)).toBe(true);
  });

  it("zeroes a loaded sheet key on destroy", () => {
    const sheetKey = new Uint8Array(32).fill(5);
    destroyLoadedCardContext({
      authoritative: AUTHORITATIVE,
      templates: [],
      sheetKey,
    });
    expect(Array.from(sheetKey).every((byte) => byte === 0)).toBe(true);
  });
});
