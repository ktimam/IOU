import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityOrigin = "https://device.sample-tailnet.ts.net:9444";
const mainnetHost = "https://icp-api.io";
const mainnetBackendCanisterId = "ryjl3-tyaaa-aaaaa-aaaba-cai";

function configureMainnet() {
  vi.stubEnv("DEV", false);
  vi.stubEnv("VITE_DFX_NETWORK", "ic");
  vi.stubEnv("VITE_IOU_PROD_VETKD", "1");
  vi.stubEnv("VITE_IOU_BACKEND_CANISTER_ID", mainnetBackendCanisterId);
  vi.stubEnv("VITE_DFX_PORT", "");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected network request in config test")));
  for (const key of [
    "VITE_IC_URL",
    "VITE_OC_IC_URL",
    "VITE_OPENCHAT_HOST",
    "VITE_IOU_LAN_QC_II_ORIGIN",
    "VITE_IOU_LAN_QC_OPENCHAT_ORIGIN",
  ]) vi.stubEnv(key, "");
  vi.stubEnv("IOU_HOST", undefined);
  vi.stubEnv("VITE_IOU_PROD_VETKD", "0");
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_DFX_NETWORK", "local");
  vi.stubEnv("VITE_DFX_PORT", "8080");
  vi.stubEnv("VITE_II_CANISTER_ID", "rdmx6-jaaaa-aaaaa-aaadq-cai");
  vi.stubEnv("VITE_IOU_BACKEND_CANISTER_ID", "synthetic-backend");
  vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", "");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("IOU identity endpoint configuration", () => {
  it("keeps the existing local II and backend defaults when the override is unset", async () => {
    const config = await import("./config");
    expect(config.internetIdentityUrl).toBe("http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:8080");
    expect(config.host).toBe("http://127.0.0.1:8080");
    expect(config.canisterId).toBe("synthetic-backend");
  });

  it("uses the explicit private II origin without changing the backend or identity code", async () => {
    vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", identityOrigin);
    const config = await import("./config");
    expect(config.internetIdentityUrl).toBe(identityOrigin);
    expect(config.host).toBe("http://127.0.0.1:8080");
    expect(config.canisterId).toBe("synthetic-backend");
  });

  it("fails closed on an invalid override in local development", async () => {
    vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", "https://identity.example:9444");
    await expect(import("./config")).rejects.toThrow(/VITE_IOU_LAN_QC_II_ORIGIN/);
  });

  it.each([identityOrigin, "not a valid origin"])("rejects a private II override for mainnet: %s", async (origin) => {
    configureMainnet();
    vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", origin);
    await expect(import("./config")).rejects.toThrow(/VITE_IOU_LAN_QC_II_ORIGIN/);
  });

  it.each([identityOrigin, "not a valid origin"])("ignores the override in production even with a stale development shell: %s", async (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", origin);
    const config = await import("./config");
    expect(config.internetIdentityUrl).toBe("http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:8080");
  });
});

describe("mainnet authentication and actor configuration", () => {
  beforeEach(configureMainnet);

  it("uses the exact mainnet host, Internet Identity URL, and explicit backend ID", async () => {
    const config = await import("./config");
    expect(config.host).toBe(mainnetHost);
    expect(config.internetIdentityUrl).toBe("https://identity.ic0.app");
    expect(config.canisterId).toBe(mainnetBackendCanisterId);
  });

  it.each([undefined, "", "synthetic-backend", "aaaaa-aa", "2vxsx-fae", "uxrrr-q7777-77774-qaaaq-cai"])(
    "rejects missing or unsafe backend IDs in both consumers: %j",
    async (value) => {
      vi.stubEnv("VITE_IOU_BACKEND_CANISTER_ID", value);
      await expect(import("./config")).rejects.toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
      await expect(import("../../backend/declarations")).rejects.toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
    },
  );

  it.each([undefined, "", "0", "true", " 1", "1 "])(
    "rejects absent or invalid production vetKD opt-in in both consumers: %j",
    async (value) => {
      vi.stubEnv("VITE_IOU_PROD_VETKD", value);
      await expect(import("./config")).rejects.toThrow(/VITE_IOU_PROD_VETKD/);
      await expect(import("../../backend/declarations")).rejects.toThrow(/VITE_IOU_PROD_VETKD/);
    },
  );

  it("builds the auth agent without fetching a root key or disabling query verification", async () => {
    const { AnonymousIdentity, HttpAgent, IC_ROOT_KEY } = await import("@dfinity/agent");
    const fetchRootKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(new Uint8Array());
    const { buildAgent, getCanisterId } = await import("./AuthProvider");
    const agent = await buildAgent(new AnonymousIdentity());

    expect(agent.host.origin).toBe(mainnetHost);
    expect(getCanisterId()).toBe(mainnetBackendCanisterId);
    expect(fetchRootKey).not.toHaveBeenCalled();
    expect(agent.config.verifyQuerySignatures).not.toBe(false);
    expect(agent.rootKey).toEqual(Uint8Array.from(IC_ROOT_KEY.match(/../g)!.map((hex) => parseInt(hex, 16))));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("uses the same secure mainnet defaults when creating an actor from an identity", async () => {
    const { Actor, AnonymousIdentity, HttpAgent, IC_ROOT_KEY } = await import("@dfinity/agent");
    const fetchRootKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(new Uint8Array());
    const actorFactory = vi.spyOn(Actor, "createActor").mockReturnValue({} as never);
    const { createActor, idlFactory } = await import("../../backend/declarations");
    createActor(new AnonymousIdentity());

    expect(actorFactory).toHaveBeenCalledOnce();
    const [factory, options] = actorFactory.mock.calls[0];
    expect(factory).toBe(idlFactory);
    expect(options.canisterId).toBe(mainnetBackendCanisterId);
    expect(options.agent).toBeInstanceOf(HttpAgent);
    const agent = options.agent as InstanceType<typeof HttpAgent>;
    expect(agent.host.origin).toBe(mainnetHost);
    expect(agent.config.verifyQuerySignatures).not.toBe(false);
    expect(agent.rootKey).toEqual(Uint8Array.from(IC_ROOT_KEY.match(/../g)!.map((hex) => parseInt(hex, 16))));
    expect(fetchRootKey).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["http://localhost:4943", "http://127.0.0.1:4943"])(
    "rejects a local host override on the identity actor path: %s",
    async (host) => {
      const { Actor, AnonymousIdentity, HttpAgent } = await import("@dfinity/agent");
      const fetchRootKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(new Uint8Array());
      const actorFactory = vi.spyOn(Actor, "createActor").mockReturnValue({} as never);
      const { createActor } = await import("../../backend/declarations");
      expect(() => createActor(new AnonymousIdentity(), host)).toThrow(/Mainnet actors must use/);
      expect(actorFactory).not.toHaveBeenCalled();
      expect(fetchRootKey).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("rejects the local fallback ID on both actor overloads", async () => {
    const { Actor, AnonymousIdentity, HttpAgent } = await import("@dfinity/agent");
    const fetchRootKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(new Uint8Array());
    const actorFactory = vi.spyOn(Actor, "createActor").mockReturnValue({} as never);
    const { createActor } = await import("../../backend/declarations");
    const agent = new HttpAgent({ host: mainnetHost });

    expect(() => createActor(new AnonymousIdentity(), undefined, "uxrrr-q7777-77774-qaaaq-cai"))
      .toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
    expect(() => createActor(agent, "uxrrr-q7777-77774-qaaaq-cai"))
      .toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
    expect(actorFactory).not.toHaveBeenCalled();
    expect(fetchRootKey).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves a caller-built agent and its existing configuration and root key", async () => {
    const { Actor, HttpAgent } = await import("@dfinity/agent");
    const fetchRootKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(new Uint8Array());
    const actorFactory = vi.spyOn(Actor, "createActor").mockReturnValue({} as never);
    const { createActor } = await import("../../backend/declarations");
    const agent = new HttpAgent({ host: "https://caller-selected.example", verifyQuerySignatures: true });
    const originalConfig = agent.config;
    const originalConfigValues = { ...agent.config };
    const originalRootKey = agent.rootKey;

    createActor(agent);
    expect(actorFactory.mock.calls[0][1].agent).toBe(agent);
    expect(actorFactory.mock.calls[0][1].canisterId).toBe(mainnetBackendCanisterId);
    expect(agent.config).toBe(originalConfig);
    expect(agent.config).toEqual(originalConfigValues);
    expect(agent.host.origin).toBe("https://caller-selected.example");
    expect(agent.rootKey).toBe(originalRootKey);
    expect(fetchRootKey).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("preserves an explicit valid canister override on both actor overloads", async () => {
    const { Actor, AnonymousIdentity, HttpAgent } = await import("@dfinity/agent");
    const fetchRootKey = vi.spyOn(HttpAgent.prototype, "fetchRootKey").mockResolvedValue(new Uint8Array());
    const actorFactory = vi.spyOn(Actor, "createActor").mockReturnValue({} as never);
    const { createActor } = await import("../../backend/declarations");
    const override = "rdmx6-jaaaa-aaaaa-aaadq-cai";
    const agent = new HttpAgent({ host: mainnetHost });

    createActor(new AnonymousIdentity(), mainnetHost, override);
    createActor(agent, override);
    expect(actorFactory).toHaveBeenCalledTimes(2);
    expect(actorFactory.mock.calls[0][1].canisterId).toBe(override);
    expect(actorFactory.mock.calls[1][1].canisterId).toBe(override);
    expect(actorFactory.mock.calls[1][1].agent).toBe(agent);
    expect(fetchRootKey).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
