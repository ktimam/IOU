import { describe, expect, it } from "vitest";
import {
  isLocalDevelopmentIcOrigin,
  parseOpenChatDevOrigin,
  parsePrivateLanHttpOrigin,
  parsePrivateLanHttpsOrigin,
  resolveDevLanQcOrigin,
  resolveDevLanQcTlsPaths,
  shouldFetchRootKeyForNetwork,
} from "./devLanQc";

describe("parsePrivateLanHttpOrigin", () => {
  it.each([
    "http://10.0.0.1:1",
    "http://172.16.0.1:5003",
    "http://172.31.255.254:65535",
    "http://192.168.2.95:5003",
  ])("accepts an exact RFC1918 HTTP origin with an explicit port: %s", (origin) => {
    expect(parsePrivateLanHttpOrigin(origin)).toBe(origin);
  });

  it.each([
    "http://8.8.8.8:5003",
    "http://172.15.0.1:5003",
    "http://172.32.0.1:5003",
    "http://192.169.0.1:5003",
    "https://192.168.2.95:5003",
    "http://openchat.test:5003",
    "http://*.local:5003",
    "http://192.168.2.95",
    "http://192.168.2.95:0",
    "http://192.168.2.95:65536",
    "http://192.168.002.95:5003",
    "http://user@192.168.2.95:5003",
    "http://192.168.2.95:5003/",
    "http://192.168.2.95:5003/path",
    "http://192.168.2.95:5003?query=1",
    "http://192.168.2.95:5003#fragment",
    " http://192.168.2.95:5003",
  ])("rejects anything other than the exact private-IP origin form: %s", (origin) => {
    expect(() => parsePrivateLanHttpOrigin(origin)).toThrow(/RFC1918 HTTP origin/);
  });
});

describe("parseOpenChatDevOrigin", () => {
  it.each([
    "http://tauri.localhost",
    "http://10.0.0.1:5003",
    "http://172.20.0.1:5003",
    "http://192.168.2.95:5003",
    "https://device.sample-tailnet.ts.net",
  ])("allows only a native, private-IP, or Tailscale development origin: %s", (origin) => {
    expect(parseOpenChatDevOrigin(origin)).toBe(origin);
  });

  it.each([
    "http://tauri.localhost:5003",
    "https://tauri.localhost",
    "http://openchat.test:5003",
    "http://8.8.8.8:5003",
    "http://192.168.2.95:5003/",
    "http://device.sample-tailnet.ts.net",
    "https://SAMPLE-TAILNET.ts.net",
    "https://device.sample-tailnet.ts.net.evil",
    "https://evilts.net",
    "https://device.sample-tailnet.ts.net/",
  ])("rejects a broader configured frame origin: %s", (origin) => {
    expect(() => parseOpenChatDevOrigin(origin)).toThrow(/OpenChat development origin/);
  });
});

describe("parsePrivateLanHttpsOrigin", () => {
  it.each([
    "https://10.0.0.1:8443",
    "https://172.31.0.5:443",
    "https://192.168.2.95:8443",
    "https://device.sample-tailnet.ts.net:8444",
  ])("accepts an exact private-IP or Tailscale HTTPS IC origin: %s", (origin) => {
    expect(parsePrivateLanHttpsOrigin(origin)).toBe(origin);
  });

  it.each([
    "http://192.168.2.95:8443",
    "https://8.8.8.8:8443",
    "https://ic.test:8443",
    "https://192.168.2.95",
    "https://192.168.2.95:8443/",
    "https://device.sample-tailnet.ts.net",
    "https://device.sample-tailnet.ts.net:0",
    "https://device.sample-tailnet.ts.net:65536",
    "https://DEVICE.sample-tailnet.ts.net:8444",
    "https://device.sample-tailnet.ts.net.evil:8444",
  ])("rejects a non-private or non-exact IC origin: %s", (origin) => {
    expect(() => parsePrivateLanHttpsOrigin(origin)).toThrow(/development HTTPS origin/);
  });
});

describe("resolveDevLanQcOrigin", () => {
  const origin = "https://192.168.2.95:8443";

  it("enables the LAN origin only for a development build on the local dfx network", () => {
    expect(
      resolveDevLanQcOrigin(origin, { isDevelopment: true, dfxNetwork: "local" }),
    ).toBe(origin);
  });

  it.each([
    { isDevelopment: false, dfxNetwork: "local" },
    { isDevelopment: true, dfxNetwork: "ic" },
    { isDevelopment: false, dfxNetwork: "ic" },
  ])("ignores the LAN setting outside local development: %j", (context) => {
    expect(resolveDevLanQcOrigin(origin, context)).toBeUndefined();
  });

  it("fails closed on an invalid setting in local development", () => {
    expect(() =>
      resolveDevLanQcOrigin("http://example.com:5003", {
        isDevelopment: true,
        dfxNetwork: "local",
      }),
    ).toThrow(/development HTTPS origin/);
  });

  it("accepts the exact private Tailscale HTTPS IC endpoint only in local development", () => {
    const tailnetOrigin = "https://device.sample-tailnet.ts.net:8444";
    expect(
      resolveDevLanQcOrigin(tailnetOrigin, {
        isDevelopment: true,
        dfxNetwork: "local",
      }),
    ).toBe(tailnetOrigin);
    expect(
      resolveDevLanQcOrigin(tailnetOrigin, {
        isDevelopment: false,
        dfxNetwork: "local",
      }),
    ).toBeUndefined();
    expect(
      resolveDevLanQcOrigin(tailnetOrigin, {
        isDevelopment: true,
        dfxNetwork: "ic",
      }),
    ).toBeUndefined();
  });
});

describe("resolveDevLanQcTlsPaths", () => {
  const localDev = { isDevelopment: true, dfxNetwork: "local" };

  it("requires an explicit certificate and key together", () => {
    expect(resolveDevLanQcTlsPaths("D:/cert.pem", "D:/key.pem", localDev)).toEqual({
      certPath: "D:/cert.pem",
      keyPath: "D:/key.pem",
    });
    expect(() => resolveDevLanQcTlsPaths("D:/cert.pem", undefined, localDev)).toThrow(
      /certificate and key/i,
    );
    expect(() => resolveDevLanQcTlsPaths(undefined, "D:/key.pem", localDev)).toThrow(
      /certificate and key/i,
    );
  });

  it("ignores stale TLS envs outside local development", () => {
    expect(
      resolveDevLanQcTlsPaths("D:/cert.pem", "D:/key.pem", {
        isDevelopment: false,
        dfxNetwork: "local",
      }),
    ).toBeUndefined();
  });
});

describe("isLocalDevelopmentIcOrigin", () => {
  const lanOrigin = "https://192.168.2.95:8443";

  it.each([
    "http://localhost:8080",
    "https://127.0.0.1:4943",
    "http://[::1]:8080",
    lanOrigin,
  ])("recognizes an exact loopback or explicitly configured LAN origin: %s", (origin) => {
    expect(isLocalDevelopmentIcOrigin(origin, lanOrigin)).toBe(true);
  });

  it.each([
    "https://192.168.2.95:8080",
    "https://192.168.2.96:8443",
    "https://8.8.8.8:8443",
    "http://localhost.example:5003",
    "http://localhost:5003/path",
  ])("does not broaden the local exemption: %s", (origin) => {
    expect(isLocalDevelopmentIcOrigin(origin, lanOrigin)).toBe(false);
  });
});

describe("shouldFetchRootKeyForNetwork", () => {
  it("is controlled by the dfx network, not by URL spelling", () => {
    expect(shouldFetchRootKeyForNetwork("local")).toBe(true);
    expect(shouldFetchRootKeyForNetwork("ic")).toBe(false);
    expect(shouldFetchRootKeyForNetwork("staging")).toBe(false);
  });
});
