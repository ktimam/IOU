import { describe, expect, it } from "vitest";
import {
  decryptTemplateRef,
  encryptTemplateRef,
  TEMPLATE_REF_MAX_LENGTH,
  TEMPLATE_REF_PREFIX,
  type TemplateRefContext,
} from "./templateRef";

const INVALID = "invalid encrypted template reference";
const KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const OTHER_KEY = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);

function handle(seed: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

const CONTEXT: TemplateRefContext = {
  sheetId: "00000000000000a7",
  contextVersion: 1,
  appSubject: handle(1),
  chatHandle: handle(2),
  messageHandle: handle(3),
  appId: 17,
  appRevision: 23n,
  actionId: "expense.import",
  entryIndex: 0,
};

const encoder = new TextEncoder();
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function canonicalAad(context: TemplateRefContext): Uint8Array {
  const canonical = JSON.stringify({
    v: 1,
    sheet_id: context.sheetId,
    context_version: context.contextVersion,
    app_subject: context.appSubject,
    chat_handle: context.chatHandle,
    message_handle: context.messageHandle,
    app_id: context.appId,
    app_revision: context.appRevision.toString(10),
    action_id: context.actionId,
    entry_index: context.entryIndex,
  });
  return encoder.encode(`iou-openchat-template-ref-context-v1\0${canonical}`);
}

async function deriveTestKey(K_sheet: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", toBuffer(K_sheet), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuffer(encoder.encode("iou-openchat-template-ref-hkdf-salt-v1")),
      info: toBuffer(encoder.encode("iou-openchat-template-ref-aes-256-gcm-v1")),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
}

/** Build an authenticated v1 envelope whose plaintext bypasses the public encoder. */
async function forgeReference(
  plaintext: string | Uint8Array,
  context: TemplateRefContext = CONTEXT,
): Promise<string> {
  const iv = Uint8Array.from({ length: 12 }, (_, index) => 0xa0 + index);
  const bytes = typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(iv),
        additionalData: toBuffer(canonicalAad(context)),
        tagLength: 128,
      },
      await deriveTestKey(KEY),
      toBuffer(bytes),
    ),
  );
  const wire = new Uint8Array(iv.length + ciphertext.length);
  wire.set(iv);
  wire.set(ciphertext, iv.length);
  return TEMPLATE_REF_PREFIX + encodeBase64Url(wire);
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    expect.fail("expected encrypted template reference rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(INVALID);
  }
}

function tamper(reference: string): string {
  const offset = TEMPLATE_REF_PREFIX.length + 4;
  const replacement = reference[offset] === "A" ? "B" : "A";
  return reference.slice(0, offset) + replacement + reference.slice(offset + 1);
}

function makeNonCanonicalEquivalent(reference: string): string {
  const body = reference.slice(TEMPLATE_REF_PREFIX.length);
  if (body.length % 4 !== 2 && body.length % 4 !== 3) {
    throw new Error("test fixture needs base64 padding bits");
  }
  const index = B64URL.indexOf(body.at(-1) ?? "");
  if (index < 0) throw new Error("invalid test fixture");
  // The final 4 (mod 2) or 2 (mod 3) bits are ignored by permissive decoders.
  // Flipping the low bit keeps the decoded bytes identical but changes text.
  const changed = B64URL[index ^ 1];
  return TEMPLATE_REF_PREFIX + body.slice(0, -1) + changed;
}

describe("encrypted OpenChat template references", () => {
  it("round-trips a type id without exposing it or base64 padding", async () => {
    const reference = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);

    expect(reference).toMatch(/^ioutr1\.[A-Za-z0-9_-]+$/);
    expect(reference).not.toContain("rent-type-7");
    expect(reference).not.toContain("=");
    await expect(decryptTemplateRef(reference, KEY, CONTEXT)).resolves.toBe("rent-type-7");
  });

  it("uses a fresh AES-GCM IV for equivalent references", async () => {
    const first = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);
    const second = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);

    expect(first).not.toBe(second);
    await expect(decryptTemplateRef(first, KEY, CONTEXT)).resolves.toBe("rent-type-7");
    await expect(decryptTemplateRef(second, KEY, CONTEXT)).resolves.toBe("rent-type-7");
  });

  it("rejects the wrong sheet key and collapses the authentication error", async () => {
    const reference = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);
    await expectInvalid(decryptTemplateRef(reference, OTHER_KEY, CONTEXT));
  });

  it.each([
    ["sheet", { ...CONTEXT, sheetId: "00000000000000a8" }],
    ["app subject", { ...CONTEXT, appSubject: handle(4) }],
    ["chat", { ...CONTEXT, chatHandle: handle(4) }],
    ["message", { ...CONTEXT, messageHandle: handle(4) }],
    ["app", { ...CONTEXT, appId: CONTEXT.appId + 1 }],
    ["revision", { ...CONTEXT, appRevision: CONTEXT.appRevision + 1n }],
    ["action", { ...CONTEXT, actionId: "other.action" }],
  ])("rejects reuse in a different %s context", async (_label, context) => {
    const reference = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);
    await expectInvalid(decryptTemplateRef(reference, KEY, context));
  });

  it("rejects moving a reference between rows of a multi-entry card", async () => {
    const rowZero = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);
    await expectInvalid(
      decryptTemplateRef(rowZero, KEY, { ...CONTEXT, entryIndex: 1 }),
    );
  });

  it("rejects ciphertext or tag tampering", async () => {
    const reference = await encryptTemplateRef("rent-type-7", KEY, CONTEXT);
    await expectInvalid(decryptTemplateRef(tamper(reference), KEY, CONTEXT));
  });

  it.each([
    ["wrong version", "ioutr2.AAAA"],
    ["missing body", TEMPLATE_REF_PREFIX],
    ["padding", `${TEMPLATE_REF_PREFIX}AAAA=`],
    ["standard alphabet", `${TEMPLATE_REF_PREFIX}AAA+`],
    ["whitespace", `${TEMPLATE_REF_PREFIX}AA AA`],
    ["impossible base64 length", `${TEMPLATE_REF_PREFIX}A`],
    ["decoded body too short", `${TEMPLATE_REF_PREFIX}AA`],
    ["oversized reference", TEMPLATE_REF_PREFIX + "A".repeat(TEMPLATE_REF_MAX_LENGTH)],
  ])("rejects malformed wire encoding: %s", async (_label, reference) => {
    await expectInvalid(decryptTemplateRef(reference, KEY, CONTEXT));
  });

  it("rejects a non-canonical base64url spelling of the same bytes", async () => {
    let reference = "";
    for (const id of ["a", "aa", "aaa"]) {
      reference = await encryptTemplateRef(id, KEY, CONTEXT);
      const bodyLength = reference.length - TEMPLATE_REF_PREFIX.length;
      if (bodyLength % 4 === 2 || bodyLength % 4 === 3) break;
    }
    const nonCanonical = makeNonCanonicalEquivalent(reference);
    await expectInvalid(decryptTemplateRef(nonCanonical, KEY, CONTEXT));
  });

  it.each([
    ["non-canonical property order", '{"template_id":"rent-type-7","v":1}'],
    ["extra schema field", '{"v":1,"template_id":"rent-type-7","extra":true}'],
    ["wrong schema version", '{"v":2,"template_id":"rent-type-7"}'],
    ["wrong field type", '{"v":1,"template_id":7}'],
    ["invalid JSON", '{"v":1'],
  ])("rejects authenticated malformed plaintext: %s", async (_label, plaintext) => {
    await expectInvalid(decryptTemplateRef(await forgeReference(plaintext), KEY, CONTEXT));
  });

  it("rejects authenticated non-UTF-8 plaintext", async () => {
    await expectInvalid(
      decryptTemplateRef(await forgeReference(new Uint8Array([0xc3, 0x28])), KEY, CONTEXT),
    );
  });

  it("rejects authenticated type ids outside the schema bounds", async () => {
    const plaintext = JSON.stringify({ v: 1, template_id: "x".repeat(129) });
    await expectInvalid(decryptTemplateRef(await forgeReference(plaintext), KEY, CONTEXT));
  });

  it.each(["", "   ", "x".repeat(129), "\ud800"])(
    "rejects invalid plaintext type ids on encryption",
    async (templateId) => {
      await expect(encryptTemplateRef(templateId, KEY, CONTEXT)).rejects.toThrow();
    },
  );

  it.each([new Uint8Array(31), new Uint8Array(33)])(
    "requires a 32-byte sheet key for encryption and decryption",
    async (badKey) => {
      await expect(encryptTemplateRef("rent-type-7", badKey, CONTEXT)).rejects.toThrow(
        "sheet key must be exactly 32 bytes",
      );
      await expectInvalid(decryptTemplateRef("anything", badKey, CONTEXT));
    },
  );

  it.each([
    ["non-canonical sheet id", { ...CONTEXT, sheetId: "A".repeat(16) }],
    ["wrong context version", { ...CONTEXT, contextVersion: 2 as 1 }],
    ["empty app subject", { ...CONTEXT, appSubject: "" }],
    ["short chat handle", { ...CONTEXT, chatHandle: handle(2).slice(1) }],
    ["padded message handle", { ...CONTEXT, messageHandle: handle(3) + "=" }],
    ["non-canonical handle pad bits", { ...CONTEXT, appSubject: CONTEXT.appSubject.slice(0, -1) + "B" }],
    ["negative app id", { ...CONTEXT, appId: -1 }],
    ["app id above u32", { ...CONTEXT, appId: 4_294_967_296 }],
    ["negative app revision", { ...CONTEXT, appRevision: -1n }],
    ["app revision above u64", { ...CONTEXT, appRevision: 18_446_744_073_709_551_616n }],
    ["empty action", { ...CONTEXT, actionId: "" }],
    ["oversized action", { ...CONTEXT, actionId: "x".repeat(129) }],
    ["ill-formed action", { ...CONTEXT, actionId: "\ud800" }],
    ["negative entry index", { ...CONTEXT, entryIndex: -1 }],
    ["entry index above card cap", { ...CONTEXT, entryIndex: 100 }],
    ["fractional entry index", { ...CONTEXT, entryIndex: 0.5 }],
  ])("rejects an invalid canonical context: %s", async (_label, context) => {
    await expect(encryptTemplateRef("rent-type-7", KEY, context)).rejects.toThrow(
      "invalid template reference context",
    );
  });
});
