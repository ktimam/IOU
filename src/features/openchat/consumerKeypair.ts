// Persistent P-256 consumer keypair for the OpenChat on-chain action_inbox.
//
// The PUBLIC key (exported as a SPKI PEM) is what the user registers with OpenChat as the recipient OpenChat
// encrypts confirmed actions to. The PRIVATE key (ECDH) decrypts inbox envelopes locally. The routing
// fingerprint (sha256 of the raw 65-byte point) is what the inbox `actions` query is keyed by.
//
// v1.8.0 (multi-user keys): the keypair is CANISTER-BACKED. The private key is wrapped client-side
// (AES-GCM under a key derived via the SAME vetkd mechanism the sheet keys use — dev sim: the
// self-ECDH user key from devVetkd; prod: vetkd_wrap_consumer_key + @dfinity/vetkeys) and stored on
// the IOU backend via set_consumer_keypair / get_consumer_keypair, so ANY of the user's devices can
// recover it. localStorage is now only a device cache (same key as before, so existing single-device
// keypairs are adopted and uploaded on first sync instead of being regenerated).
//
// The exported API is unchanged: loadOrCreateConsumerKeypair() / consumerPublicKeyPem() take no
// arguments. The signed-in identity is injected once per session via configureConsumerKeypairBackend
// (wired from ConsumerKeypairSync, mounted in App). Without a configured identity (signed out,
// tests, Node) the module behaves exactly like the pre-canister version: localStorage only.

import type { Identity } from "@dfinity/agent";
import { HttpAgent } from "@dfinity/agent";
import { createActor } from "../../backend/declarations";
import { host } from "../auth/config";
import { deriveUserKey, isProdVetkd } from "../crypto/devVetkd";
import { loadOrCreateTransportKey, deriveConsumerWrapKeyProd } from "../crypto/prodVetkd";
import { fingerprintPublicKey } from "./actionInboxCrypto";

const LS_KEY = "iou.openchat.consumerKeypair.v1";

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

function load(): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function save(stored: Stored): void {
  try {
    globalThis.localStorage?.setItem(LS_KEY, JSON.stringify(stored));
  } catch {
    /* non-persistent contexts (e.g. tests) still work for the lifetime of the process */
  }
}

async function generate(): Promise<Stored> {
  const subtle = getSubtle();
  const kp = (await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const privateKeyJwk = await subtle.exportKey("jwk", kp.privateKey);
  const spki = new Uint8Array(await subtle.exportKey("spki", kp.publicKey));
  const stored: Stored = { privateKeyJwk, publicKeySpkiB64: bytesToB64(spki) };
  save(stored);
  return stored;
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

// ─────────────── canister-side wrap / unwrap ───────────────
//
// Wire format mirrors devVetkd's wrapSheetKey: iv (12 bytes) || AES-GCM
// ciphertext. The plaintext is the JSON of `Stored` (private key JWK +
// public SPKI b64), so a successful unwrap round-trips through the same
// import path the localStorage cache uses.

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
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as Stored;
}

// ─────────────── backend session state ───────────────

let backendIdentity: Identity | null = null;
let inflight: { principal: string; promise: Promise<ConsumerKeypair> } | null = null;

/**
 * Inject (or clear, with null) the signed-in identity so the keypair
 * becomes canister-backed. Wired from ConsumerKeypairSync on every auth
 * change; tests and signed-out sessions never call this and keep the
 * pre-canister localStorage-only behaviour.
 */
export function configureConsumerKeypairBackend(identity: Identity | null): void {
  backendIdentity = identity && !identity.getPrincipal().isAnonymous() ? identity : null;
  inflight = null;
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

async function syncWithBackend(identity: Identity): Promise<ConsumerKeypair> {
  const principal = identity.getPrincipal().toText();
  const actor = await buildBackendActor(identity);
  const K_wrap = await deriveWrapKey(principal, actor);

  const remoteOpt = (await actor.get_consumer_keypair()) as [] | [RemoteConsumerKeypair];
  const remote = Array.isArray(remoteOpt) && remoteOpt.length ? remoteOpt[0] : null;

  if (remote) {
    try {
      const stored = await unwrapStored(new Uint8Array(remote.wrapped_private_key), K_wrap);
      save(stored); // refresh the device cache
      return await importStored(stored);
    } catch {
      const cached = load();
      if (cached) {
        // Unwrap failed (e.g. dev-sim wrap key differs on this device) but a
        // local keypair exists: keep using it WITHOUT overwriting the
        // canister copy — another device may depend on it.
        console.warn(
          "[consumerKeypair] could not unwrap the canister copy on this device — using the device-cached keypair",
        );
        return importStored(cached);
      }
      console.warn(
        "[consumerKeypair] could not unwrap the canister copy and no device cache exists — generating a fresh keypair",
      );
      const fresh = await generate();
      await actor.set_consumer_keypair(Array.from(await wrapStored(fresh, K_wrap)), pemOf(fresh));
      return importStored(fresh);
    }
  }

  // Nothing on the canister yet: adopt the device-cached keypair when one
  // exists (preserves any registration made with it) else generate, then
  // wrap + upload so every other device can recover it.
  const stored = load() ?? (await generate());
  await actor.set_consumer_keypair(Array.from(await wrapStored(stored, K_wrap)), pemOf(stored));
  return importStored(stored);
}

/**
 * Load the consumer keypair, creating + persisting one on first use.
 * Canister-backed when a signed-in identity was injected (the canister
 * copy wins; localStorage is a cache); pure-localStorage otherwise.
 */
export async function loadOrCreateConsumerKeypair(): Promise<ConsumerKeypair> {
  const identity = backendIdentity;
  if (!identity) {
    // Device-local fallback — exactly the pre-canister behaviour.
    return importStored(load() ?? (await generate()));
  }
  const principal = identity.getPrincipal().toText();
  if (inflight && inflight.principal === principal) return inflight.promise;
  const promise: Promise<ConsumerKeypair> = syncWithBackend(identity).catch(async (e) => {
    // Let a later call retry the sync (but never clobber a newer session's memo).
    if (inflight && inflight.promise === promise) inflight = null;
    const cached = load();
    if (cached) {
      console.warn("[consumerKeypair] canister sync failed — using the device-cached keypair:", e);
      return importStored(cached);
    }
    throw e;
  });
  inflight = { principal, promise };
  return promise;
}

/** Convenience: the SPKI PEM to register with OpenChat. */
export async function consumerPublicKeyPem(): Promise<string> {
  return (await loadOrCreateConsumerKeypair()).publicKeySpkiPem;
}
