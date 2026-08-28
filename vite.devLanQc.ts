const PRIVATE_LAN_HTTP_ORIGIN =
  /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/;
const TAILSCALE_HTTPS_ORIGIN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::[1-9]\d{0,4})?$/;

type DevLanQcContext = {
  isDevelopment: boolean;
  dfxNetwork: string;
};

function isCanonicalRfc1918Origin(value: string): boolean {
  const match = PRIVATE_LAN_HTTP_ORIGIN.exec(value);
  if (!match) return false;
  const parts = match[1].split(".");
  if (
    !parts.every(
      (part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255,
    )
  ) {
    return false;
  }
  const [first, second] = parts.map(Number);
  const port = Number(match[2]);
  return (
    port <= 65_535 &&
    (first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168))
  );
}

function isExactTailscaleHttpsOrigin(value: string): boolean {
  const match = TAILSCALE_HTTPS_ORIGIN.exec(value);
  if (!match) return false;
  const portSeparator = value.lastIndexOf(":");
  if (portSeparator <= "https://".length) return true;
  return Number(value.slice(portSeparator + 1)) <= 65_535;
}

export function resolveOpenChatDevOrigin(
  value: string | undefined,
  context: DevLanQcContext,
): string | undefined {
  if (
    !context.isDevelopment ||
    context.dfxNetwork !== "local" ||
    value === undefined ||
    value === ""
  ) {
    return undefined;
  }
  if (
    value === "http://tauri.localhost" ||
    isCanonicalRfc1918Origin(value) ||
    isExactTailscaleHttpsOrigin(value)
  )
    return value;
  throw new Error(
    "VITE_IOU_LAN_QC_OPENCHAT_ORIGIN must be an exact OpenChat development origin",
  );
}

/**
 * Vite's host allowlist is derived from the same exact origin used for the OpenChat frame policy.
 * Invalid input is rejected by resolveOpenChatDevOrigin; an absent or out-of-scope setting yields
 * an empty list, preserving Vite's built-in loopback/IP defaults without permitting arbitrary DNS.
 */
export function resolveOpenChatDevAllowedHosts(
  value: string | undefined,
  context: DevLanQcContext,
): string[] {
  const origin = resolveOpenChatDevOrigin(value, context);
  return origin === undefined ? [] : [new URL(origin).hostname];
}

export function resolveDevLanQcTlsPaths(
  certPath: string | undefined,
  keyPath: string | undefined,
  context: DevLanQcContext,
): { certPath: string; keyPath: string } | undefined {
  if (!context.isDevelopment || context.dfxNetwork !== "local")
    return undefined;
  if (
    (certPath === undefined || certPath === "") &&
    (keyPath === undefined || keyPath === "")
  ) {
    return undefined;
  }
  if (
    certPath === undefined ||
    certPath === "" ||
    certPath !== certPath.trim() ||
    keyPath === undefined ||
    keyPath === "" ||
    keyPath !== keyPath.trim()
  ) {
    throw new Error(
      "IOU LAN QC HTTPS requires both an exact certificate and key path",
    );
  }
  return { certPath, keyPath };
}
