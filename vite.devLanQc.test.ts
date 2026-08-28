import { describe, expect, it } from "vitest";
import { resolveOpenChatDevAllowedHosts } from "./vite.devLanQc";

const localDevelopment = { isDevelopment: true, dfxNetwork: "local" };

describe("resolveOpenChatDevAllowedHosts", () => {
  it("extracts only the exact hostname from a validated Tailscale origin", () => {
    expect(
      resolveOpenChatDevAllowedHosts(
        "https://device.sample-tailnet.ts.net:8443",
        localDevelopment,
      ),
    ).toEqual(["device.sample-tailnet.ts.net"]);
  });

  it("preserves an exact private-IP host for LAN development", () => {
    expect(
      resolveOpenChatDevAllowedHosts(
        "http://192.168.10.25:5003",
        localDevelopment,
      ),
    ).toEqual(["192.168.10.25"]);
  });

  it("keeps the allowlist empty without an active local-development origin", () => {
    expect(resolveOpenChatDevAllowedHosts(undefined, localDevelopment)).toEqual(
      [],
    );
    expect(
      resolveOpenChatDevAllowedHosts("https://device.sample-tailnet.ts.net", {
        isDevelopment: false,
        dfxNetwork: "local",
      }),
    ).toEqual([]);
    expect(
      resolveOpenChatDevAllowedHosts("https://device.sample-tailnet.ts.net", {
        isDevelopment: true,
        dfxNetwork: "ic",
      }),
    ).toEqual([]);
  });

  it.each([
    "https://*.ts.net",
    "https://device.sample-tailnet.ts.net.evil",
    "https://device.sample-tailnet.ts.net/path",
  ])("rejects an invalid or broadened host setting: %s", (origin) => {
    expect(() =>
      resolveOpenChatDevAllowedHosts(origin, localDevelopment),
    ).toThrow(/exact OpenChat development origin/);
  });
});
