// Persistent P-256 consumer keypair for the OpenChat on-chain action_inbox.
//
// The PUBLIC key (exported as a SPKI PEM) is what the user registers with OpenChat as the recipient OpenChat
// encrypts confirmed actions to. The PRIVATE key (ECDH) decrypts inbox envelopes locally. The routing
// fingerprint (sha256 of the raw 65-byte point) is what the inbox `actions` replicated update is keyed by.
//
// v1.8.0 (multi-user keys): the keypair is CANISTER-BACKED. The private key is wrapped client-side
// (AES-GCM under a key derived via the SAME vetkd mechanism the sheet keys use — dev sim: the
// self-ECDH user key from devVetkd; prod: vetkd_wrap_consumer_key + @dfinity/vetkeys) and stored on
// the IOU backend via set_consumer_keypair / get_consumer_keypair, so ANY of the user's devices can
// recover it. Production web keeps plaintext only in session memory; native production uses
// platform secure storage. The old localStorage record is read only for an ordered one-time migration
// and removed after recovery is secured. Development deliberately retains principal-scoped
// localStorage so the four isolated local browser profiles remain reproducible across runs.
//
// The exported API is unchanged: loadOrCreateConsumerKeypair() / consumerPublicKeyPem() take no
// arguments. The signed-in identity is injected once per session via configureConsumerKeypairBackend
// (wired from ConsumerKeypairSync, mounted in App). Without a configured identity, only the
// explicit development adapter may use its localStorage-only behavior; production fails closed.

import type { Identity } from "@dfinity/agent";
import { HttpAgent } from "@dfinity/agent";
import { createActor } from "../../backend/declarations";
import { host } from "../auth/config";
import { deriveUserKey, isProdVetkd } from "../crypto/devVetkd";
import { loadOrCreateTransportKey, deriveConsumerWrapKeyProd } from "../crypto/prodVetkd";
import {
  isMobileNative,
  secureDel,
  secureGet,
  secureSet,
} from "../crypto/mobileSecureStorage";
import { scopedStorageKey } from "../storage/scopedStorage";
import { fingerprintPublicKey } from "./actionInboxCrypto";

const LS_KEY_PREFIX = "iou.openchat.consumerKeypair.v2";

function storageKeyForPrincipal(principal: string | null | undefined): string {
  return scopedStorageKey(LS_KEY_PREFIX, principal);
}

// HKDF domain separation for the consumer-keypair wrap (distinct from the
// sheet-key and name-key derivations in devVetkd).
const WRAP_HKDF_SALT = "iou-consumer-wrap-v1";
const WRAP_HKDF_INFO = "iou-consumer-keypair-v1";

function getSubtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("WebCrypto SubtleCrypto is not available");
  return s;
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bin, "binary").toString("base64");
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = typeof atob === "function" ? atob(b64) : Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBuf(b: Uint8Array): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function spkiDerToPem(der: Uint8Array): string {
  const body = bytesToB64(der).match(/.{1,64}/g)?.join("\n") ?? bytesToB64(der);
  return `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
}

type Stored = { privateKeyJwk: JsonWebKey; publicKeySpkiB64: string };

const NATIVE_KEY_PREFIX = "consumer-keypair:v1:";
const memoryCache = new Map<string, Stored>();

function nativeStorageKey(storageKey: string): string {
  return NATIVE_KEY_PREFIX + storageKey;
}

function parseStored(raw: string): Stored {
  if (raw.length > 8_192) throw new Error("consumer keypair record is too large");
  const parsed = JSON.parse(raw) as Partial<Stored>;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !parsed.privateKeyJwk ||
    typeof parsed.privateKeyJwk !== "object" ||
    typeof parsed.publicKeySpkiB64 !== "string" ||
    parsed.publicKeySpkiB64.length > 1_024
  ) {
    throw new Error("invalid consumer keypair record");
  }
  return parsed as Stored;
}

function loadLegacy(storageKey: string): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey);
    return raw ? parseStored(raw) : null;
  } catch {
    return null;
  }
}

function saveDev(storageKey: string, stored: Stored): void {
  try {
    globalThis.localStorage?.setItem(storageKey, JSON.stringify(stored));
  } catch {
    /* non-persistent contexts (e.g. tests) still work for the lifetime of the process */
  }
}

function purgeLegacy(storageKey: string): void {
  try {
    globalThis.localStorage?.removeItem(storageKey);
  } catch {
    /* ignore storage-denied contexts */
  }
}

async function loadLocal(storageKey: string): Promise<Stored | null> {
  const inMemory = memoryCache.get(storageKey);
  if (inMemory) return inMemory;

  if (!isProdVetkd()) {
    const stored = loadLegacy(storageKey);
    if (stored) memoryCache.set(storageKey, stored);
    return stored;
  }

  if (!isMobileNative()) return null;
  const raw = await secureGet(nativeStorageKey(storageKey));
  if (raw === null) return null;
  const stored = parseStored(raw);
  await validateStored(stored);
  memoryCache.set(storageKey, stored);
  return stored;
}

async function persistLocal(storageKey: string, stored: Stored): Promise<void> {
  if (!isProdVetkd()) {
    saveDev(storageKey, stored);
    memoryCache.set(storageKey, stored);
    return;
  }

  if (isMobileNative()) {
    // Persist before memoizing so a locked/unavailable keystore cannot be
    // mistaken for a successful migration by the outer fallback path.
    await secureSet(nativeStorageKey(storageKey), JSON.stringify(stored));
  }
  // Production web intentionally has no durable plaintext device cache.
  memoryCache.set(storageKey, stored);
}

async function generate(): Promise<Stored> {
  const subtle = getSubtle();
  const kp = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const privateKeyJwk = await subtle.exportKey("jwk", kp.privateKey);
  const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  return { privateKeyJwk, publicKeySpkiB64: bytesToB64(spki) };
}

function pemOf(stored: Stored): string {
  return spkiDerToPem(b64ToBytes(stored.publicKeySpkiB64));
}

export type ConsumerKeypair = {
  privateKey: CryptoKey; // ECDH, deriveBits — decrypts inbox envelopes
  publicKey: CryptoKey; // ECDH public
  publicKeySpkiPem: string; // register this with OpenChat as recipient_public_key
  fingerprint: Uint8Array; // sha256(raw point) — the inbox routing key
};

async function importStored(stored: Stored): Promise<ConsumerKeypair> {
  const subtle = getSubtle();
  const privateKey = await subtle.importKey(
    "jwk",
    stored.privateKeyJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const spkiDer = b64ToBytes(stored.publicKeySpkiB64);
  const publicKey = await subtle.importKey("spki", toBuf(spkiDer), { name: "ECDH", namedCurve: "P-256" }, true, []);
  const fingerprint = await fingerprintPublicKey(publicKey);

  return { privateKey, publicKey, publicKeySpkiPem: spkiDerToPem(spkiDer), fingerprint };
}

async function validateStored(stored: Stored): Promise<void> {
  if (
    stored.privateKeyJwk.kty !== "EC" ||
    stored.privateKeyJwk.crv !== "P-256" ||
    typeof stored.privateKeyJwk.d !== "string" ||
    typeof stored.privateKeyJwk.x !== "string" ||
    typeof stored.privateKeyJwk.y !== "string"
  ) {
    throw new Error("invalid consumer private key");
  }
  const imported = await importStored(stored);
  const publicJwk = await getSubtle().exportKey("jwk", imported.publicKey);
  if (
    publicJwk.kty !== "EC" ||
    publicJwk.crv !== "P-256" ||
    publicJwk.x !== stored.privateKeyJwk.x ||
    publicJwk.y !== stored.privateKeyJwk.y
  ) {
    throw new Error("consumer public key does not match its private key");
  }
}

// ─────────────── canister-side wrap / unwrap ───────────────
//
// Wire format mirrors devVetkd's wrapSheetKey: iv (12 bytes) || AES-GCM
// ciphertext. The plaintext is the JSON of `Stored` (private key JWK +
// public SPKI b64), so a successful unwrap round-trips through the same
// import path used by the mode-aware local cache.

async function deriveWrapAesKey(K_wrap: Uint8Array): Promise<CryptoKey> {
  const subtle = getSubtle();
  const base = await subtle.importKey("raw", toBuf(K_wrap), "HKDF", false, ["deriveKey"]);
  return subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toBuf(new TextEncoder().encode(WRAP_HKDF_SALT)),
      info: toBuf(new TextEncoder().encode(WRAP_HKDF_INFO)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function wrapStored(stored: Stored, K_wrap: Uint8Array): Promise<Uint8Array> {
  const subtle = getSubtle();
  const aes = await deriveWrapAesKey(K_wrap);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const pt = new TextEncoder().encode(JSON.stringify(stored));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: toBuf(iv), tagLength: 128 }, aes, toBuf(pt)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

async function unwrapStored(wrapped: Uint8Array, K_wrap: Uint8Array): Promise<Stored> {
  if (wrapped.length < 12 + 16) throw new Error("wrapped consumer keypair blob is too short");
  const subtle = getSubtle();
  const aes = await deriveWrapAesKey(K_wrap);
  const pt = await subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(wrapped.subarray(0, 12)), tagLength: 128 },
    aes,
    toBuf(wrapped.subarray(12)),
  );
  return parseStored(new TextDecoder().decode(new Uint8Array(pt)));
}

// ─────────────── backend session state ───────────────

let backendIdentity: Identity | null = null;
let sessionGeneration = 0;
let inflight: {
  principal: string;
  generation: number;
  promise: Promise<ConsumerKeypair>;
} | null = null;
const clearingStorageKeys = new Set<string>();
const activeSyncsByStorageKey = new Map<string, Set<Promise<ConsumerKeypair>>>();

export type ConsumerKeypairSession = Readonly<{
  principal: string | null;
  generation: number;
}>;

export type ConsumerKeypairClearResult = Readonly<{
  principal: string | null;
  sessionStillCurrent: boolean;
}>;

class NonRecoverableConsumerKeyError extends Error {}

class StaleConsumerKeyEpochError extends NonRecoverableConsumerKeyError {
  readonly expectedEpoch: bigint;
  readonly currentEpoch: bigint;

  constructor(expectedEpoch: bigint, currentEpoch: bigint) {
    super(
      `consumer key changed on another device (expected epoch ${expectedEpoch}, current epoch ${currentEpoch}); retry from the authoritative canister state`,
    );
    this.name = "StaleConsumerKeyEpochError";
    this.expectedEpoch = expectedEpoch;
    this.currentEpoch = currentEpoch;
  }
}

/**
 * Inject (or clear, with null) the signed-in identity so the keypair
 * becomes canister-backed. Wired from ConsumerKeypairSync on every auth
 * change; tests and signed-out sessions never call this and keep the
 * pre-canister localStorage-only behaviour.
 */
export function configureConsumerKeypairBackend(identity: Identity | null): void {
  backendIdentity = identity && !identity.getPrincipal().isAnonymous() ? identity : null;
  sessionGeneration++;
  inflight = null;
  // Do not retain another account's plaintext key material in web memory.
  memoryCache.clear();
}

/**
 * Capture the authenticated consumer-key session before beginning a multi-step
 * flow. Passing an expected principal binds the ticket to the initiating UI.
 */
export function captureConsumerKeypairSession(
  expectedPrincipal?: string | null,
): ConsumerKeypairSession {
  const principal = backendIdentity?.getPrincipal().toText() ?? null;
  if (expectedPrincipal !== undefined && principal !== expectedPrincipal) {
    throw new Error("authentication changed before the consumer-key operation started");
  }
  return Object.freeze({ principal, generation: sessionGeneration });
}

function assertCapturedSession(session: ConsumerKeypairSession): void {
  const current = backendIdentity?.getPrincipal().toText() ?? null;
  if (session.generation !== sessionGeneration || session.principal !== current) {
    throw new Error("authentication changed during the consumer-key operation");
  }
}

function assertCurrentSession(principal: string, generation: number): void {
  const current = backendIdentity?.getPrincipal().toText() ?? null;
  if (generation !== sessionGeneration || current !== principal) {
    throw new Error("authentication changed while loading the consumer keypair");
  }
}

function trackActiveSync(storageKey: string, promise: Promise<ConsumerKeypair>): void {
  let active = activeSyncsByStorageKey.get(storageKey);
  if (!active) {
    active = new Set();
    activeSyncsByStorageKey.set(storageKey, active);
  }
  active.add(promise);
  const untrack = () => {
    const current = activeSyncsByStorageKey.get(storageKey);
    current?.delete(promise);
    if (current?.size === 0) activeSyncsByStorageKey.delete(storageKey);
  };
  void promise.then(untrack, untrack);
}

async function importStoredForSession(
  stored: Stored,
  principal: string,
  generation: number,
): Promise<ConsumerKeypair> {
  assertCurrentSession(principal, generation);
  const imported = await importStored(stored);
  assertCurrentSession(principal, generation);
  return imported;
}

async function wrapStoredForSession(
  stored: Stored,
  K_wrap: Uint8Array,
  principal: string,
  generation: number,
): Promise<Uint8Array> {
  assertCurrentSession(principal, generation);
  const wrapped = await wrapStored(stored, K_wrap);
  assertCurrentSession(principal, generation);
  return wrapped;
}

async function persistLocalForSession(
  storageKey: string,
  stored: Stored,
  principal: string,
  generation: number,
): Promise<void> {
  assertCurrentSession(principal, generation);
  await persistLocal(storageKey, stored);
  assertCurrentSession(principal, generation);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildBackendActor(identity: Identity): Promise<any> {
  // Mirror buildAgent (AuthProvider) without importing the React module:
  // explicit host + AWAITED fetchRootKey (see the SheetKeyContext note on
  // the un-awaited default causing certificate errors).
  const agent = new HttpAgent({ identity, host });
  if (host.includes("127.0.0.1") || host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createActor(agent) as any;
}

/**
 * The 32-byte key the consumer private key is wrapped under. Same vetkd
 * mechanism as the sheet keys:
 *   - dev sim: the self-ECDH per-user key (devVetkd.deriveUserKey — the
 *     key the templates already use). Device-bound, like all dev-sim keys.
 *   - prod: vetkd_wrap_consumer_key + @dfinity/vetkeys — identical on
 *     every device of the same user (the IC vets the unwrap).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function deriveWrapKey(principal: string, actor: any): Promise<Uint8Array> {
  if (isProdVetkd()) {
    const transport = await loadOrCreateTransportKey();
    const masterPubKey = await actor.vetkd_public_key();
    const encVetKey = await actor.vetkd_wrap_consumer_key(Array.from(transport.publicKey));
    return deriveConsumerWrapKeyProd(
      principal,
      transport,
      new Uint8Array(masterPubKey),
      new Uint8Array(encVetKey),
    );
  }
  return deriveUserKey(principal);
}

type RemoteConsumerKeypair = { wrapped_private_key: number[] | Uint8Array; public_key_pem: string };
type RemoteConsumerKeypairState = {
  mutation_epoch: bigint | number;
  keypair: [] | [RemoteConsumerKeypair];
};
type ConsumerKeyMutationResult =
  | { Ok: bigint | number }
  | {
      Err:
        | {
            StaleEpoch: {
              expected_epoch: bigint | number;
              current_epoch: bigint | number;
            };
          }
        | { EpochExhausted: null }
        | { OpenChatBindingKeyMismatch: null };
    };

function asMutationEpoch(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n && value <= 0xffff_ffff_ffff_ffffn) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new NonRecoverableConsumerKeyError("invalid consumer-key mutation epoch from canister");
}

function decodeRemoteState(value: unknown): {
  mutationEpoch: bigint;
  keypair: RemoteConsumerKeypair | null;
} {
  if (!value || typeof value !== "object") {
    throw new NonRecoverableConsumerKeyError("invalid consumer-key state from canister");
  }
  const state = value as Partial<RemoteConsumerKeypairState>;
  if (!Array.isArray(state.keypair) || state.keypair.length > 1) {
    throw new NonRecoverableConsumerKeyError("invalid consumer-key state from canister");
  }
  return {
    mutationEpoch: asMutationEpoch(state.mutation_epoch),
    keypair: state.keypair.length === 1 ? state.keypair[0]! : null,
  };
}

function requireMutationApplied(value: unknown): bigint {
  if (!value || typeof value !== "object") {
    throw new NonRecoverableConsumerKeyError("invalid consumer-key mutation result");
  }
  const result = value as ConsumerKeyMutationResult;
  if ("Ok" in result) return asMutationEpoch(result.Ok);
  if ("Err" in result && result.Err && "StaleEpoch" in result.Err) {
    throw new StaleConsumerKeyEpochError(
      asMutationEpoch(result.Err.StaleEpoch.expected_epoch),
      asMutationEpoch(result.Err.StaleEpoch.current_epoch),
    );
  }
  if ("Err" in result && result.Err && "EpochExhausted" in result.Err) {
    throw new NonRecoverableConsumerKeyError(
      "consumer-key mutation epoch is exhausted; no further mutation is safe",
    );
  }
  if ("Err" in result && result.Err && "OpenChatBindingKeyMismatch" in result.Err) {
    throw new NonRecoverableConsumerKeyError(
      "the linked OpenChat account pins a different delivery key; disconnect or reset the link before replacing it",
    );
  }
  throw new NonRecoverableConsumerKeyError("invalid consumer-key mutation result");
}

async function setRemoteConsumerKeypair(
  actor: any,
  mutationEpoch: bigint,
  wrapped: Uint8Array,
  publicKeyPem: string,
): Promise<bigint> {
  const appliedEpoch = requireMutationApplied(
    await actor.set_consumer_keypair(mutationEpoch, Array.from(wrapped), publicKeyPem),
  );
  if (appliedEpoch !== mutationEpoch + 1n) {
    throw new NonRecoverableConsumerKeyError(
      "canister returned a non-monotonic consumer-key mutation epoch",
    );
  }
  return appliedEpoch;
}

async function syncWithBackend(identity: Identity, generation: number): Promise<ConsumerKeypair> {
  const principal = identity.getPrincipal().toText();
  const storageKey = storageKeyForPrincipal(principal);
  const production = isProdVetkd();
  const cached = await loadLocal(storageKey);
  assertCurrentSession(principal, generation);
  let legacy = production ? loadLegacy(storageKey) : null;
  if (legacy) {
    try {
      await validateStored(legacy);
    } catch {
      // Never use malformed plaintext legacy material. Keep it in place until
      // a remote/new wrapped copy has been secured and the normal purge runs.
      legacy = null;
    }
  }
  const actor = await buildBackendActor(identity);
  assertCurrentSession(principal, generation);
  const K_wrap = await deriveWrapKey(principal, actor);
  assertCurrentSession(principal, generation);

  const remoteState = decodeRemoteState(await actor.get_consumer_keypair());
  assertCurrentSession(principal, generation);
  const remote = remoteState.keypair;
  const mutationEpoch = remoteState.mutationEpoch;

  if (remote) {
    try {
      const stored = await unwrapStored(new Uint8Array(remote.wrapped_private_key), K_wrap);
      await validateStored(stored);
      if (pemOf(stored) !== remote.public_key_pem) {
        throw new Error("wrapped consumer key does not match its public key");
      }
      await persistLocalForSession(storageKey, stored, principal, generation);
      if (production) purgeLegacy(storageKey);
      return await importStoredForSession(stored, principal, generation);
    } catch (cause) {
      assertCurrentSession(principal, generation);
      if (production) {
        // A legacy/secure copy may repair a damaged wrapped blob only when its
        // public key matches the already-registered remote public key. Never
        // replace a remote identity with an unrelated freshly generated key.
        const recovery = cached ?? legacy;
        if (recovery && pemOf(recovery) === remote.public_key_pem) {
          const wrapped = await wrapStoredForSession(recovery, K_wrap, principal, generation);
          await setRemoteConsumerKeypair(actor, mutationEpoch, wrapped, pemOf(recovery));
          assertCurrentSession(principal, generation);
          await persistLocalForSession(storageKey, recovery, principal, generation);
          purgeLegacy(storageKey);
          return importStoredForSession(recovery, principal, generation);
        }
        const error = new NonRecoverableConsumerKeyError(
          "could not recover the production consumer keypair; the remote copy was not replaced",
        );
        (error as Error & { cause?: unknown }).cause = cause;
        throw error;
      }
      if (cached) {
        // Unwrap failed (e.g. dev-sim wrap key differs on this device) but a
        // local keypair exists: keep using it WITHOUT overwriting the
        // canister copy — another device may depend on it.
        console.warn(
          "[consumerKeypair] could not unwrap the canister copy on this device — using the device-cached keypair",
        );
        return importStoredForSession(cached, principal, generation);
      }
      console.warn(
        "[consumerKeypair] could not unwrap the canister copy and no device cache exists — generating a fresh keypair",
      );
      const fresh = await generate();
      await persistLocalForSession(storageKey, fresh, principal, generation);
      const wrapped = await wrapStoredForSession(fresh, K_wrap, principal, generation);
      await setRemoteConsumerKeypair(actor, mutationEpoch, wrapped, pemOf(fresh));
      assertCurrentSession(principal, generation);
      return importStoredForSession(fresh, principal, generation);
    }
  }

  // Nothing on the canister yet: adopt the device-cached keypair when one
  // exists (preserves any registration made with it) else generate, then
  // wrap + upload so every other device can recover it.
  const stored = cached ?? legacy ?? (await generate());
  assertCurrentSession(principal, generation);
  await validateStored(stored);
  assertCurrentSession(principal, generation);
  if (!production) {
    await persistLocalForSession(storageKey, stored, principal, generation);
  }
  const wrapped = await wrapStoredForSession(stored, K_wrap, principal, generation);
  await setRemoteConsumerKeypair(actor, mutationEpoch, wrapped, pemOf(stored));
  assertCurrentSession(principal, generation);
  if (production) {
    await persistLocalForSession(storageKey, stored, principal, generation);
    purgeLegacy(storageKey);
  }
  return importStoredForSession(stored, principal, generation);
}

/**
 * Load the consumer keypair, creating + persisting one on first use.
 * Signed-in production is canister-backed, with session memory on web and
 * native secure storage on mobile. Plaintext localStorage is dev-only.
 */
export async function loadOrCreateConsumerKeypair(
  expectedSession: ConsumerKeypairSession = captureConsumerKeypairSession(),
): Promise<ConsumerKeypair> {
  assertCapturedSession(expectedSession);
  const identity = backendIdentity;
  if (!identity) {
    if (isProdVetkd()) {
      throw new Error(
        "an authenticated identity is required for production consumer keys",
      );
    }
    // Explicit development-only device-local behavior keeps separate browser
    // profiles stable across local replica restarts.
    const storageKey = storageKeyForPrincipal(null);
    if (clearingStorageKeys.has(storageKey)) {
      throw new Error("consumer keypair is being cleared");
    }
    const stored = (await loadLocal(storageKey)) ?? (await generate());
    assertCapturedSession(expectedSession);
    await validateStored(stored);
    assertCapturedSession(expectedSession);
    await persistLocal(storageKey, stored);
    assertCapturedSession(expectedSession);
    const imported = await importStored(stored);
    assertCapturedSession(expectedSession);
    return imported;
  }
  const principal = identity.getPrincipal().toText();
  const generation = expectedSession.generation;
  const storageKey = storageKeyForPrincipal(principal);
  if (clearingStorageKeys.has(storageKey)) {
    throw new Error("consumer keypair is being cleared");
  }
  if (inflight && inflight.principal === principal && inflight.generation === generation) {
    return inflight.promise;
  }
  const promise: Promise<ConsumerKeypair> = syncWithBackend(identity, generation).catch(async (e) => {
    // Let a later call retry the sync (but never clobber a newer session's memo).
    if (inflight && inflight.promise === promise) inflight = null;
    assertCurrentSession(principal, generation);
    if (e instanceof NonRecoverableConsumerKeyError) throw e;
    const cached = await loadLocal(storageKey);
    assertCurrentSession(principal, generation);
    if (cached) {
      console.warn("[consumerKeypair] canister sync failed — using the secure/session keypair:", e);
      return importStoredForSession(cached, principal, generation);
    }
    throw e;
  });
  inflight = { principal, generation, promise };
  trackActiveSync(storageKey, promise);
  return promise;
}

/** Convenience: the SPKI PEM to register with OpenChat. */
export async function consumerPublicKeyPem(
  expectedSession: ConsumerKeypairSession = captureConsumerKeypairSession(),
): Promise<string> {
  return (await loadOrCreateConsumerKeypair(expectedSession)).publicKeySpkiPem;
}

// NOTE (v1.11.0 design decision): do NOT add helpers that wrap this keypair
// under a SHARED key (e.g. K_sheet). The consumer keypair is user-global —
// sharing it with a co-member leaks the sharer's OTHER accounts' OpenChat
// drafts (adversarially reviewed, medium severity). Shared-account visibility
// is solved delivery-side instead: OpenChat fans out each confirmed action to
// every chat member's OWN registered key.

/**
 * Sign OpenChat's canonical revoke challenge with the consumer PRIVATE key. The browser sends the
 * proof to the signed-in IOU backend; only IOU's registered app canister calls
 * revoke_ai_app_user_key to drop the matching public key. The stored JWK was generated for ECDH
 * (deriveBits), but the same P-256 point is a valid ECDSA key: we re-import a usage-stripped clone
 * for signing (the ECDH CryptoKey in memory is non-extractable and usage-locked, so we go back to
 * the stored JWK). WebCrypto returns a raw 64-byte r||s signature — exactly what the canister's
 * `Signature::from_slice` expects, no DER unwrap. Only the public key + this signature ever leave
 * the device; the private key is never exported beyond this local re-import, so E2E is preserved.
 */
export async function signRevokeChallenge(
  preimage: Uint8Array,
  expectedSession: ConsumerKeypairSession = captureConsumerKeypairSession(),
): Promise<Uint8Array> {
  assertCapturedSession(expectedSession);
  const principal = expectedSession.principal;
  const storageKey = storageKeyForPrincipal(principal);
  const stored = await loadLocal(storageKey);
  assertCapturedSession(expectedSession);
  if (!stored) throw new Error("no consumer keypair available to sign the revoke challenge");
  const subtle = getSubtle();
  // Clone + strip usage metadata so WebCrypto accepts the ECDH-generated JWK as an ECDSA sign key.
  const jwk: JsonWebKey = { ...stored.privateKeyJwk };
  delete jwk.key_ops;
  delete (jwk as { use?: string }).use;
  delete (jwk as { alg?: string }).alg;
  const signKey = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  assertCapturedSession(expectedSession);
  const sig = await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, toBuf(preimage));
  assertCapturedSession(expectedSession);
  return new Uint8Array(sig);
}

const MAX_DELETE_EPOCH_RETRIES = 8;

async function deleteRemoteConsumerKeypair(actor: any): Promise<bigint> {
  let lastConflict: StaleConsumerKeyEpochError | null = null;
  for (let attempt = 0; attempt < MAX_DELETE_EPOCH_RETRIES; attempt++) {
    const { mutationEpoch } = decodeRemoteState(await actor.get_consumer_keypair());
    try {
      const appliedEpoch = requireMutationApplied(
        await actor.delete_consumer_keypair(mutationEpoch),
      );
      if (appliedEpoch !== mutationEpoch + 1n) {
        throw new NonRecoverableConsumerKeyError(
          "canister returned a non-monotonic consumer-key mutation epoch",
        );
      }
      return appliedEpoch;
    } catch (cause) {
      if (!(cause instanceof StaleConsumerKeyEpochError)) throw cause;
      // Another device won after our query. Re-read the canister-owned epoch
      // and make disconnect the final accepted mutation. The bounded retry is
      // a liveness guard against a continuously mutating compromised peer.
      lastConflict = cause;
    }
  }
  throw new NonRecoverableConsumerKeyError(
    `consumer key kept changing during disconnect; retry (${lastConflict?.message ?? "epoch conflict"})`,
  );
}

/**
 * clearConsumerKeypair deletes the canister-backed wrapped keypair and device cache. The normal UI
 * invokes it only after IOU's coordinated C2C disconnect returned Success/KeyNotFound. The raw
 * backend delete remains an explicit availability escape hatch when OpenChat is unreachable; that
 * emergency path removes the IOU binding but can leave an unusable public key in OpenChat.
 * Reconnecting later generates a fresh keypair and goes through the normal claim-token flow.
 */
export async function clearConsumerKeypair(
  expectedSession: ConsumerKeypairSession,
): Promise<ConsumerKeypairClearResult> {
  assertCapturedSession(expectedSession);
  const identity = backendIdentity;
  const principal = identity?.getPrincipal().toText() ?? null;
  const storageKey = storageKeyForPrincipal(principal);
  if (clearingStorageKeys.has(storageKey)) {
    throw new Error("consumer keypair is already being cleared");
  }
  clearingStorageKeys.add(storageKey);
  const pendingSyncs = [...(activeSyncsByStorageKey.get(storageKey) ?? [])];
  sessionGeneration++;
  const clearingGeneration = sessionGeneration;
  inflight = null; // drop any memoized sync — the next load must not resurrect the old keypair
  memoryCache.delete(storageKey);
  purgeLegacy(storageKey);
  let failure: unknown;
  try {
    // A sync which already passed the clearing check may still be uploading.
    // Let that mutation settle first, then make deletion the final canister write.
    await Promise.allSettled(pendingSyncs);
    if (isProdVetkd() && isMobileNative()) {
      try {
        await secureDel(nativeStorageKey(storageKey));
      } catch (cause) {
        failure = cause;
      }
    }
    if (identity) {
      try {
        const actor = await buildBackendActor(identity);
        await deleteRemoteConsumerKeypair(actor);
      } catch (cause) {
        failure ??= cause;
      }
    }
  } finally {
    memoryCache.delete(storageKey);
    purgeLegacy(storageKey);
    try {
      if (isProdVetkd() && isMobileNative()) {
        await secureDel(nativeStorageKey(storageKey));
      }
    } catch (cause) {
      failure ??= cause;
    } finally {
      clearingStorageKeys.delete(storageKey);
    }
  }
  if (failure) throw failure;
  const currentPrincipal = backendIdentity?.getPrincipal().toText() ?? null;
  return {
    principal,
    sessionStillCurrent:
      currentPrincipal === principal && sessionGeneration === clearingGeneration,
  };
}

export const __testing = {
  storageKeyForPrincipal,
};
