// Privacy-preserving account-type references for OpenChat cards.
//
// A confirmed card is shared with chat participants, so it must never carry
// an account-scoped type id in plaintext. This codec seals only the selected
// id under the active sheet key. The authoritative app-scoped card coordinates
// are AAD: moving a valid reference to another sheet, app subject, chat/message
// handle, action, or entry row makes AES-GCM authentication fail.

const VERSION = 1 as const;
export const TEMPLATE_REF_PREFIX = "ioutr1.";
export const TEMPLATE_REF_MAX_TEMPLATE_ID_LENGTH = 128;
export const TEMPLATE_REF_MAX_LENGTH = 1_416;

const HKDF_SALT = "iou-openchat-template-ref-hkdf-salt-v1";
const HKDF_INFO = "iou-openchat-template-ref-aes-256-gcm-v1";
const AAD_DOMAIN = "iou-openchat-template-ref-context-v1";
const IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;
const MAX_PLAINTEXT_BYTES = 1_024;
const MAX_ENTRY_INDEX = 99;
const U64_MAX = 18_446_744_073_709_551_615n;
const U32_MAX = 4_294_967_295;
const INVALID_REFERENCE_MESSAGE = "invalid encrypted template reference";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export type TemplateRefContext = Readonly<{
  /** IOU sheet ids are canonical, zero-padded lowercase nat64 hex strings. */
  sheetId: string;
  contextVersion: typeof VERSION;
  /** UserIndex-issued 32-byte identifiers, encoded as canonical unpadded base64url. */
  appSubject: string;
  chatHandle: string;
  messageHandle: string;
  appId: number;
  appRevision: bigint;
  actionId: string;
  /** Zero-based position in a single- or multi-entry card. */
  entryIndex: number;
}>;

function getSubtle(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto SubtleCrypto is not available");
  return subtle;
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isWellFormedUtf16(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function validateSheetKey(K_sheet: Uint8Array): void {
  if (!(K_sheet instanceof Uint8Array) || K_sheet.byteLength !== 32) {
    throw new Error("sheet key must be exactly 32 bytes");
  }
}

function validateTemplateId(templateId: string): void {
  if (
    typeof templateId !== "string" ||
    templateId.trim().length === 0 ||
    templateId.length > TEMPLATE_REF_MAX_TEMPLATE_ID_LENGTH ||
    !isWellFormedUtf16(templateId)
  ) {
    throw new Error("template id must be a non-empty, well-formed string of at most 128 characters");
  }
}

function isCanonicalHandle(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.byteLength === 32 && encodeBase64Url(bytes) === value;
  } catch {
    return false;
  }
}

function canonicalContext(context: TemplateRefContext): string {
  if (
    context == null ||
    typeof context !== "object" ||
    typeof context.sheetId !== "string" ||
    !/^[0-9a-f]{16}$/.test(context.sheetId) ||
    context.contextVersion !== VERSION ||
    !isCanonicalHandle(context.appSubject) ||
    !isCanonicalHandle(context.chatHandle) ||
    !isCanonicalHandle(context.messageHandle) ||
    typeof context.appId !== "number" ||
    !Number.isSafeInteger(context.appId) ||
    context.appId < 0 ||
    context.appId > U32_MAX ||
    typeof context.appRevision !== "bigint" ||
    context.appRevision < 0n ||
    context.appRevision > U64_MAX ||
    typeof context.actionId !== "string" ||
    context.actionId.length === 0 ||
    context.actionId.length > 128 ||
    !isWellFormedUtf16(context.actionId) ||
    typeof context.entryIndex !== "number" ||
    !Number.isSafeInteger(context.entryIndex) ||
    context.entryIndex < 0 ||
    context.entryIndex > MAX_ENTRY_INDEX
  ) {
    throw new Error("invalid template reference context");
  }

  // Property order and decimal bigint conversion are part of the v1 wire
  // contract. Never construct this object from untrusted object spreading.
  return JSON.stringify({
    v: VERSION,
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
}

function contextAad(context: TemplateRefContext): Uint8Array {
  return encoder.encode(`${AAD_DOMAIN}\0${canonicalContext(context)}`);
}

function canonicalPlaintext(templateId: string): string {
  return JSON.stringify({ v: VERSION, template_id: templateId });
}

async function deriveAesKey(K_sheet: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();
  const baseKey = await subtle.importKey("raw", toBuffer(K_sheet), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuffer(encoder.encode(HKDF_SALT)),
      info: toBuffer(encoder.encode(HKDF_INFO)),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeCanonicalBase64Url(value: string): Uint8Array {
  if (value.length === 0 || value.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(INVALID_REFERENCE_MESSAGE);
  }

  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  } catch {
    throw new Error(INVALID_REFERENCE_MESSAGE);
  }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // atob accepts non-zero trailing pad bits. Re-encoding prevents multiple
  // textual references from representing the same byte sequence.
  if (encodeBase64Url(bytes) !== value) throw new Error(INVALID_REFERENCE_MESSAGE);
  return bytes;
}

function invalidReference(): Error {
  return new Error(INVALID_REFERENCE_MESSAGE);
}

/**
 * Structural check for an encrypted account-type reference. This deliberately
 * does not decrypt or authenticate the reference; it only prevents callers
 * from accidentally placing a plaintext type id/name in the confirm payload.
 */
export function isEncryptedTemplateRef(value: unknown): value is string {
  try {
    if (
      typeof value !== "string" ||
      value.length > TEMPLATE_REF_MAX_LENGTH ||
      !value.startsWith(TEMPLATE_REF_PREFIX)
    ) {
      return false;
    }
    const wire = decodeCanonicalBase64Url(value.slice(TEMPLATE_REF_PREFIX.length));
    return (
      wire.byteLength >= IV_LENGTH + GCM_TAG_LENGTH + 1 &&
      wire.byteLength <= IV_LENGTH + GCM_TAG_LENGTH + MAX_PLAINTEXT_BYTES
    );
  } catch {
    return false;
  }
}

/** Encrypt an account-scoped type id for one exact OpenChat card entry. */
export async function encryptTemplateRef(
  templateId: string,
  K_sheet: Uint8Array,
  context: TemplateRefContext,
): Promise<string> {
  validateSheetKey(K_sheet);
  validateTemplateId(templateId);
  const aad = contextAad(context);
  const plaintext = encoder.encode(canonicalPlaintext(templateId));
  if (plaintext.byteLength > MAX_PLAINTEXT_BYTES) {
    throw new Error("template id encoding is too large");
  }

  const iv = new Uint8Array(IV_LENGTH);
  globalThis.crypto.getRandomValues(iv);
  const ciphertext = new Uint8Array(
    await getSubtle().encrypt(
      {
        name: "AES-GCM",
        iv: toBuffer(iv),
        additionalData: toBuffer(aad),
        tagLength: 128,
      },
      await deriveAesKey(K_sheet),
      toBuffer(plaintext),
    ),
  );

  const wire = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  wire.set(iv, 0);
  wire.set(ciphertext, iv.byteLength);
  const reference = TEMPLATE_REF_PREFIX + encodeBase64Url(wire);
  if (reference.length > TEMPLATE_REF_MAX_LENGTH) {
    throw new Error("template reference encoding is too large");
  }
  return reference;
}

/**
 * Recover an account-scoped type id. Every malformed/authentication/schema
 * failure is deliberately collapsed to one error so callers never expose
 * decrypted bytes or turn this function into a plaintext-validation oracle.
 */
export async function decryptTemplateRef(
  reference: string,
  K_sheet: Uint8Array,
  context: TemplateRefContext,
): Promise<string> {
  try {
    validateSheetKey(K_sheet);
    const aad = contextAad(context);
    if (!isEncryptedTemplateRef(reference)) {
      throw invalidReference();
    }

    const wire = decodeCanonicalBase64Url(reference.slice(TEMPLATE_REF_PREFIX.length));

    const plaintextBytes = new Uint8Array(
      await getSubtle().decrypt(
        {
          name: "AES-GCM",
          iv: toBuffer(wire.subarray(0, IV_LENGTH)),
          additionalData: toBuffer(aad),
          tagLength: 128,
        },
        await deriveAesKey(K_sheet),
        toBuffer(wire.subarray(IV_LENGTH)),
      ),
    );
    if (plaintextBytes.byteLength === 0 || plaintextBytes.byteLength > MAX_PLAINTEXT_BYTES) {
      throw invalidReference();
    }

    const plaintext = fatalDecoder.decode(plaintextBytes);
    const parsed: unknown = JSON.parse(plaintext);
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidReference();
    }
    const candidate = parsed as Record<string, unknown>;
    if (candidate.v !== VERSION || typeof candidate.template_id !== "string") {
      throw invalidReference();
    }
    validateTemplateId(candidate.template_id);
    if (plaintext !== canonicalPlaintext(candidate.template_id)) {
      throw invalidReference();
    }
    return candidate.template_id;
  } catch {
    throw invalidReference();
  }
}
