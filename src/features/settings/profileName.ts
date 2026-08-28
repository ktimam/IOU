// The user's global display name: encrypted in their caller-scoped UserRecord and cached locally.
//
// The canister already owns `wrapped_display_name` + `display_name_iv`; older UI paths simply did
// not use them consistently. Production derives the same per-principal vetKD material used for the
// durable OpenChat consumer secret, then `encryptWithSheetKey` applies its separate name-key HKDF
// domain before AES-GCM. Dev keeps using its existing per-principal self-ECDH simulation.

import {
  decryptWithSheetKey,
  deriveUserKey,
  encryptWithSheetKey,
  isProdVetkd,
} from "../crypto/devVetkd";
import {
  deriveConsumerWrapKeyProd,
  loadOrCreateTransportKey,
} from "../crypto/prodVetkd";

export const LEGACY_PLAINTEXT_DISPLAY_NAME_IV = "v1-dev-iv-not-secure";

const MAX_NAME_CODE_POINTS = 32;
const MAX_CIPHERTEXT_BYTES = 1024;
const AES_GCM_TAG_BYTES = 16;
const textEncoder = new TextEncoder();

export type StoredProfileName =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "encrypted"; name: string }
  | { kind: "legacy_plaintext"; name: string };

export type ProfileNameReconciliation = {
  use: string;
  /** Set only for an absent record or a one-time legacy plaintext migration. */
  push?: string;
};

export type ProfileNameRecord = {
  wrapped_display_name?: unknown;
  display_name_iv?: unknown;
};

export type ProfileNameActor = {
  get_my_user: () => Promise<unknown>;
  set_display_name: (wrappedDisplayName: number[], displayNameIv: number[]) => Promise<unknown>;
  vetkd_public_key: () => Promise<ArrayLike<number>>;
  vetkd_wrap_consumer_key: (transportPublicKey: number[]) => Promise<ArrayLike<number>>;
};

/** Shared by the read-side hydration guard and its pre-write guard. */
export function profileNameHydrationIsCurrent(
  localAtStart: string,
  currentLocal: string,
  cancelled = false,
): boolean {
  return !cancelled && currentLocal.trim() === localAtStart.trim();
}

function bytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value.slice();
  if (!Array.isArray(value)) return undefined;
  if (
    !value.every(
      (item) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255,
    )
  ) {
    return undefined;
  }
  return Uint8Array.from(value);
}

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function decodeUtf8(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

/** Trim and validate a user-entered/decrypted name without language-specific assumptions. */
export function normalizeProfileName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (name.length === 0 || Array.from(name).length > MAX_NAME_CODE_POINTS) return undefined;
  // Control characters are never meaningful display-name content and can corrupt surrounding UI.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) return undefined;
  return name;
}

export async function encryptProfileName(
  nameInput: string,
  key: Uint8Array,
): Promise<{ wrappedDisplayName: Uint8Array; displayNameIv: Uint8Array }> {
  const name = normalizeProfileName(nameInput);
  if (name === undefined) throw new Error("Name must be 1 to 32 characters");
  if (key.length !== 32) throw new Error("Profile-name key must be 32 bytes");
  const sealed = await encryptWithSheetKey(key, textEncoder.encode(name));
  return { wrappedDisplayName: sealed.ciphertext, displayNameIv: sealed.iv };
}

/**
 * Decode caller-owned canister state. The obsolete sentinel is recognized only as legacy
 * plaintext; it is never passed to AES-GCM or mistaken for a secure ciphertext record.
 */
export async function decodeStoredProfileName(
  record: ProfileNameRecord | null | undefined,
  key: Uint8Array,
): Promise<StoredProfileName> {
  if (record == null) return { kind: "absent" };
  const wrapped = bytes(record.wrapped_display_name);
  const iv = bytes(record.display_name_iv);
  if (wrapped === undefined || iv === undefined) return { kind: "invalid" };
  if (wrapped.length === 0 && iv.length === 0) return { kind: "absent" };
  if (wrapped.length === 0 || iv.length === 0) return { kind: "invalid" };

  const legacyIv = textEncoder.encode(LEGACY_PLAINTEXT_DISPLAY_NAME_IV);
  if (byteEqual(iv, legacyIv)) {
    const name = normalizeProfileName(decodeUtf8(wrapped));
    return name === undefined ? { kind: "invalid" } : { kind: "legacy_plaintext", name };
  }

  if (
    key.length !== 32 ||
    iv.length < 12 ||
    iv.length > 16 ||
    wrapped.length < AES_GCM_TAG_BYTES ||
    wrapped.length > MAX_CIPHERTEXT_BYTES
  ) {
    return { kind: "invalid" };
  }
  try {
    const plaintext = await decryptWithSheetKey(key, iv, wrapped);
    const name = normalizeProfileName(decodeUtf8(plaintext));
    return name === undefined ? { kind: "invalid" } : { kind: "encrypted", name };
  } catch {
    return { kind: "invalid" };
  }
}

/** Canister wins only when it contains a valid name; a broken/empty read never erases local text. */
export function reconcileProfileName(
  remote: StoredProfileName,
  localInput: unknown,
): ProfileNameReconciliation {
  const localText = typeof localInput === "string" ? localInput.trim() : "";
  const validLocal = normalizeProfileName(localText);
  if (remote.kind === "encrypted") return { use: remote.name };
  if (remote.kind === "legacy_plaintext") {
    // The sentinel record predates canister-backed synchronization and may be older than this
    // browser's cache. Preserve a valid local edit during the one-time migration; otherwise rescue
    // the valid legacy value. Either choice is immediately rewritten as AES-GCM ciphertext.
    const migrationName = validLocal ?? remote.name;
    return { use: migrationName, push: migrationName };
  }
  if (remote.kind === "absent" && validLocal !== undefined) {
    return { use: validLocal, push: validLocal };
  }
  // Invalid remote data is quarantined rather than overwritten automatically: it could be valid
  // ciphertext created under an unavailable/rotated key. Most importantly, keep the local cache.
  return { use: localText };
}

/** Existing account-key derivation, reused so production names decrypt on every signed-in device. */
export async function deriveProfileNameKey(
  principal: string,
  actor: Pick<ProfileNameActor, "vetkd_public_key" | "vetkd_wrap_consumer_key">,
): Promise<Uint8Array> {
  if (!isProdVetkd()) return deriveUserKey(principal);
  const transport = await loadOrCreateTransportKey();
  const masterPublicKey = new Uint8Array(await actor.vetkd_public_key());
  const encryptedVetKey = new Uint8Array(
    await actor.vetkd_wrap_consumer_key(Array.from(transport.publicKey)),
  );
  return deriveConsumerWrapKeyProd(
    principal,
    transport,
    masterPublicKey,
    encryptedVetKey,
  );
}

export async function persistEncryptedProfileName(
  actor: Pick<ProfileNameActor, "set_display_name" | "vetkd_public_key" | "vetkd_wrap_consumer_key">,
  principal: string,
  name: string,
): Promise<void> {
  const key = await deriveProfileNameKey(principal, actor);
  try {
    const sealed = await encryptProfileName(name, key);
    await actor.set_display_name(
      Array.from(sealed.wrappedDisplayName),
      Array.from(sealed.displayNameIv),
    );
  } finally {
    key.fill(0);
  }
}

function unwrapRecord(value: unknown): ProfileNameRecord | null {
  if (value == null) return null;
  if (Array.isArray(value)) return (value[0] as ProfileNameRecord | undefined) ?? null;
  return value as ProfileNameRecord;
}

/** One query/reconcile/migration cycle, kept outside React so its write policy is testable. */
export async function synchronizeProfileName(
  actor: ProfileNameActor,
  principal: string,
  localName: unknown,
  stillCurrent?: () => boolean,
): Promise<ProfileNameReconciliation> {
  const record = unwrapRecord(await actor.get_my_user());
  const key = await deriveProfileNameKey(principal, actor);
  try {
    const remote = await decodeStoredProfileName(record, key);
    const reconciliation = reconcileProfileName(remote, localName);
    if (reconciliation.push !== undefined && stillCurrent?.() !== false) {
      const sealed = await encryptProfileName(reconciliation.push, key);
      // WebCrypto yields. The user may save a newer name while encryption is in flight, so guard
      // again at the actual write boundary rather than letting hydration overwrite that update.
      if (stillCurrent?.() !== false) {
        await actor.set_display_name(
          Array.from(sealed.wrappedDisplayName),
          Array.from(sealed.displayNameIv),
        );
      }
    }
    return reconciliation;
  } finally {
    key.fill(0);
  }
}
