// OpenChat ActionInbox v4 consumer. A replicated `actions` update supplies consensus-authentic
// storage ids/order; UserIndex's dedicated, independently pinned P-256 key authenticates the route,
// encrypted envelope, recipient, full card identity, payload, and private context commitment. IOU
// then decrypts and independently recomputes every inner commitment before accepting a draft.

import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import {
  DEV_LAN_QC_IC_ORIGIN,
  shouldFetchLocalRootKey,
} from "../../config/devLanQcRuntime";
import { isLocalDevelopmentIcOrigin } from "../../config/devLanQc";
import {
  acknowledgementSecretHashV1,
  aiAppCardConfirmPayloadHashV1,
  actionCardContextHashV2,
  actionSigningKeyId,
  decryptInboxEnvelope,
  equalBytes,
  verifyOpenChatActionSignature,
} from "./actionInboxCrypto";
import { loadOrCreateConsumerKeypair, type ConsumerKeypair } from "./consumerKeypair";
import {
  getRegisteredActionInboxRoute,
  type RegisteredActionInboxRoute,
} from "./registerAiApp";
import {
  readOpenChatConsumerQueueSelector,
  type OpenChatBindingReader,
} from "./disconnectOpenChat";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IDL = any;

export const actionInboxIdlFactory = ({ IDL: idl }: { IDL: IDL }) => {
  const Args = idl.Record({
    max_results: idl.Nat32,
    consumer_key_fingerprint: idl.Vec(idl.Nat8),
    since_id: idl.Nat64,
  });
  const StoredAction = idl.Record({
    id: idl.Nat64,
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    action_id: idl.Text,
    consumer_key_fingerprint: idl.Vec(idl.Nat8),
    idempotency_key: idl.Vec(idl.Nat8),
    payload_hash: idl.Vec(idl.Nat8),
    card_context_hash: idl.Vec(idl.Nat8),
    acknowledgement_secret_hash: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    ephemeral_public_key: idl.Vec(idl.Nat8),
    signature_version: idl.Nat16,
    signing_key_id: idl.Vec(idl.Nat8),
    created_at: idl.Nat64,
    oc_signature: idl.Vec(idl.Nat8),
  });
  const SuccessResult = idl.Record({ actions: idl.Vec(StoredAction) });
  const Error = idl.Record({ 0: idl.Nat16, 1: idl.Opt(idl.Text) });
  const Response = idl.Variant({ Success: SuccessResult, Error });
  const AcknowledgeArgs = idl.Record({
    consumer_key_fingerprint: idl.Vec(idl.Nat8),
    consumer_public_key_pem: idl.Text,
    through_id: idl.Nat64,
    signature: idl.Vec(idl.Nat8),
    acknowledgement_secret: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const AcknowledgeResult = idl.Record({ acknowledged: idl.Nat32, remaining: idl.Nat32 });
  const AcknowledgeResponse = idl.Variant({
    Success: AcknowledgeResult,
    InvalidRequest: idl.Text,
    NotAuthorized: idl.Null,
  });
  return idl.Service({
    // Replicated update: StoredAction.id/order/page completeness are ActionInbox consensus state.
    actions: idl.Func([Args], [Response], []),
    acknowledge_actions: idl.Func([AcknowledgeArgs], [AcknowledgeResponse], []),
  });
};

export const userIndexActionSigningKeysIdlFactory = ({ IDL: idl }: { IDL: IDL }) => {
  const Status = idl.Variant({ Staged: idl.Null, Active: idl.Null, VerifyOnly: idl.Null });
  const Key = idl.Record({
    key_id: idl.Vec(idl.Nat8),
    public_key_pem: idl.Text,
    status: Status,
    created_at: idl.Nat64,
    verify_until: idl.Opt(idl.Nat64),
  });
  const Success = idl.Record({
    signature_version: idl.Nat16,
    purpose: idl.Text,
    keys: idl.Vec(Key),
  });
  const Response = idl.Variant({ Success, NotInitialised: idl.Null });
  return idl.Service({ action_signing_keys: idl.Func([idl.Record({})], [Response], ["query"]) });
};

type RawStoredAction = {
  id: bigint;
  app_id: number;
  app_revision: bigint;
  action_id: string;
  consumer_key_fingerprint: number[] | Uint8Array;
  idempotency_key: number[] | Uint8Array;
  payload_hash: number[] | Uint8Array;
  card_context_hash: number[] | Uint8Array;
  acknowledgement_secret_hash: number[] | Uint8Array;
  ciphertext: number[] | Uint8Array;
  ephemeral_public_key: number[] | Uint8Array;
  signature_version: number;
  signing_key_id: number[] | Uint8Array;
  oc_signature: number[] | Uint8Array;
  created_at: bigint;
};

type RawActionSigningKey = {
  key_id: number[] | Uint8Array;
  public_key_pem: string;
  status: { Staged?: null; Active?: null; VerifyOnly?: null };
  created_at: bigint;
  verify_until: [] | [bigint];
};

/**
 * Delivery provenance carried by the v4 envelope plaintext wrapper. The payload is losslessly
 * base64url-encoded, and the remaining fields bind it to the exact app card and confirmation lease.
 * The subject/chat/message values are app-scoped HMAC handles. They deliberately do not expose a
 * global OpenChat user principal or raw chat/message coordinates to this external application.
 */
export type InboxDraftContext = {
  contextVersion: 1;
  appSubject: string;
  chatHandle: string;
  messageHandle: string;
  confirmedAt: number;
  appId: number;
  appRevision: number;
  actionId: string;
  contentHash: string;
  confirmationLeaseGeneration: number;
};

export type InboxDraft = {
  /** Stable identity authenticated by the v4 signature and decrypted card-context commitment. */
  deliveryId: string;
  /** Opaque ActionInbox storage locator; use only with this action's acknowledgement secret. */
  id: bigint;
  draft: unknown; // decrypted payload (for IOU, the JSON draft parseDraft accepts)
  created_at: bigint;
  context: InboxDraftContext;
  acknowledgementSecret: Uint8Array;
};

/**
 * Decode a decrypted v4 plaintext into { payload, context }. Any object that claims to be an
 * envelope must match the exact version, field set, canonical base64url encoding, app/card
 * provenance, and acknowledgement-secret shape. A plain JSON value with no envelope markers
 * remains a local-only legacy payload.
 */
const MAX_CONFIRM_PAYLOAD_BYTES = 16 * 1024;
const V4_ENVELOPE_KEYS = [
  "acknowledgementSecret",
  "context",
  "envelopeVersion",
  "payload",
  "payloadEncoding",
] as const;
const V4_CONTEXT_KEYS = [
  "actionId",
  "appId",
  "appRevision",
  "appSubject",
  "chatHandle",
  "confirmationLeaseGeneration",
  "confirmedAt",
  "contextVersion",
  "contentHash",
  "messageHandle",
] as const;

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseCanonicalBase64Url(
  value: unknown,
  options: { exactBytes?: number; maxBytes?: number; allowEmpty?: boolean } = {},
): Uint8Array | undefined {
  if (
    typeof value !== "string" ||
    (!options.allowEmpty && value.length === 0) ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1
  ) {
    return undefined;
  }
  try {
    const standard =
      value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (value.length % 4)) % 4);
    const binary = globalThis.atob(standard);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (
      (options.exactBytes !== undefined && bytes.length !== options.exactBytes) ||
      (options.maxBytes !== undefined && bytes.length > options.maxBytes)
    ) {
      return undefined;
    }
    const canonical = globalThis
      .btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return canonical === value ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function isSafeUnsigned(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function parseV4Context(value: unknown): InboxDraftContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const context = value as Record<string, unknown>;
  if (!hasExactKeys(context, V4_CONTEXT_KEYS)) return undefined;
  const appSubject = parseCanonicalBase64Url(context.appSubject, { exactBytes: 32 });
  const chatHandle = parseCanonicalBase64Url(context.chatHandle, { exactBytes: 32 });
  const messageHandle = parseCanonicalBase64Url(context.messageHandle, { exactBytes: 32 });
  if (
    context.contextVersion !== 1 ||
    !appSubject ||
    !chatHandle ||
    !messageHandle ||
    !isSafeUnsigned(context.confirmedAt) ||
    !isSafeUnsigned(context.appId, 0xffff_ffff) ||
    !isSafeUnsigned(context.appRevision) ||
    typeof context.actionId !== "string" ||
    context.actionId.length === 0 ||
    context.actionId.length > 128 ||
    typeof context.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(context.contentHash) ||
    !isSafeUnsigned(context.confirmationLeaseGeneration) ||
    context.confirmationLeaseGeneration === 0
  ) {
    return undefined;
  }
  return {
    contextVersion: 1,
    appSubject: context.appSubject as string,
    chatHandle: context.chatHandle as string,
    messageHandle: context.messageHandle as string,
    confirmedAt: context.confirmedAt,
    appId: context.appId,
    appRevision: context.appRevision,
    actionId: context.actionId,
    contentHash: context.contentHash,
    confirmationLeaseGeneration: context.confirmationLeaseGeneration,
  };
}

export function parseInboxPlaintext(text: string): {
  payload: unknown;
  payloadBytes?: Uint8Array;
  context?: InboxDraftContext;
  acknowledgementSecret?: Uint8Array;
} {
  const doc: unknown = JSON.parse(text);
  if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
    const rec = doc as Record<string, unknown>;
    const claimsEnvelope =
      "envelopeVersion" in rec ||
      "payloadEncoding" in rec ||
      "acknowledgementSecret" in rec ||
      ("context" in rec && "payload" in rec);
    if (claimsEnvelope) {
      if (
        !hasExactKeys(rec, V4_ENVELOPE_KEYS) ||
        rec.envelopeVersion !== 4 ||
        rec.payloadEncoding !== "base64url"
      ) {
        throw new Error("invalid OpenChat action-inbox envelope");
      }
      const context = parseV4Context(rec.context);
      const acknowledgementSecret = parseCanonicalBase64Url(rec.acknowledgementSecret, { exactBytes: 32 });
      const payloadBytes = parseCanonicalBase64Url(rec.payload, { maxBytes: MAX_CONFIRM_PAYLOAD_BYTES });
      if (!context || !acknowledgementSecret || !payloadBytes) {
        throw new Error("invalid OpenChat action-inbox envelope");
      }
      let payloadText: string;
      try {
        payloadText = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
      } catch {
        throw new Error("invalid OpenChat action-inbox payload encoding");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        throw new Error("invalid OpenChat action-inbox payload JSON");
      }
      return {
        payload,
        payloadBytes,
        context,
        acknowledgementSecret,
      };
    }
  }
  return { payload: doc };
}

export type ActionInboxConfig = {
  canisterId: string;
  /** Authoritative registry id; part of the queue-selector correlation boundary. */
  appId: number;
  /** Caller-private HMAC selector issued by UserIndex through IOU's authenticated link claim. */
  consumerKeySelector: Uint8Array;
  host: string; // the IC host serving the inbox (OpenChat's replica / mainnet)
  /** Authoritative UserIndex which signs generic app-card deposits. */
  userIndexCanisterId: string;
  /** Independently provisioned UserIndex action-signing key ids (never learned from the inbox). */
  signingKeyIds?: readonly string[];
};

function parseOpenChatHost(host: string): { isLocalDevelopment: boolean } {
  if (typeof host !== "string" || host.length === 0 || host !== host.trim()) {
    throw new Error("OpenChat host must be an exact absolute HTTP(S) origin");
  }
  let url: URL;
  try {
    url = new URL(host);
  } catch {
    throw new Error("OpenChat host must be an exact absolute HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("OpenChat host must be an exact absolute HTTP(S) origin without credentials, path, query, or fragment");
  }
  const isLocalDevelopment = isLocalDevelopmentIcOrigin(host, DEV_LAN_QC_IC_ORIGIN);
  if (!isLocalDevelopment && url.protocol !== "https:") {
    throw new Error(
      "OpenChat host must use HTTPS unless it is an exact configured local-development origin",
    );
  }
  return { isLocalDevelopment };
}

/**
 * Validate and canonicalize the independently provisioned action-signing key allowlist. Only
 * exact configured local-development origins may leave it empty; lookalike domains and malformed
 * origins never inherit that exemption. A key returned by UserIndex is usable only if its derived
 * id is in this list.
 */
export function resolveOpenChatActionSigningKeyIds(
  host: string,
  configured: string | readonly string[] | undefined,
): readonly string[] {
  const { isLocalDevelopment } = parseOpenChatHost(host);
  let values: readonly string[];
  if (configured === undefined || configured === "") values = [];
  else if (typeof configured === "string") {
    if (configured !== configured.trim()) {
      throw new Error("VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS must not contain surrounding whitespace");
    }
    values = configured.split(",");
  } else values = configured;

  if (values.length === 0) {
    if (isLocalDevelopment) return [];
    throw new Error("VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS is required for a non-local OpenChat host");
  }
  if (values.length > 3) {
    throw new Error("VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS may contain at most three key ids");
  }
  const normalized = values.map((value) => {
    if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error("each OpenChat action-signing key id must be exactly 64 hexadecimal characters");
    }
    return value.toLowerCase();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("OpenChat action-signing key ids must be unique");
  }
  return normalized;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function buildInboxAgent(host: string, identity?: Identity): Promise<HttpAgent> {
  parseOpenChatHost(host);
  const agent = new HttpAgent({ host, ...(identity ? { identity } : {}) });
  if (shouldFetchLocalRootKey()) {
    await agent.fetchRootKey();
  }
  return agent;
}

function asBytes(value: unknown, field = "byte vector"): Uint8Array {
  if (
    !(value instanceof Uint8Array) &&
    (!Array.isArray(value) ||
      value.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 0xff))
  ) {
    throw new Error(`invalid ${field}`);
  }
  return Uint8Array.from(value);
}

function requireCanonicalCanisterId(value: string, field: string): void {
  if (value !== value.trim()) throw new Error(`${field} must be a canonical principal`);
  try {
    if (Principal.fromText(value).toText() !== value) throw new Error();
  } catch {
    throw new Error(`${field} must be a canonical principal`);
  }
}

function hasVariant(status: RawActionSigningKey["status"], name: "Staged" | "Active" | "VerifyOnly"): boolean {
  return typeof status === "object" && status !== null && Object.prototype.hasOwnProperty.call(status, name);
}

async function loadTrustedActionSigningKeys(opts: {
  agent: HttpAgent;
  userIndexCanisterId: string;
  allowedKeyIds: readonly string[];
}): Promise<Map<string, { publicKeyPem: string; createdAt: bigint; verifyUntil: bigint | null }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(userIndexActionSigningKeysIdlFactory, {
    agent: opts.agent,
    canisterId: opts.userIndexCanisterId,
  });
  const response = await actor.action_signing_keys({});
  const result = response?.Success;
  if (!result) throw new Error("UserIndex action-signing keyring is not initialised");
  if (result.signature_version !== 4 || result.purpose !== "action_inbox_deposit") {
    throw new Error("UserIndex returned an incompatible action-signing keyring");
  }
  const keys: RawActionSigningKey[] = result.keys;
  if (!Array.isArray(keys) || keys.length > 3) {
    throw new Error("UserIndex returned an invalid action-signing keyring");
  }

  const allowed = new Set(opts.allowedKeyIds);
  const trusted = new Map<string, { publicKeyPem: string; createdAt: bigint; verifyUntil: bigint | null }>();
  const seen = new Set<string>();
  const now = BigInt(Date.now());
  for (const key of keys) {
    const encodedId = asBytes(key.key_id);
    if (encodedId.length !== 32 || typeof key.public_key_pem !== "string" || typeof key.created_at !== "bigint") {
      throw new Error("UserIndex returned an invalid action-signing key");
    }
    let derivedId: Uint8Array;
    try {
      derivedId = await actionSigningKeyId(key.public_key_pem);
    } catch {
      throw new Error("UserIndex returned an invalid action-signing public key");
    }
    if (!equalBytes(encodedId, derivedId)) {
      throw new Error("UserIndex action-signing key id does not match its public key");
    }
    const id = bytesToHex(encodedId);
    if (seen.has(id)) throw new Error("UserIndex returned a duplicate action-signing key id");
    seen.add(id);

    const staged = hasVariant(key.status, "Staged");
    const active = hasVariant(key.status, "Active");
    const verifyOnly = hasVariant(key.status, "VerifyOnly");
    if (Number(staged) + Number(active) + Number(verifyOnly) !== 1 || !Array.isArray(key.verify_until)) {
      throw new Error("UserIndex returned an invalid action-signing key status");
    }
    if ((staged || active) && key.verify_until.length !== 0) {
      throw new Error("UserIndex returned an invalid action-signing key lifetime");
    }
    if (verifyOnly && (key.verify_until.length !== 1 || typeof key.verify_until[0] !== "bigint")) {
      throw new Error("UserIndex returned an invalid verify-only key lifetime");
    }
    if (verifyOnly && key.verify_until[0]! <= key.created_at) {
      throw new Error("UserIndex returned a verify-only key lifetime before its creation");
    }

    const isCurrentlyVerifiable = active || (verifyOnly && key.verify_until[0]! > now);
    // The resolver permits an empty allowlist only for an exact loopback origin. That local-only
    // development mode trusts the current UserIndex discovery response so freshly recreated local
    // canisters do not require copying a newly generated key id after every reset.
    if (isCurrentlyVerifiable && (allowed.size === 0 || allowed.has(id))) {
      trusted.set(id, {
        publicKeyPem: key.public_key_pem,
        createdAt: key.created_at,
        verifyUntil: verifyOnly ? key.verify_until[0]! : null,
      });
    }
  }
  return trusted;
}

export async function acknowledgeActionInbox(opts: {
  config: ActionInboxConfig;
  throughId: bigint;
  acknowledgementSecret: Uint8Array;
  identity?: Identity;
}): Promise<{ acknowledged: number; remaining: number }> {
  if (opts.acknowledgementSecret.length !== 32) {
    throw new Error("action_inbox acknowledgement secret must be exactly 32 bytes");
  }
  const consumerFingerprint = asBytes(
    opts.config.consumerKeySelector,
    "OpenChat consumer queue selector",
  );
  if (consumerFingerprint.length !== 32) {
    throw new Error("OpenChat consumer queue selector must be exactly 32 bytes");
  }
  const agent = await buildInboxAgent(opts.config.host, opts.identity);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(actionInboxIdlFactory, { agent, canisterId: opts.config.canisterId });
  const request = {
    consumer_key_fingerprint: Array.from(consumerFingerprint),
    consumer_public_key_pem: "",
    through_id: opts.throughId,
    signature: [],
    acknowledgement_secret: [Array.from(opts.acknowledgementSecret)],
  };
  const response = await actor.acknowledge_actions(request);
  if (response?.Success) {
    const acknowledged = Number(response.Success.acknowledged);
    const remaining = Number(response.Success.remaining);
    if ((acknowledged !== 0 && acknowledged !== 1) || !Number.isSafeInteger(remaining) || remaining < 0) {
      throw new Error("action_inbox returned an invalid acknowledgement result");
    }
    return { acknowledged, remaining };
  }
  if (typeof response?.InvalidRequest === "string") {
    throw new Error(`action_inbox rejected acknowledgement: ${response.InvalidRequest}`);
  }
  if ("NotAuthorized" in (response ?? {})) {
    throw new Error("action_inbox did not authorize acknowledgement");
  }
  throw new Error("action_inbox returned an unexpected acknowledgement response");
}

/**
 * Poll the inbox once from zero and return deduplicated, provenance-verified drafts. Envelopes that
 * fail signature, recipient decryption, or any inner/outer commitment check are dropped.
 *
 * Account visibility note: each member polls with ONLY their own key, and a per-user-key app
 * delivers the confirmed action only to the authoritative confirmer. Never poll with another
 * member's key: sharing the user-global consumer key was reviewed and rejected because it leaks
 * that member's OTHER accounts' drafts.
 */
export async function pollActionInbox(opts: {
  config: ActionInboxConfig;
  identity?: Identity;
  maxResults?: number;
  keypair?: ConsumerKeypair;
}): Promise<InboxDraft[]> {
  requireCanonicalCanisterId(opts.config.canisterId, "ActionInbox canister id");
  requireCanonicalCanisterId(opts.config.userIndexCanisterId, "UserIndex canister id");
  if (
    !Number.isSafeInteger(opts.config.appId) ||
    opts.config.appId < 0 ||
    opts.config.appId > 0xffff_ffff
  ) {
    throw new Error("OpenChat app id must be a u32");
  }
  const allowedKeyIds = resolveOpenChatActionSigningKeyIds(opts.config.host, opts.config.signingKeyIds);
  const kp = opts.keypair ?? (await loadOrCreateConsumerKeypair());
  const expectedConsumerFingerprint = asBytes(
    opts.config.consumerKeySelector,
    "OpenChat consumer queue selector",
  );
  if (expectedConsumerFingerprint.length !== 32) {
    throw new Error("OpenChat consumer queue selector must be exactly 32 bytes");
  }
  const agent = await buildInboxAgent(opts.config.host, opts.identity);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(actionInboxIdlFactory, { agent, canisterId: opts.config.canisterId });
  const trustedKeys = await loadTrustedActionSigningKeys({
    agent,
    userIndexCanisterId: opts.config.userIndexCanisterId,
    allowedKeyIds,
  });
  if (trustedKeys.size === 0) {
    throw new Error("UserIndex returned no currently trusted action-signing key");
  }

  const resp = await actor.actions({
    max_results: opts.maxResults ?? 50,
    consumer_key_fingerprint: Array.from(expectedConsumerFingerprint),
    // Re-read the complete replicated page. Signed full-width delivery identities drive durable
    // dedupe; the numeric id is only the exact locator paired with this action's acknowledgement secret.
    since_id: 0n,
  });
  if (!resp?.Success || !Array.isArray(resp.Success.actions)) {
    throw new Error("action_inbox returned an unexpected actions response");
  }
  const stored: RawStoredAction[] = resp.Success.actions;

  const out = new Map<string, InboxDraft>();
  for (const a of stored) {
    const consumerFingerprint = asBytes(a.consumer_key_fingerprint);
    const idempotencyKey = asBytes(a.idempotency_key);
    const payloadHash = asBytes(a.payload_hash);
    const cardContextHash = asBytes(a.card_context_hash);
    const acknowledgementSecretHash = asBytes(a.acknowledgement_secret_hash);
    const signingKeyId = asBytes(a.signing_key_id);
    const signature = asBytes(a.oc_signature);
    const env = {
      ephemeralPublicKey: asBytes(a.ephemeral_public_key),
      ciphertext: asBytes(a.ciphertext),
    };
    if (
      a.signature_version !== 4 ||
      typeof a.app_id !== "number" ||
      !Number.isInteger(a.app_id) ||
      a.app_id < 0 ||
      a.app_id > 0xffff_ffff ||
      a.app_id !== opts.config.appId ||
      typeof a.app_revision !== "bigint" ||
      typeof a.action_id !== "string" ||
      a.action_id.length === 0 ||
      new TextEncoder().encode(a.action_id).length > 0xffff ||
      typeof a.created_at !== "bigint" ||
      consumerFingerprint.length !== 32 ||
      !equalBytes(consumerFingerprint, expectedConsumerFingerprint) ||
      idempotencyKey.length !== 32 ||
      payloadHash.length !== 32 ||
      cardContextHash.length !== 32 ||
      acknowledgementSecretHash.length !== 32 ||
      signingKeyId.length !== 32 ||
      signature.length !== 64 ||
      env.ephemeralPublicKey.length !== 65 ||
      env.ephemeralPublicKey[0] !== 4 ||
      env.ciphertext.length === 0
    ) {
      continue;
    }
    const signingKey = trustedKeys.get(bytesToHex(signingKeyId));
    if (
      !signingKey ||
      a.created_at < signingKey.createdAt ||
      (signingKey.verifyUntil !== null && a.created_at > signingKey.verifyUntil)
    ) {
      continue;
    }

    // Verify the complete outer v4 deposit before attempting recipient decryption.
    const signed = await verifyOpenChatActionSignature(
      {
        keyId: signingKeyId,
        userIndexCanisterId: opts.config.userIndexCanisterId,
        inboxCanisterId: opts.config.canisterId,
        appId: a.app_id,
        appRevision: a.app_revision,
        actionId: a.action_id,
        cardContextHash,
        consumerKeyFingerprint: consumerFingerprint,
        idempotencyKey,
        payloadHash,
        acknowledgementSecretHash,
        envelope: env,
        createdAt: a.created_at,
      },
      signature,
      signingKey.publicKeyPem,
    ).catch(() => false);
    if (!signed) continue;
    try {
      const plaintext = await decryptInboxEnvelope(env, kp.privateKey);
      const { payload, payloadBytes, context, acknowledgementSecret } = parseInboxPlaintext(
        new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
      );
      // On-chain deliveries never accept the parser's local-only wrapperless compatibility path.
      if (!payloadBytes || !context || !acknowledgementSecret) continue;
      const computedPayloadHash = await aiAppCardConfirmPayloadHashV1(payloadBytes);
      if (!equalBytes(computedPayloadHash, payloadHash)) continue;
      if (
        context.appId !== a.app_id ||
        BigInt(context.appRevision) !== a.app_revision ||
        context.actionId !== a.action_id ||
        BigInt(context.confirmedAt) !== a.created_at
      ) {
        continue;
      }
      const [computedContextHash, computedAcknowledgementHash] = await Promise.all([
        actionCardContextHashV2(context, computedPayloadHash),
        acknowledgementSecretHashV1(opts.config.canisterId, consumerFingerprint, acknowledgementSecret),
      ]);
      if (
        !equalBytes(computedContextHash, cardContextHash) ||
        !equalBytes(computedAcknowledgementHash, acknowledgementSecretHash)
      ) {
        continue;
      }
      const deliveryId = bytesToHex(idempotencyKey);
      out.set(deliveryId, {
        id: a.id,
        deliveryId,
        draft: payload,
        created_at: a.created_at,
        context,
        acknowledgementSecret,
      });
    } catch {
      // Not addressed to us (wrong key) or corrupt — skip.
    }
  }
  return [...out.values()];
}

function readEnv(name: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  if (proc?.env && name in proc.env) return proc.env[name];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (import.meta as any).env;
  if (meta && name in meta) return meta[name];
  return undefined;
}

function readActionSigningKeyIdsEnv(): string | undefined {
  // Vite only guarantees static replacement for a literal import.meta.env property access. Keep
  // process.env as the Vitest/Node override, then read the production build value directly.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  if (proc?.env && "VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS" in proc.env) {
    return proc.env.VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS;
  }
  return import.meta.env.VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS as string | undefined;
}

// Cache the manifest-derived inbox route so the 15s poll (and StrictMode double-mounts) don't
// re-query user_index on every tick. The caller-private queue selector is never cached here.
//
// TTL is deliberately SHORT (30s): the inbox_canister_id only changes on a (re)registration, and this
// app busts the cache itself right after it re-registers (invalidateInboxCache below). The TTL is just
// the ceiling for a registration done ELSEWHERE (the CLI, or another device) to take effect — a stale
// resolution otherwise routed the poll at the OLD inbox for up to 5 minutes ("stale-manifest-cache").
const INBOX_TTL_MS = 30 * 1000;
const INBOX_CACHE_MAX = 8;
const inboxCache = new Map<string, { route: RegisteredActionInboxRoute | null; at: number }>();
const inboxInflight = new Map<
  string,
  { generation: number; promise: Promise<RegisteredActionInboxRoute | null> }
>();
let inboxCacheGeneration = 0;

/**
 * Drop the memoized manifest→inbox resolution so the NEXT getActionInboxConfig re-queries user_index.
 * Call this right after (re)registering this app's manifest: the inbox_canister_id may have changed,
 * and without it the app keeps polling the previously-resolved inbox until the TTL lapses.
 */
export function invalidateInboxCache(): void {
  inboxCacheGeneration += 1;
  inboxCache.clear();
  inboxInflight.clear();
}

async function resolveInboxFromManifest(
  host: string,
  userIndexId: string,
): Promise<RegisteredActionInboxRoute | null> {
  const key = `${host}|${userIndexId}`;
  const cached = inboxCache.get(key);
  if (cached && Date.now() - cached.at < INBOX_TTL_MS) {
    return cached.route;
  }
  if (cached) inboxCache.delete(key);
  const generation = inboxCacheGeneration;
  const existing = inboxInflight.get(key);
  if (existing?.generation === generation) return existing.promise;
  const appCanisterId = readEnv("VITE_IOU_BACKEND_CANISTER_ID")?.trim();
  let promise!: Promise<RegisteredActionInboxRoute | null>;
  promise = getRegisteredActionInboxRoute({
    host,
    userIndexCanisterId: userIndexId,
    appName: "iou",
    appCanisterId,
  })
    .then((route) => {
      if (inboxCacheGeneration !== generation) {
        return resolveInboxFromManifest(host, userIndexId);
      }
      inboxCache.delete(key);
      inboxCache.set(key, { route, at: Date.now() });
      if (inboxCache.size > INBOX_CACHE_MAX) {
        const oldest = inboxCache.keys().next().value;
        if (oldest !== undefined) inboxCache.delete(oldest);
      }
      return route;
    })
    .finally(() => {
      const current = inboxInflight.get(key);
      if (current?.generation === generation && current.promise === promise) inboxInflight.delete(key);
    });
  inboxInflight.set(key, { generation, promise });
  return promise;
}

/**
 * Resolve the inbox config from two independent authoritative sources: the public route comes from
 * OpenChat's current manifest, while the opaque HMAC queue selector comes only from this caller's
 * authenticated IOU binding. There is deliberately no env/localStorage selector fallback.
 */
export async function getActionInboxConfig(
  bindingActor: OpenChatBindingReader,
): Promise<ActionInboxConfig | null> {
  const consumerKeySelector = await readOpenChatConsumerQueueSelector(bindingActor);
  if (!consumerKeySelector) return null;
  const host =
    DEV_LAN_QC_IC_ORIGIN ??
    readEnv("VITE_OPENCHAT_HOST") ??
    "http://127.0.0.1:4943";
  const userIndexId = readEnv("VITE_OC_USER_INDEX_CANISTER_ID")?.trim();
  if (!userIndexId) return null;
  const signingKeyIds = resolveOpenChatActionSigningKeyIds(host, readActionSigningKeyIdsEnv());
  let route: RegisteredActionInboxRoute | null = null;
  if (userIndexId) {
    try {
      route = await resolveInboxFromManifest(host, userIndexId);
    } catch {
      /* user_index unreachable — fall back to env below */
      return null;
    }
  }
  if (!route) return null;
  return {
    canisterId: route.canisterId,
    appId: route.appId,
    consumerKeySelector,
    host,
    userIndexCanisterId: userIndexId,
    signingKeyIds,
  };
}
