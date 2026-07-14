// pollActionInbox filtering (signature-verified only, addressed-to-us only,
// cursor + fingerprint passed through) and getActionInboxConfig resolution +
// the manifest→inbox cache (memoize, in-flight dedup, TTL, invalidate, env
// fallback). The inbox actor and the user_index resolver are mocked; the
// envelopes are REAL (ecTestKit), so the verify+decrypt+split path is exercised
// end to end.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateConsumerKeys, generateOcSigner, buildStoredAction, type StoredActionLike } from "./ecTestKit";

// ─── mocks ───
const h = vi.hoisted(() => ({
  actor: null as unknown as { actions: (a: unknown) => unknown; openchat_public_key: (a: unknown) => unknown },
  resolveInbox: null as unknown as (opts: unknown) => Promise<string | null>,
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
    Actor: { createActor: () => h.actor },
  };
});

// pollActionInbox always receives an explicit keypair in these tests, so loadOrCreate must never run.
vi.mock("./consumerKeypair", () => ({
  loadOrCreateConsumerKeypair: async () => {
    throw new Error("loadOrCreateConsumerKeypair should not be called when a keypair is supplied");
  },
}));

vi.mock("./registerAiApp", () => ({
  getRegisteredInboxCanisterId: (opts: unknown) => h.resolveInbox(opts),
}));

import {
  pollActionInbox,
  getActionInboxConfig,
  invalidateInboxCache,
} from "./actionInboxClient";

const CONFIG = { canisterId: "aaaaa-aa", host: "http://127.0.0.1:8080" };

function actorReturning(pem: string, actions: StoredActionLike[], onArgs?: (a: unknown) => void) {
  return {
    openchat_public_key: () => ({ Success: pem }),
    actions: (a: unknown) => {
      onArgs?.(a);
      return { Success: { actions } };
    },
  };
}

describe("pollActionInbox — provenance + addressing filter", () => {
  it("returns only signed, addressed-to-us drafts and splits the v2 wrapper", async () => {
    const me = await generateConsumerKeys();
    const other = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const impostor = await generateOcSigner();

    const payload = { action_id: "iou.add", amount: 20 };
    const context = { chat: "group:aaaaa-aa", messageId: "42", confirmedBy: "abc", confirmedAt: 111 };
    const plaintext = JSON.stringify({ context, payload });

    const good = await buildStoredAction({ id: 5n, createdAt: 1000n, recipient: me, signer, plaintext });
    const notForUs = await buildStoredAction({ id: 6n, createdAt: 1001n, recipient: other, signer, plaintext });
    const forged = await buildStoredAction({ id: 7n, createdAt: 1002n, recipient: me, signer: impostor, plaintext });

    h.actor = actorReturning(signer.publicKeyPem, [good, notForUs, forged]);

    const out = await pollActionInbox({
      config: CONFIG,
      // Only fingerprint + privateKey are consumed by the poller.
      keypair: { privateKey: me.privateKey, fingerprint: me.fingerprint } as never,
    });

    expect(out.map((d) => d.id)).toEqual([5n]); // notForUs (decrypt fails) + forged (verify fails) dropped
    expect(out[0].draft).toEqual(payload);
    expect(out[0].context).toEqual(context);
    expect(out[0].created_at).toBe(1000n);
  });

  it("passes the consumer fingerprint, since cursor, and max_results to the query", async () => {
    const me = await generateConsumerKeys();
    const signer = await generateOcSigner();
    let seen: { consumer_key_fingerprint: number[]; since_id: bigint; max_results: number } | undefined;
    h.actor = actorReturning(signer.publicKeyPem, [], (a) => {
      seen = a as typeof seen;
    });

    await pollActionInbox({
      config: CONFIG,
      keypair: { privateKey: me.privateKey, fingerprint: me.fingerprint } as never,
      sinceId: 12n,
      maxResults: 7,
    });
    expect(seen?.consumer_key_fingerprint).toEqual(Array.from(me.fingerprint));
    expect(seen?.since_id).toBe(12n);
    expect(seen?.max_results).toBe(7);
  });

  it("drops an entry whose created_at was tampered after signing", async () => {
    const me = await generateConsumerKeys();
    const signer = await generateOcSigner();
    const a = await buildStoredAction({ id: 9n, createdAt: 2000n, recipient: me, signer, plaintext: "{}" });
    a.created_at = 2001n; // signature was over 2000 → verification against 2001 fails
    h.actor = actorReturning(signer.publicKeyPem, [a]);

    const out = await pollActionInbox({
      config: CONFIG,
      keypair: { privateKey: me.privateKey, fingerprint: me.fingerprint } as never,
    });
    expect(out).toEqual([]);
  });

  it("throws when the inbox returns no openchat_public_key", async () => {
    const me = await generateConsumerKeys();
    h.actor = {
      openchat_public_key: () => ({}),
      actions: () => ({ Success: { actions: [] } }),
    };
    await expect(
      pollActionInbox({ config: CONFIG, keypair: { privateKey: me.privateKey, fingerprint: me.fingerprint } as never }),
    ).rejects.toThrow(/openchat_public_key/);
  });
});

describe("getActionInboxConfig — manifest resolution + cache", () => {
  const ENV = {
    VITE_OPENCHAT_HOST: "http://127.0.0.1:8080",
    VITE_OC_USER_INDEX_CANISTER_ID: "uindex-aaaaa",
    VITE_ACTION_INBOX_CANISTER_ID: "envfallback-aaaaa",
    VITE_IOU_BACKEND_CANISTER_ID: "ioubackend-aaaaa",
  };
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of Object.keys(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = ENV[k as keyof typeof ENV];
    }
    invalidateInboxCache();
    h.resolveInbox = vi.fn(async () => "resolved-inbox-aaaaa");
  });
  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.useRealTimers();
  });

  it("resolves the inbox from the registered manifest (host from env)", async () => {
    const cfg = await getActionInboxConfig();
    expect(cfg).toEqual({ canisterId: "resolved-inbox-aaaaa", host: "http://127.0.0.1:8080" });
    expect(h.resolveInbox).toHaveBeenCalledTimes(1);
    expect(h.resolveInbox).toHaveBeenCalledWith(
      expect.objectContaining({ appName: "iou", userIndexCanisterId: "uindex-aaaaa", appCanisterId: "ioubackend-aaaaa" }),
    );
  });

  it("memoizes within the TTL (second call does not re-query user_index)", async () => {
    await getActionInboxConfig();
    await getActionInboxConfig();
    expect(h.resolveInbox).toHaveBeenCalledTimes(1);
  });

  it("invalidateInboxCache forces a re-query", async () => {
    await getActionInboxConfig();
    invalidateInboxCache();
    await getActionInboxConfig();
    expect(h.resolveInbox).toHaveBeenCalledTimes(2);
  });

  it("re-queries after the TTL lapses", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    await getActionInboxConfig();
    vi.setSystemTime(31_000); // > 30s INBOX_TTL_MS
    await getActionInboxConfig();
    expect(h.resolveInbox).toHaveBeenCalledTimes(2);
  });

  it("dedupes concurrent in-flight resolutions into one query", async () => {
    let release!: (v: string | null) => void;
    h.resolveInbox = vi.fn(() => new Promise<string | null>((res) => (release = res)));
    const p1 = getActionInboxConfig();
    const p2 = getActionInboxConfig();
    release("late-inbox-aaaaa");
    const [c1, c2] = await Promise.all([p1, p2]);
    expect(h.resolveInbox).toHaveBeenCalledTimes(1);
    expect(c1?.canisterId).toBe("late-inbox-aaaaa");
    expect(c2?.canisterId).toBe("late-inbox-aaaaa");
  });

  it("falls back to VITE_ACTION_INBOX_CANISTER_ID when the manifest declares no inbox", async () => {
    h.resolveInbox = vi.fn(async () => null);
    const cfg = await getActionInboxConfig();
    expect(cfg?.canisterId).toBe("envfallback-aaaaa");
  });

  it("returns null when neither the manifest nor the env supplies an inbox", async () => {
    // Blank (not delete) the vars: readEnv checks process.env first, and Vite injects import.meta.env
    // from .env.local — deleting the process.env key would fall through to the real .env.local value.
    h.resolveInbox = vi.fn(async () => null);
    process.env.VITE_ACTION_INBOX_CANISTER_ID = "";
    process.env.VITE_OC_USER_INDEX_CANISTER_ID = "";
    const cfg = await getActionInboxConfig();
    expect(cfg).toBeNull();
  });
});
