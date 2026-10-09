import { describe, expect, it } from "vitest";
import { Principal } from "@dfinity/principal";
import {
  MAINNET_IC_HOST,
  MAINNET_IDENTITY_URL,
  requireMainnetCanisterId,
  resolveMainnetConfig,
} from "./mainnetConfig";

const backendCanisterId = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const identityCanisterId = "rdmx6-jaaaa-aaaaa-aaadq-cai";
const localOverrides = [
  "VITE_DFX_PORT",
  "VITE_IOU_LAN_QC_II_ORIGIN",
  "VITE_IOU_LAN_QC_OPENCHAT_ORIGIN",
] as const;
const hostOverrides = ["IOU_HOST", "VITE_IC_URL", "VITE_OC_IC_URL", "VITE_OPENCHAT_HOST"] as const;

function mainnetEnv(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    VITE_DFX_NETWORK: "ic",
    VITE_IOU_BACKEND_CANISTER_ID: backendCanisterId,
    VITE_IOU_PROD_VETKD: "1",
    ...overrides,
  };
}

describe("mainnet backend canister validation", () => {
  it("accepts a canonical canister principal without claiming deployment existence", () => {
    expect(requireMainnetCanisterId(backendCanisterId)).toBe(backendCanisterId);
  });

  it("rejects a canonical self-authenticating user principal as a backend canister", () => {
    const userPrincipal = Principal.selfAuthenticating(new Uint8Array(32)).toText();
    expect(() => requireMainnetCanisterId(userPrincipal)).toThrow(/opaque mainnet backend canister/);
    expect(() => resolveMainnetConfig(mainnetEnv({ VITE_IOU_BACKEND_CANISTER_ID: userPrincipal })))
      .toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
  });

  it.each([
    undefined,
    null,
    "",
    " ",
    1,
    true,
    {},
    "synthetic-backend",
    "not-a-principal",
    "aaaaa-aa",
    "2vxsx-fae",
    "uxrrr-q7777-77774-qaaaq-cai",
    ` ${backendCanisterId}`,
    `${backendCanisterId} `,
    `${backendCanisterId}\n`,
    backendCanisterId.toUpperCase(),
    backendCanisterId.replaceAll("-", ""),
    "ryjl3-tyaaa-aaaaa-aaabb-cai",
  ])("rejects an absent, unsafe, or noncanonical principal: %j", (value) => {
    expect(() => requireMainnetCanisterId(value)).toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
    expect(() => resolveMainnetConfig(mainnetEnv({ VITE_IOU_BACKEND_CANISTER_ID: value })))
      .toThrow(/VITE_IOU_BACKEND_CANISTER_ID/);
  });
});

describe("mainnet configuration", () => {
  it("resolves exact mainnet host, identity endpoint, and explicit backend ID", () => {
    expect(MAINNET_IC_HOST).toBe("https://icp-api.io");
    expect(MAINNET_IDENTITY_URL).toBe("https://identity.ic0.app");
    expect(resolveMainnetConfig(mainnetEnv())).toEqual({
      host: "https://icp-api.io",
      internetIdentityUrl: "https://identity.ic0.app",
      canisterId: backendCanisterId,
    });
  });

  it("does not mutate the supplied configuration", () => {
    const env = Object.freeze(mainnetEnv());
    const before = { ...env };
    resolveMainnetConfig(env);
    expect(env).toEqual(before);
  });

  it.each([undefined, null, "", "0", "true", "yes", "01", " 1", "1 ", 1, true])(
    "requires the exact production vetKD opt-in string: %j",
    (value) => {
      expect(() => resolveMainnetConfig(mainnetEnv({ VITE_IOU_PROD_VETKD: value })))
        .toThrow(/VITE_IOU_PROD_VETKD/);
    },
  );

  describe.each(localOverrides)("local-only override %s", (name) => {
    it.each([undefined, ""])("allows an unset or empty value: %j", (value) => {
      expect(resolveMainnetConfig(mainnetEnv({ [name]: value }))).toBeDefined();
    });

    it.each(["8080", "http://localhost:4943", "https://device.sample-tailnet.ts.net:9444", " ", null, false])(
      "rejects a configured value: %j",
      (value) => {
        expect(() => resolveMainnetConfig(mainnetEnv({ [name]: value }))).toThrow(name);
      },
    );
  });

  describe.each(hostOverrides)("host override %s", (name) => {
    it.each([undefined, "", MAINNET_IC_HOST])("allows only unset, empty, or exact mainnet: %j", (value) => {
      expect(resolveMainnetConfig(mainnetEnv({ [name]: value }))?.host).toBe(MAINNET_IC_HOST);
    });

    it.each([
      "http://127.0.0.1:4943",
      "http://localhost:4943",
      "https://device.sample-tailnet.ts.net:9444",
      "https://example.com",
      "http://icp-api.io",
      "https://icp-api.io/",
      "https://ICP-API.IO",
      " https://icp-api.io",
      "https://icp-api.io ",
      " ",
      null,
    ])("rejects an alternate or noncanonical host: %j", (value) => {
      expect(() => resolveMainnetConfig(mainnetEnv({ [name]: value }))).toThrow(name);
    });
  });

  it.each([undefined, "", identityCanisterId])("allows the mainnet II canister default: %j", (value) => {
    expect(resolveMainnetConfig(mainnetEnv({ VITE_II_CANISTER_ID: value }))?.internetIdentityUrl)
      .toBe(MAINNET_IDENTITY_URL);
  });

  it.each(["synthetic-identity", backendCanisterId, "aaaaa-aa", "2vxsx-fae", ` ${identityCanisterId}`, " ", null])(
    "rejects alternate identity canisters: %j",
    (value) => {
      expect(() => resolveMainnetConfig(mainnetEnv({ VITE_II_CANISTER_ID: value })))
        .toThrow(/VITE_II_CANISTER_ID/);
    },
  );

  it.each([undefined, "local", "", "IC", " ic", "ic ", "staging", null])(
    "leaves non-mainnet configuration untouched: %j",
    (network) => {
      const env = Object.freeze({
        VITE_DFX_NETWORK: network,
        VITE_IOU_BACKEND_CANISTER_ID: "synthetic-backend",
        VITE_IOU_PROD_VETKD: "0",
        VITE_DFX_PORT: "8080",
        VITE_IOU_LAN_QC_II_ORIGIN: "https://device.sample-tailnet.ts.net:9444",
        VITE_IOU_LAN_QC_OPENCHAT_ORIGIN: "https://device.sample-tailnet.ts.net:9445",
        IOU_HOST: "http://localhost:4943",
        VITE_IC_URL: "http://127.0.0.1:4943",
        VITE_OC_IC_URL: "http://127.0.0.1:4944",
        VITE_OPENCHAT_HOST: "http://localhost:5001",
        VITE_II_CANISTER_ID: "synthetic-identity",
      });
      const before = { ...env };
      expect(resolveMainnetConfig(env)).toBeUndefined();
      expect(env).toEqual(before);
    },
  );
});
