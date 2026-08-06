// Consumer keypair: generation + device cache, fingerprint definition, the four
// canister-sync branches (adopt-and-upload / recover-from-canister /
// unwrappable-but-cached / unwrappable-regenerate), clear, and the revoke
// challenge signature. The IOU backend actor is mocked with an in-memory store;
// the dev wrap key (devVetkd self-ECDH) is real and device-bound, so preserving
// the dev keypair in localStorage emulates "another device of the same user".

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Identity } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";

// In-memory canister store shared with the mocked backend actor.
const s = vi.hoisted(() => ({
  remote: null as null | { wrapped_private_key: number[] | Uint8Array; public_key_pem: string },
  epoch: 0n,
  setCalls: [] as string[], // pems passed to set_consumer_keypair
  deleteCalls: 0,
  getCalls: 0,
  getGate: null as Promise<void> | null,
  bindingKeyMismatch: false,
}));

vi.mock("../../backend/declarations", () => ({
  createActor: () => ({
    get_consumer_keypair: async () => {
      s.getCalls++;
      if (s.getGate) await s.getGate;
      return { mutation_epoch: s.epoch, keypair: s.remote ? [s.remote] : [] };
    },
    set_consumer_keypair: async (expected: bigint, wrapped: number[], pem: string) => {
      if (s.bindingKeyMismatch) {
        return { Err: { OpenChatBindingKeyMismatch: null } };
      }
      if (expected !== s.epoch) {
        return {
          Err: { StaleEpoch: { expected_epoch: expected, current_epoch: s.epoch } },
        };
      }
      s.epoch++;
      s.remote = { wrapped_private_key: wrapped, public_key_pem: pem };
      s.setCalls.push(pem);
      return { Ok: s.epoch };
    },
    delete_consumer_keypair: async (expected: bigint) => {
      if (expected !== s.epoch) {
        return {
          Err: { StaleEpoch: { expected_epoch: expected, current_epoch: s.epoch } },
        };
      }
      s.epoch++;
      s.remote = null;
      s.deleteCalls++;
      return { Ok: s.epoch };
    },
  }),
}));

vi.mock("@dfinity/agent", async (importOriginal) => ({
  ...(await importOriginal()),
  HttpAgent: class {
    async fetchRootKey() {
      return new Uint8Array();
    }
  },
}));

vi.mock("../auth/config", () => ({
  host: "http://127.0.0.1:8080",
  canisterId: "test-iou-backend",
}));

// Simple in-process localStorage so both the consumer cache and the devVetkd
// dev keypair persist within a test (and can be selectively cleared).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

import {
  loadOrCreateConsumerKeypair,
  consumerPublicKeyPem,
  configureConsumerKeypairBackend,
  clearConsumerKeypair,
  captureConsumerKeypairSession,
  signRevokeChallenge,
  __testing as consumerKeypairTesting,
} from "./consumerKeypair";
import { keyFingerprint, __testing } from "./actionInboxCrypto";

const identity = { getPrincipal: () => Principal.fromText("aaaaa-aa") } as unknown as Identity;
const otherIdentity = {
  getPrincipal: () => Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai"),
} as unknown as Identity;
const ANONYMOUS_KEY = consumerKeypairTesting.storageKeyForPrincipal(null);
const IDENTITY_KEY = consumerKeypairTesting.storageKeyForPrincipal(
  identity.getPrincipal().toText(),
);

beforeEach(() => {
  store.clear();
  s.remote = null;
  s.epoch = 0n;
  s.setCalls = [];
  s.deleteCalls = 0;
  s.getCalls = 0;
  s.getGate = null;
  s.bindingKeyMismatch = false;
  configureConsumerKeypairBackend(null);
});

describe("consumerKeypair account isolation", () => {
  it("does not adopt another principal's device cache when the backend has no key", async () => {
    configureConsumerKeypairBackend(identity);
    const first = await loadOrCreateConsumerKeypair();

    // Reproduce account switching in one browser profile. The second principal has no
    // canister key yet, so a browser-global cache would silently upload the first user's key.
    s.remote = null;
    configureConsumerKeypairBackend(otherIdentity);
    const second = await loadOrCreateConsumerKeypair();

    expect(second.publicKeySpkiPem).not.toBe(first.publicKeySpkiPem);
  });

  it("does not expose the previous principal's key after an authenticated-to-anonymous transition", async () => {
    configureConsumerKeypairBackend(identity);
    const authenticated = await loadOrCreateConsumerKeypair();

    configureConsumerKeypairBackend(null);
    const anonymous = await loadOrCreateConsumerKeypair();

    expect(anonymous.publicKeySpkiPem).not.toBe(authenticated.publicKeySpkiPem);
  });

  it("rejects an in-flight load when authentication changes", async () => {
    let release!: () => void;
    s.getGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    configureConsumerKeypairBackend(identity);
    const pending = loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(s.getCalls).toBe(1));

    configureConsumerKeypairBackend(otherIdentity);
    release();

    await expect(pending).rejects.toThrow(/authentication changed/);
  });
});

describe("consumerKeypair — device-local (no backend)", () => {
  it("generates once and returns the same keypair on the next load (device cache)", async () => {
    const a = await loadOrCreateConsumerKeypair();
    const b = await loadOrCreateConsumerKeypair();
    expect(a.publicKeySpkiPem).toBe(b.publicKeySpkiPem);
    expect(store.has(ANONYMOUS_KEY)).toBe(true);
    expect(s.setCalls).toHaveLength(0); // no backend configured → no upload
  });

  it("defines the fingerprint as sha256 of the uncompressed SEC1 point (== keyFingerprint of the PEM)", async () => {
    const kp = await loadOrCreateConsumerKeypair();
    expect(kp.fingerprint.length).toBe(32);
    const fromPem = await keyFingerprint(kp.publicKeySpkiPem);
    expect(Array.from(kp.fingerprint)).toEqual(Array.from(fromPem));
  });
});

describe("consumerKeypair — canister sync branches", () => {
  it("adopt-and-upload: nothing on canister → uploads the (generated) keypair", async () => {
    configureConsumerKeypairBackend(identity);
    const kp = await loadOrCreateConsumerKeypair();
    expect(s.setCalls).toEqual([kp.publicKeySpkiPem]); // uploaded exactly once
    expect(s.remote?.public_key_pem).toBe(kp.publicKeySpkiPem);
  });

  it("fails closed when an OpenChat binding pins a different backend key", async () => {
    s.bindingKeyMismatch = true;
    configureConsumerKeypairBackend(identity);

    await expect(loadOrCreateConsumerKeypair()).rejects.toThrow(
      /linked OpenChat account pins a different delivery key/i,
    );
    expect(s.remote).toBeNull();
    expect(s.setCalls).toHaveLength(0);
  });

  it("recover-from-canister: a second device with the same wrap key unwraps the canister copy (no re-upload)", async () => {
    configureConsumerKeypairBackend(identity);
    const first = await loadOrCreateConsumerKeypair(); // generates + uploads
    expect(s.setCalls).toHaveLength(1);

    // Emulate another device of the same user: drop the consumer cache but keep the dev wrap key.
    store.delete(IDENTITY_KEY);
    configureConsumerKeypairBackend(identity); // reset the in-flight memo → force a fresh sync
    const second = await loadOrCreateConsumerKeypair();

    expect(second.publicKeySpkiPem).toBe(first.publicKeySpkiPem); // recovered, identical key
    expect(s.setCalls).toHaveLength(1); // NOT re-uploaded
    expect(store.has(IDENTITY_KEY)).toBe(true); // cache refreshed
  });

  it("unwrappable-but-cached: a corrupt canister copy falls back to the device cache without overwriting it", async () => {
    // Seed a valid cache for this principal.
    configureConsumerKeypairBackend(identity);
    const cached = await loadOrCreateConsumerKeypair();
    s.setCalls = [];
    // Canister holds garbage (unwrap will fail under our wrap key).
    s.remote = { wrapped_private_key: new Array(40).fill(0), public_key_pem: "garbage-pem" };
    configureConsumerKeypairBackend(identity);

    const kp = await loadOrCreateConsumerKeypair();
    expect(kp.publicKeySpkiPem).toBe(cached.publicKeySpkiPem); // used the cache
    expect(s.setCalls).toHaveLength(0); // did NOT overwrite the canister copy
    expect(s.deleteCalls).toBe(0);
  });

  it("unwrappable-regenerate: a corrupt canister copy AND no cache → regenerate + upload", async () => {
    s.remote = { wrapped_private_key: new Array(40).fill(0), public_key_pem: "garbage-pem" };
    // No consumer cache in localStorage, but keep a dev wrap key so wrapping succeeds.
    configureConsumerKeypairBackend(identity);

    const kp = await loadOrCreateConsumerKeypair();
    expect(kp.publicKeySpkiPem).not.toBe("garbage-pem");
    expect(s.setCalls).toEqual([kp.publicKeySpkiPem]); // fresh key uploaded
  });
});

describe("consumerKeypair — clear + revoke signing", () => {
  it("clearConsumerKeypair deletes the canister copy and the device cache", async () => {
    configureConsumerKeypairBackend(identity);
    await loadOrCreateConsumerKeypair();
    expect(store.has(IDENTITY_KEY)).toBe(true);
    await clearConsumerKeypair(captureConsumerKeypairSession(identity.getPrincipal().toText()));
    expect(store.has(IDENTITY_KEY)).toBe(false);
    expect(s.deleteCalls).toBe(1);
  });

  it("signRevokeChallenge produces a signature the registered public key verifies (proof of possession)", async () => {
    const pem = await consumerPublicKeyPem(); // creates + caches the keypair
    const preimage = new TextEncoder().encode("oc-revoke-challenge-test");
    const sig = await signRevokeChallenge(preimage);
    expect(sig.length).toBe(64); // raw r‖s, no DER

    // The same P-256 point re-imported as an ECDSA verify key must accept the signature.
    const spkiDer = __testing.pemToDer(pem);
    const verifyKey = await globalThis.crypto.subtle.importKey(
      "spki",
      spkiDer.buffer.slice(spkiDer.byteOffset, spkiDer.byteOffset + spkiDer.byteLength) as ArrayBuffer,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const okSig = await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength) as ArrayBuffer,
      preimage.buffer.slice(0) as ArrayBuffer,
    );
    expect(okSig).toBe(true);
  });

  it("signRevokeChallenge throws when no keypair exists", async () => {
    store.delete(ANONYMOUS_KEY);
    await expect(signRevokeChallenge(new Uint8Array([1, 2, 3]))).rejects.toThrow(/no consumer keypair/);
  });
});
