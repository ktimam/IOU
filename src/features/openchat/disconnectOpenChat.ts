import { Principal } from "@dfinity/principal";

// Must remain byte-for-byte identical to OpenChat user_index
// revoke_ai_app_user_key.rs. The trailing NUL is part of the V3 domain.
const REVOKE_CHALLENGE_DOMAIN = new TextEncoder().encode(
  "oc-revoke-ai-app-user-key-v3\0",
);
const MAX_U64 = 0xffff_ffff_ffff_ffffn;

type CandidOpt<T> = [] | [T];
type ByteVector = Uint8Array | number[];

export type OpenChatBindingWire = {
  iou_principal: Principal;
  user_index_canister_id: Principal;
  app_id: number;
  app_revision: bigint | number;
  app_canister_id: Principal;
  key_version: bigint | number;
  app_subject: ByteVector;
  subject_version: number;
  consumer_queue_selector: ByteVector;
  consumer_queue_selector_version: number;
  linked_at: bigint | number;
};

export type OpenChatDisconnectActor = {
  get_openchat_binding: () => Promise<CandidOpt<OpenChatBindingWire>>;
  disconnect_openchat: (
    publicKeyPem: string,
    signature: number[],
    timestamp: bigint,
  ) => Promise<Record<string, unknown>>;
};

export type OpenChatBindingReader = Pick<OpenChatDisconnectActor, "get_openchat_binding">;

export type DisconnectOpenChatOutcome =
  | { kind: "success" }
  | { kind: "key_not_found" }
  | { kind: "not_linked" }
  | { kind: "not_configured" }
  | { kind: "invalid_binding" }
  | { kind: "invalid_request"; message: string }
  | { kind: "binding_changed" }
  | { kind: "remote_error"; message: string };

function one<T>(value: CandidOpt<T> | null | undefined): T | null {
  return Array.isArray(value) && value.length === 1 ? value[0]! : null;
}

function u32LeBytes(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error("OpenChat binding has an invalid app id");
  }
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, true);
  return out;
}

function asU64(value: bigint | number, field: string): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`OpenChat binding has an invalid ${field}`);
  }
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > MAX_U64) {
    throw new Error(`OpenChat binding has an invalid ${field}`);
  }
  return parsed;
}

function u64LeBytes(value: bigint | number, field: string): Uint8Array {
  let remaining = asU64(value, field);
  const out = new Uint8Array(8);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

function exactByteVector(value: ByteVector, field: string): Uint8Array {
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) {
    throw new Error(`OpenChat binding has an invalid ${field}`);
  }
  if (
    value.length !== 32
    || Array.from(value).some(
      (byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff,
    )
  ) {
    throw new Error(`OpenChat binding has an invalid ${field}`);
  }
  return Uint8Array.from(value);
}

function requireV3Binding(binding: OpenChatBindingWire) {
  const appRevision = asU64(binding.app_revision, "app revision");
  const keyVersion = asU64(binding.key_version, "key version");
  const appSubject = exactByteVector(binding.app_subject, "app subject");
  const consumerQueueSelector = exactByteVector(
    binding.consumer_queue_selector,
    "consumer queue selector",
  );
  if (
    binding.iou_principal.isAnonymous()
    || binding.user_index_canister_id.isAnonymous()
    || binding.app_canister_id.isAnonymous()
    || appRevision === 0n
    || keyVersion === 0n
    || binding.subject_version !== 1
    || binding.consumer_queue_selector_version !== 1
  ) {
    throw new Error("OpenChat binding is not a complete V3 scoped binding");
  }
  asU64(binding.linked_at, "linked at");
  return { appSubject, consumerQueueSelector, keyVersion };
}

/** Read the caller-scoped opaque ActionInbox selector from IOU's authenticated binding. */
export async function readOpenChatConsumerQueueSelector(
  actor: OpenChatBindingReader,
): Promise<Uint8Array | null> {
  const binding = one(await actor.get_openchat_binding());
  if (!binding) return null;
  return requireV3Binding(binding).consumerQueueSelector;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Exact V3 proof signed by the still-present P-256 consumer key:
 * domain || UserIndex raw || app-scoped subject32 || app_id u32 LE ||
 * key_version u64 LE || exact PEM UTF-8 || timestamp u64 LE.
 */
export function buildOpenChatRevokeChallenge(
  binding: OpenChatBindingWire,
  publicKeyPem: string,
  timestamp: bigint,
): Uint8Array {
  if (
    publicKeyPem.length === 0
    || publicKeyPem.length > 2_000
    || !publicKeyPem.includes("BEGIN PUBLIC KEY")
  ) {
    throw new Error("invalid OpenChat consumer public key");
  }
  const { appSubject, keyVersion } = requireV3Binding(binding);
  return concatBytes([
    REVOKE_CHALLENGE_DOMAIN,
    binding.user_index_canister_id.toUint8Array(),
    appSubject,
    u32LeBytes(binding.app_id),
    u64LeBytes(keyVersion, "key version"),
    new TextEncoder().encode(publicKeyPem),
    u64LeBytes(timestamp, "timestamp"),
  ]);
}

function decodeOutcome(response: Record<string, unknown>): DisconnectOpenChatOutcome {
  if ("Success" in response) return { kind: "success" };
  if ("KeyNotFound" in response) return { kind: "key_not_found" };
  if ("NotLinked" in response) return { kind: "not_linked" };
  if ("NotConfigured" in response) return { kind: "not_configured" };
  if ("InvalidBinding" in response) return { kind: "invalid_binding" };
  if ("BindingChanged" in response) return { kind: "binding_changed" };
  if ("InvalidRequest" in response) {
    return { kind: "invalid_request", message: String(response.InvalidRequest) };
  }
  if ("RemoteError" in response) {
    return { kind: "remote_error", message: String(response.RemoteError) };
  }
  throw new Error("IOU returned an invalid OpenChat disconnect response");
}

/**
 * Prepare a browser-held proof, then ask the signed-in IOU backend to perform
 * the app-canister-authenticated C2C revoke. This function never deletes the
 * local key; the caller must do that only for success/key_not_found.
 */
export async function disconnectOpenChat(
  actor: OpenChatDisconnectActor,
  publicKeyPem: string,
  sign: (preimage: Uint8Array) => Promise<Uint8Array>,
  now: () => number = Date.now,
): Promise<DisconnectOpenChatOutcome> {
  const binding = one(await actor.get_openchat_binding());
  if (!binding) return { kind: "not_linked" };

  const timestamp = BigInt(now());
  const challenge = buildOpenChatRevokeChallenge(binding, publicKeyPem, timestamp);
  const signature = await sign(challenge);
  if (signature.length !== 64) {
    throw new Error("OpenChat revoke proof must be a raw 64-byte P-256 signature");
  }
  return decodeOutcome(
    await actor.disconnect_openchat(publicKeyPem, Array.from(signature), timestamp),
  );
}

/**
 * UI sequencing guard: local deletion is reached only after the IOU backend
 * reports that OpenChat revoked the exact tuple (or it was already absent).
 * Every failure leaves the private key available so the user can retry.
 */
export async function coordinatedDisconnectOpenChat<T>(
  actor: OpenChatDisconnectActor,
  publicKeyPem: string,
  sign: (preimage: Uint8Array) => Promise<Uint8Array>,
  deleteLocalKey: () => Promise<T>,
  now: () => number = Date.now,
): Promise<
  | { outcome: { kind: "success" } | { kind: "key_not_found" }; localDeleteResult: T }
  | { outcome: Exclude<DisconnectOpenChatOutcome, { kind: "success" } | { kind: "key_not_found" }> }
> {
  const outcome = await disconnectOpenChat(actor, publicKeyPem, sign, now);
  if (outcome.kind !== "success" && outcome.kind !== "key_not_found") {
    return { outcome };
  }
  return { outcome, localDeleteResult: await deleteLocalKey() };
}

export const __testing = {
  REVOKE_CHALLENGE_DOMAIN,
  u32LeBytes,
  u64LeBytes,
};
