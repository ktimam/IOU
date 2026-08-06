import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Principal } from "@dfinity/principal";
import type { OpenChatBindingWire } from "./disconnectOpenChat";
import {
  actionCardContextHashV2,
  sha256,
  signingPreimageV4,
  type ActionSignatureContextV4,
} from "./actionInboxCrypto";
import {
  buildStoredAction,
  bytesToHex,
  generateConsumerKeys,
  generateOcSigner,
  TEST_INBOX_CANISTER_ID,
  TEST_CONSUMER_QUEUE_SELECTOR,
  TEST_USER_INDEX_CANISTER_ID,
  testContext,
  type OcSigner,
  type StoredActionLike,
} from "./ecTestKit";

const h = vi.hoisted(() => ({
  inboxActor: null as unknown as Record<string, (...args: unknown[]) => unknown>,
  userIndexActor: null as unknown as Record<string, (...args: unknown[]) => unknown>,
  resolveInbox: null as unknown as (
    opts: unknown,
  ) => Promise<{ canisterId: string; appId: number; appRevision: bigint } | null>,
}));

vi.mock("@dfinity/agent", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    HttpAgent: class {
      async fetchRootKey() {
        return new Uint8Array();
      }
    },
    Actor: {
      createActor: (_factory: unknown, options: { canisterId: string }) =>
        options.canisterId === TEST_INBOX_CANISTER_ID ? h.inboxActor : h.userIndexActor,
    },
  };
});

vi.mock("./consumerKeypair", () => ({
  loadOrCreateConsumerKeypair: async () => {
    throw new Error("loadOrCreateConsumerKeypair should not be called with an explicit test keypair");
  },
}));

vi.mock("./registerAiApp", () => ({
  getRegisteredActionInboxRoute: (opts: unknown) => h.resolveInbox(opts),
}));

import {
  acknowledgeActionInbox,
  getActionInboxConfig,
  invalidateInboxCache,
  pollActionInbox,
  resolveOpenChatActionSigningKeyIds,
  type ActionInboxConfig,
} from "./actionInboxClient";

const LOCAL_CONFIG: ActionInboxConfig = {
  canisterId: TEST_INBOX_CANISTER_ID,
  appId: 7,
  consumerKeySelector: TEST_CONSUMER_QUEUE_SELECTOR,
  userIndexCanisterId: TEST_USER_INDEX_CANISTER_ID,
  host: "http://127.0.0.1:8080",
  signingKeyIds: [],
};

const principal = (...bytes: number[]) =>
  Principal.fromUint8Array(Uint8Array.from(bytes));
const BINDING_ACTOR = {
  get_openchat_binding: async (): Promise<[] | [OpenChatBindingWire]> =>
    [{
      iou_principal: principal(10, 1),
      user_index_canister_id: Principal.fromText(TEST_USER_INDEX_CANISTER_ID),
      app_id: 7,
      app_revision: 3n,
      app_canister_id: principal(10, 2),
      key_version: 1n,
      app_subject: new Uint8Array(32).fill(1),
      subject_version: 1,
      consumer_queue_selector: TEST_CONSUMER_QUEUE_SELECTOR,
      consumer_queue_selector_version: 1,
      linked_at: 1n,
    }],
};

const route = (canisterId = TEST_INBOX_CANISTER_ID) => ({
  canisterId,
  appId: 7,
  appRevision: 3n,
});

function configFor(signer: OcSigner, host = LOCAL_CONFIG.host): ActionInboxConfig {
  return { ...LOCAL_CONFIG, host, signingKeyIds: [bytesToHex(signer.keyId)] };
}

function keyringActor(
  signer: OcSigner,
  options: {
    encodedKeyId?: Uint8Array;
    status?: { Staged?: null; Active?: null; VerifyOnly?: null };
    createdAt?: bigint;
    verifyUntil?: [] | [bigint];
    signatureVersion?: number;
    purpose?: string;
    extraKeys?: unknown[];
  } = {},
) {
  return {
    action_signing_keys: () => ({
      Success: {
        signature_version: options.signatureVersion ?? 4,
        purpose: options.purpose ?? "action_inbox_deposit",
        keys: [
          {
            key_id: Array.from(options.encodedKeyId ?? signer.keyId),
            public_key_pem: signer.publicKeyPem,
            status: options.status ?? { Active: null },
            created_at: options.createdAt ?? 0n,
            verify_until: options.verifyUntil ?? [],
          },
          ...(options.extraKeys ?? []),
        ],
      },
    }),
  };
}

function inboxActor(actions: StoredActionLike[], onArgs?: (args: unknown) => void) {
  return {
    actions: (args: unknown) => {
      onArgs?.(args);
      return { Success: { actions } };
    },
  };
}

function signatureContext(action: StoredActionLike): ActionSignatureContextV4 {
  return {
    keyId: Uint8Array.from(action.signing_key_id),
    userIndexCanisterId: TEST_USER_INDEX_CANISTER_ID,
    inboxCanisterId: TEST_INBOX_CANISTER_ID,
    appId: action.app_id,
    appRevision: action.app_revision,
    actionId: action.action_id,
    cardContextHash: Uint8Array.from(action.card_context_hash),
    consumerKeyFingerprint: Uint8Array.from(action.consumer_key_fingerprint),
    idempotencyKey: Uint8Array.from(action.idempotency_key),
    payloadHash: Uint8Array.from(action.payload_hash),
    acknowledgementSecretHash: Uint8Array.from(action.acknowledgement_secret_hash),
    envelope: {
      ephemeralPublicKey: Uint8Array.from(action.ephemeral_public_key),
      ciphertext: Uint8Array.from(action.ciphertext),
    },
    createdAt: action.created_at,
  };
}

async function resign(action: StoredActionLike, signer: OcSigner): Promise<void> {
  action.oc_signature = Array.from(await signer.sign(signingPreimageV4(signatureContext(action))));
}

describe("independently provisioned UserIndex signing-key ids", () => {
  it.each(["http://localhost:8080", "https://127.0.0.1:4943", "http://[::1]:8080"])(
    "allows an empty list only for an exact loopback origin (%s)",
    (host) => expect(resolveOpenChatActionSigningKeyIds(host, undefined)).toEqual([]),
  );

  it("requires at least one key id for remote hosts and rejects loopback lookalikes", () => {
    for (const host of [
      "https://oc.example",
      "https://localhost.evil.example",
      "https://127.0.0.1.evil.example",
      "https://localhost.example",
    ]) {
      expect(() => resolveOpenChatActionSigningKeyIds(host, undefined)).toThrow(/key.ids.*required/i);
    }
    for (const host of ["http://localhost.evil.example", "http://127.0.0.1.evil.example"]) {
      expect(() => resolveOpenChatActionSigningKeyIds(host, undefined)).toThrow(/must use HTTPS/i);
    }
  });

  it.each([
    "localhost:8080",
    "not a url",
    "ftp://localhost",
    "file:///localhost",
    "http://user@localhost:8080",
    "http://localhost@evil.example",
    "http://localhost:8080/path",
    " http://localhost:8080",
    "http://oc.example",
  ])("rejects a malformed or non-origin host (%s)", (host) => {
    expect(() => resolveOpenChatActionSigningKeyIds(host, "a".repeat(64))).toThrow(/OpenChat host/i);
  });

  it("canonicalizes one to three unique hexadecimal ids and rejects malformed lists", () => {
    expect(resolveOpenChatActionSigningKeyIds("https://oc.example", `Aa${"b".repeat(62)}`)).toEqual([
      `aa${"b".repeat(62)}`,
    ]);
    expect(
      resolveOpenChatActionSigningKeyIds("https://oc.example", ["a".repeat(64), "b".repeat(64)]),
    ).toEqual(["a".repeat(64), "b".repeat(64)]);
    for (const invalid of [
      "",
      "a".repeat(63),
      "g".repeat(64),
      ` ${"a".repeat(64)}`,
      `${"a".repeat(64)},${"a".repeat(64)}`,
      `${"a".repeat(64)},${"b".repeat(64)},${"c".repeat(64)},${"d".repeat(64)}`,
    ]) {
      expect(() => resolveOpenChatActionSigningKeyIds("https://oc.example", invalid)).toThrow();
    }
  });

  it("rejects a key-id/public-key substitution before querying the inbox", async () => {
    const recipient = await generateConsumerKeys();
    const pinned = await generateOcSigner();
    const substituted = await generateOcSigner();
    const actions = vi.fn(() => ({ Success: { actions: [] } }));
    h.userIndexActor = keyringActor(substituted, { encodedKeyId: pinned.keyId });
    h.inboxActor = { actions };
    await expect(
      pollActionInbox({
        config: configFor(pinned, "https://oc.example"),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).rejects.toThrow(/key id does not match/i);
    expect(actions).not.toHaveBeenCalled();
  });

  it("accepts only pinned active or unexpired verify-only keys within their signed timestamp window", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const now = BigInt(Date.now());
    const actionCreatedAt = now - 60_000n;
    const verifyUntil = now + 60_000n;
    const action = await buildStoredAction({ id: 1n, createdAt: actionCreatedAt, recipient, signer });
    h.inboxActor = inboxActor([action]);

    h.userIndexActor = keyringActor(signer, { status: { Staged: null } });
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).rejects.toThrow(/no currently trusted/i);

    h.userIndexActor = keyringActor(signer, {
      status: { VerifyOnly: null },
      verifyUntil: [BigInt(Date.now())],
    });
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).rejects.toThrow(/no currently trusted/i);

    h.userIndexActor = keyringActor(signer, {
      status: { VerifyOnly: null },
      verifyUntil: [verifyUntil],
    });
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 1n })]);

    const atCutoff = await buildStoredAction({ id: 2n, createdAt: verifyUntil, recipient, signer });
    h.inboxActor = inboxActor([atCutoff]);
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 2n })]);

    const afterCutoff = await buildStoredAction({ id: 3n, createdAt: verifyUntil + 1n, recipient, signer });
    h.inboxActor = inboxActor([afterCutoff]);
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).resolves.toEqual([]);
  });

  it("uses discovery trust only for an exact-loopback recreated local keyring", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({ id: 2n, createdAt: 1_800_000_000_010n, recipient, signer });
    h.userIndexActor = keyringActor(signer);
    h.inboxActor = inboxActor([action]);
    await expect(
      pollActionInbox({
        config: LOCAL_CONFIG,
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 2n })]);
    await expect(
      pollActionInbox({
        config: { ...LOCAL_CONFIG, host: "https://oc.example" },
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).rejects.toThrow(/key.ids.*required/i);
  });

  it("fails closed for an incompatible keyring version, purpose, or invalid verify-only lifetime", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    h.inboxActor = inboxActor([]);
    const run = () =>
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      });
    h.userIndexActor = keyringActor(signer, { signatureVersion: 3 });
    await expect(run()).rejects.toThrow(/incompatible/i);
    h.userIndexActor = keyringActor(signer, { purpose: "jwt" });
    await expect(run()).rejects.toThrow(/incompatible/i);
    h.userIndexActor = keyringActor(signer, { status: { VerifyOnly: null }, verifyUntil: [] });
    await expect(run()).rejects.toThrow(/verify-only.*lifetime/i);
    h.userIndexActor = keyringActor(signer, {
      status: { VerifyOnly: null },
      createdAt: 10n,
      verifyUntil: [10n],
    });
    await expect(run()).rejects.toThrow(/before its creation/i);
  });
});

describe("pollActionInbox v4 end-to-end validation", () => {
  it("returns only the pinned, addressed, fully bound group-card deposit", async () => {
    const recipient = await generateConsumerKeys();
    const otherRecipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const impostor = await generateOcSigner();
    const payload = { action_id: "iou.add", amount: 20 };
    const good = await buildStoredAction({
      id: 5n,
      createdAt: 1_800_000_000_000n,
      recipient,
      signer,
      payload,
    });
    const notForUs = await buildStoredAction({
      id: 6n,
      createdAt: 1_800_000_000_001n,
      recipient: otherRecipient,
      signer,
      payload,
      consumerKeySelector: new Uint8Array(32).fill(0x55),
    });
    const forged = await buildStoredAction({
      id: 7n,
      createdAt: 1_800_000_000_002n,
      recipient,
      signer: impostor,
      payload,
    });
    h.userIndexActor = keyringActor(signer);
    h.inboxActor = inboxActor([good, notForUs, forged]);
    const output = await pollActionInbox({
      config: configFor(signer),
      keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
    });
    expect(output).toEqual([
      expect.objectContaining({
        id: 5n,
        draft: payload,
        created_at: 1_800_000_000_000n,
        context: testContext(1_800_000_000_000),
        acknowledgementSecret: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      }),
    ]);
  });

  it("deduplicates a valid signed envelope replayed under forged numeric ids", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const action = await buildStoredAction({ id: 8n, createdAt: 1_800_000_000_100n, recipient, signer });
    const replay = { ...action, id: 18_446_744_073_709_551_615n };
    h.userIndexActor = keyringActor(signer);
    h.inboxActor = inboxActor([action, replay]);
    const output = await pollActionInbox({
      config: configFor(signer),
      keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
    });
    expect(output).toHaveLength(1);
    expect(output[0].deliveryId).toBe(bytesToHex(Uint8Array.from(action.idempotency_key)));
  });

  it("drops correctly signed deposits whose outer commitments disagree with decrypted content", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const fields: Array<keyof Pick<
      StoredActionLike,
      "payload_hash" | "card_context_hash" | "acknowledgement_secret_hash"
    >> = ["payload_hash", "card_context_hash", "acknowledgement_secret_hash"];
    h.userIndexActor = keyringActor(signer);
    for (const [index, field] of fields.entries()) {
      const action = await buildStoredAction({
        id: BigInt(index + 1),
        createdAt: BigInt(1_800_000_001_000 + index),
        recipient,
        signer,
      });
      action[field][0] ^= 1;
      await resign(action, signer);
      h.inboxActor = inboxActor([action]);
      await expect(
        pollActionInbox({
          config: configFor(signer),
          keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
        }),
        field,
      ).resolves.toEqual([]);
    }
  });

  it("rejects the previously self-consistent raw-SHA payload-hash contract", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const createdAt = 1_800_000_001_100n;
    const payload = { action_id: "iou.add", amount: 20 };
    const action = await buildStoredAction({ id: 9n, createdAt, recipient, signer, payload });
    const rawHash = await sha256(new TextEncoder().encode(JSON.stringify(payload)));
    action.payload_hash = Array.from(rawHash);
    action.card_context_hash = Array.from(
      await actionCardContextHashV2(testContext(Number(createdAt)), rawHash),
    );
    await resign(action, signer);
    h.userIndexActor = keyringActor(signer);
    h.inboxActor = inboxActor([action]);
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).resolves.toEqual([]);
  });

  it("drops a correctly signed outer/inner metadata disagreement", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    h.userIndexActor = keyringActor(signer);

    const metadataMismatch = await buildStoredAction({
      id: 2n,
      createdAt: 1_800_000_002_001n,
      recipient,
      signer,
    });
    metadataMismatch.app_revision += 1n;
    await resign(metadataMismatch, signer);
    h.inboxActor = inboxActor([metadataMismatch]);
    await expect(
      pollActionInbox({
        config: configFor(signer),
        keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      }),
    ).resolves.toEqual([]);
  });

  it("always polls from zero and passes the exact private selector and bound page size", async () => {
    const recipient = await generateConsumerKeys();
    const signer = await generateOcSigner();
    let seen: Record<string, unknown> | undefined;
    h.userIndexActor = keyringActor(signer);
    h.inboxActor = inboxActor([], (args) => {
      seen = args as Record<string, unknown>;
    });
    await pollActionInbox({
      config: configFor(signer),
      keypair: { privateKey: recipient.privateKey, fingerprint: recipient.fingerprint } as never,
      maxResults: 7,
    });
    expect(seen).toEqual({
      consumer_key_fingerprint: Array.from(TEST_CONSUMER_QUEUE_SELECTOR),
      since_id: 0n,
      max_results: 7,
    });
  });
});

describe("ActionInbox acknowledgement capability", () => {
  it("sends only the exact recipient, cursor, and 32-byte secret", async () => {
    const secret = Uint8Array.from({ length: 32 }, () => 7);
    let seen: Record<string, unknown> | undefined;
    h.inboxActor = {
      acknowledge_actions: (args: unknown) => {
        seen = args as Record<string, unknown>;
        return { Success: { acknowledged: 1, remaining: 0 } };
      },
    };
    await expect(
      acknowledgeActionInbox({
        config: LOCAL_CONFIG,
        throughId: 8n,
        acknowledgementSecret: secret,
      }),
    ).resolves.toEqual({ acknowledged: 1, remaining: 0 });
    expect(seen).toEqual({
      consumer_key_fingerprint: Array.from(TEST_CONSUMER_QUEUE_SELECTOR),
      consumer_public_key_pem: "",
      through_id: 8n,
      signature: [],
      acknowledgement_secret: [Array.from(secret)],
    });
  });

  it("rejects a wrong-sized secret and sends an exact capability only once", async () => {
    const acknowledge = vi.fn().mockReturnValue({ Success: { acknowledged: 1, remaining: 500 } });
    h.inboxActor = { acknowledge_actions: acknowledge };
    await expect(
      acknowledgeActionInbox({
        config: LOCAL_CONFIG,
        throughId: 1n,
        acknowledgementSecret: new Uint8Array(31),
      }),
    ).rejects.toThrow(/exactly 32 bytes/);
    expect(acknowledge).not.toHaveBeenCalled();

    await expect(
      acknowledgeActionInbox({
        config: LOCAL_CONFIG,
        throughId: 1500n,
        acknowledgementSecret: new Uint8Array(32),
      }),
    ).resolves.toEqual({ acknowledged: 1, remaining: 500 });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});

describe("getActionInboxConfig manifest resolution and cache", () => {
  const ENV = {
    VITE_OPENCHAT_HOST: "http://127.0.0.1:8080",
    VITE_OC_USER_INDEX_CANISTER_ID: TEST_USER_INDEX_CANISTER_ID,
    VITE_ACTION_INBOX_CANISTER_ID: "rrkah-fqaaa-aaaaa-aaaaq-cai",
    VITE_IOU_BACKEND_CANISTER_ID: "ryjl3-tyaaa-aaaaa-aaaba-cai",
    VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS: "",
  };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const [key, value] of Object.entries(ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    invalidateInboxCache();
    h.resolveInbox = vi.fn(async () => route());
  });

  afterEach(() => {
    for (const key of Object.keys(ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.useRealTimers();
  });

  it("returns the manifest inbox together with its authoritative UserIndex route", async () => {
    await expect(getActionInboxConfig(BINDING_ACTOR)).resolves.toEqual({
      canisterId: TEST_INBOX_CANISTER_ID,
      appId: 7,
      consumerKeySelector: TEST_CONSUMER_QUEUE_SELECTOR,
      host: ENV.VITE_OPENCHAT_HOST,
      userIndexCanisterId: TEST_USER_INDEX_CANISTER_ID,
      signingKeyIds: [],
    });
    expect(h.resolveInbox).toHaveBeenCalledWith(
      expect.objectContaining({
        appName: "iou",
        userIndexCanisterId: TEST_USER_INDEX_CANISTER_ID,
        appCanisterId: ENV.VITE_IOU_BACKEND_CANISTER_ID,
      }),
    );
  });

  it("requires and canonicalizes remote action-signing key ids before manifest lookup", async () => {
    process.env.VITE_OPENCHAT_HOST = "https://oc.example";
    process.env.VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS = "Ab".repeat(32);
    expect((await getActionInboxConfig(BINDING_ACTOR))?.signingKeyIds).toEqual(["ab".repeat(32)]);
    invalidateInboxCache();
    process.env.VITE_OPENCHAT_ACTION_SIGNING_KEY_IDS = "";
    await expect(getActionInboxConfig(BINDING_ACTOR)).rejects.toThrow(/key.ids.*required/i);
    expect(h.resolveInbox).toHaveBeenCalledTimes(1);
  });

  it("memoizes, invalidates, expires, and deduplicates manifest resolution", async () => {
    await getActionInboxConfig(BINDING_ACTOR);
    await getActionInboxConfig(BINDING_ACTOR);
    expect(h.resolveInbox).toHaveBeenCalledTimes(1);
    invalidateInboxCache();
    await getActionInboxConfig(BINDING_ACTOR);
    expect(h.resolveInbox).toHaveBeenCalledTimes(2);

    invalidateInboxCache();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    await getActionInboxConfig(BINDING_ACTOR);
    vi.setSystemTime(31_000);
    await getActionInboxConfig(BINDING_ACTOR);
    expect(h.resolveInbox).toHaveBeenCalledTimes(4);

    invalidateInboxCache();
    let release!: (value: ReturnType<typeof route> | null) => void;
    h.resolveInbox = vi.fn(
      () => new Promise<ReturnType<typeof route> | null>((resolve) => (release = resolve)),
    );
    const first = getActionInboxConfig(BINDING_ACTOR);
    const second = getActionInboxConfig(BINDING_ACTOR);
    await vi.waitFor(() => expect(h.resolveInbox).toHaveBeenCalledTimes(1));
    release(route());
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ canisterId: TEST_INBOX_CANISTER_ID }),
      expect.objectContaining({ canisterId: TEST_INBOX_CANISTER_ID }),
    ]);
    expect(h.resolveInbox).toHaveBeenCalledTimes(1);
  });

  it("does not share an in-flight manifest lookup across different UserIndex routes", async () => {
    const releases = new Map<string, (value: ReturnType<typeof route> | null) => void>();
    h.resolveInbox = vi.fn(
      (options: unknown) =>
        new Promise<ReturnType<typeof route> | null>((resolve) => {
          const userIndexCanisterId = (options as { userIndexCanisterId: string }).userIndexCanisterId;
          releases.set(userIndexCanisterId, resolve);
        }),
    );
    const first = getActionInboxConfig(BINDING_ACTOR);
    await vi.waitFor(() => expect(h.resolveInbox).toHaveBeenCalledTimes(1));
    process.env.VITE_OC_USER_INDEX_CANISTER_ID = TEST_INBOX_CANISTER_ID;
    const second = getActionInboxConfig(BINDING_ACTOR);
    await vi.waitFor(() => expect(h.resolveInbox).toHaveBeenCalledTimes(2));
    releases.get(TEST_USER_INDEX_CANISTER_ID)?.(route("rrkah-fqaaa-aaaaa-aaaaq-cai"));
    releases.get(TEST_INBOX_CANISTER_ID)?.(route("ryjl3-tyaaa-aaaaa-aaaba-cai"));
    await expect(first).resolves.toEqual(expect.objectContaining({ userIndexCanisterId: TEST_USER_INDEX_CANISTER_ID }));
    await expect(second).resolves.toEqual(expect.objectContaining({ userIndexCanisterId: TEST_INBOX_CANISTER_ID }));
  });

  it("prevents a pre-invalidation lookup from overwriting or returning the replacement route", async () => {
    const releases: Array<(value: ReturnType<typeof route> | null) => void> = [];
    h.resolveInbox = vi.fn(
      () =>
        new Promise<ReturnType<typeof route> | null>((resolve) => {
          releases.push(resolve);
        }),
    );
    const stale = getActionInboxConfig(BINDING_ACTOR);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    invalidateInboxCache();
    const fresh = getActionInboxConfig(BINDING_ACTOR);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1](route("ryjl3-tyaaa-aaaaa-aaaba-cai"));
    await expect(fresh).resolves.toEqual(expect.objectContaining({ canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai" }));
    releases[0](route("rrkah-fqaaa-aaaaa-aaaaq-cai"));
    await expect(stale).resolves.toEqual(expect.objectContaining({ canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai" }));
    await expect(getActionInboxConfig(BINDING_ACTOR)).resolves.toEqual(
      expect.objectContaining({ canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai" }),
    );
    expect(h.resolveInbox).toHaveBeenCalledTimes(2);
  });

  it("has no env selector/inbox fallback and requires both a binding and manifest route", async () => {
    h.resolveInbox = vi.fn(async () => null);
    await expect(getActionInboxConfig(BINDING_ACTOR)).resolves.toBeNull();
    invalidateInboxCache();
    vi.mocked(h.resolveInbox).mockClear();
    process.env.VITE_OC_USER_INDEX_CANISTER_ID = "";
    await expect(getActionInboxConfig(BINDING_ACTOR)).resolves.toBeNull();
    expect(h.resolveInbox).not.toHaveBeenCalled();
  });

  it("fails closed before route lookup for a missing or malformed private binding", async () => {
    await expect(
      getActionInboxConfig({ get_openchat_binding: async () => [] }),
    ).resolves.toBeNull();
    await expect(
      getActionInboxConfig({
        get_openchat_binding: async (): Promise<[] | [OpenChatBindingWire]> => [{
          ...(await BINDING_ACTOR.get_openchat_binding())[0]!,
          consumer_queue_selector: new Array(32).fill(256),
        }],
      }),
    ).rejects.toThrow(/consumer queue selector/i);
    expect(h.resolveInbox).not.toHaveBeenCalled();
  });
});
