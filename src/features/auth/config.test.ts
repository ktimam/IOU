import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identityOrigin = "https://device.sample-tailnet.ts.net:9444";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("DEV", true);
  vi.stubEnv("VITE_DFX_NETWORK", "local");
  vi.stubEnv("VITE_DFX_PORT", "8080");
  vi.stubEnv("VITE_II_CANISTER_ID", "rdmx6-jaaaa-aaaaa-aaadq-cai");
  vi.stubEnv("VITE_IOU_BACKEND_CANISTER_ID", "synthetic-backend");
  vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", "");
});

afterEach(() => {
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

  it.each([identityOrigin, "not a valid origin"])("ignores the override for mainnet: %s", async (origin) => {
    vi.stubEnv("VITE_DFX_NETWORK", "ic");
    vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", origin);
    const config = await import("./config");
    expect(config.internetIdentityUrl).toBe("https://identity.ic0.app");
    expect(config.host).toBe("https://icp-api.io");
  });

  it.each([identityOrigin, "not a valid origin"])("ignores the override in production even with a stale development shell: %s", async (origin) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_IOU_LAN_QC_II_ORIGIN", origin);
    const config = await import("./config");
    expect(config.internetIdentityUrl).toBe("http://rdmx6-jaaaa-aaaaa-aaadq-cai.localhost:8080");
  });
});
