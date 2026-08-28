const PRIVATE_LAN_HTTP_ORIGIN =
  /^http:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/;
const PRIVATE_LAN_HTTPS_ORIGIN =
  /^https:\/\/((?:\d{1,3}\.){3}\d{1,3}):([1-9]\d{0,4})$/;
const TAILSCALE_HTTPS_ORIGIN =
  /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net)(?::([1-9]\d{0,4}))?$/;

export type DevLanQcContext = {
  isDevelopment: boolean;
  dfxNetwork: string;
};

function isCanonicalIpv4Octet(value: string): boolean {
  return /^(?:0|[1-9]\d{0,2})$/.test(value) && Number(value) <= 255;
}

function isRfc1918(octets: readonly number[]): boolean {
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function requirePrivateLanOrigin(
  value: string,
  pattern: RegExp,
  errorMessage: string,
): string {
  const match = pattern.exec(value);
  if (!match) throw new Error(errorMessage);
  const parts = match[1].split(".");
  if (!parts.every(isCanonicalIpv4Octet)) throw new Error(errorMessage);
  const octets = parts.map(Number);
  const port = Number(match[2]);
  if (!isRfc1918(octets) || port > 65_535) throw new Error(errorMessage);
  return value;
}

function requireTailscaleHttpsOrigin(
  value: string,
  requireExplicitPort: boolean,
  errorMessage: string,
): string {
  const match = TAILSCALE_HTTPS_ORIGIN.exec(value);
  const portText = match?.[2];
  if (
    !match ||
    (requireExplicitPort && portText === undefined) ||
    (portText !== undefined && Number(portText) > 65_535)
  ) {
    throw new Error(errorMessage);
  }
  return value;
}

/**
 * Parse the explicit LAN-QC escape hatch. It intentionally accepts only a canonical RFC1918 IPv4
 * literal plus an explicit non-zero TCP port. DNS names, wildcards, paths, credentials, HTTPS and
 * public/reserved addresses are outside this local test contract.
 */
export function parsePrivateLanHttpOrigin(value: string): string {
  return requirePrivateLanOrigin(
    value,
    PRIVATE_LAN_HTTP_ORIGIN,
    "VITE_IOU_LAN_QC_OPENCHAT_ORIGIN must be an exact RFC1918 HTTP origin with an explicit port",
  );
}

export function parseOpenChatDevOrigin(value: string): string {
  if (value === "http://tauri.localhost") return value;
  try {
    return parsePrivateLanHttpOrigin(value);
  } catch {
    return requireTailscaleHttpsOrigin(
      value,
      false,
      "VITE_IOU_LAN_QC_OPENCHAT_ORIGIN must be an exact OpenChat development origin",
    );
  }
}

export function parsePrivateLanHttpsOrigin(value: string): string {
  const errorMessage =
    "VITE_IC_URL must be an exact RFC1918 or Tailscale development HTTPS origin with an explicit port";
  try {
    return requirePrivateLanOrigin(value, PRIVATE_LAN_HTTPS_ORIGIN, errorMessage);
  } catch {
    return requireTailscaleHttpsOrigin(value, true, errorMessage);
  }
}

/** LAN QC is ignored by production builds and by every non-local dfx network. */
export function resolveDevLanQcOrigin(
  value: string | undefined,
  context: DevLanQcContext,
): string | undefined {
  if (!context.isDevelopment || context.dfxNetwork !== "local") return undefined;
  if (value === undefined || value === "") return undefined;
  return parsePrivateLanHttpsOrigin(value);
}

export function resolveOpenChatDevOrigin(
  value: string | undefined,
  context: DevLanQcContext,
): string | undefined {
  if (!context.isDevelopment || context.dfxNetwork !== "local") return undefined;
  if (value === undefined || value === "") return undefined;
  return parseOpenChatDevOrigin(value);
}

export type DevLanQcTlsPaths = {
  certPath: string;
  keyPath: string;
};

export function resolveDevLanQcTlsPaths(
  certPath: string | undefined,
  keyPath: string | undefined,
  context: DevLanQcContext,
): DevLanQcTlsPaths | undefined {
  if (!context.isDevelopment || context.dfxNetwork !== "local") return undefined;
  if ((certPath === undefined || certPath === "") && (keyPath === undefined || keyPath === "")) {
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

export function shouldFetchRootKeyForNetwork(dfxNetwork: string): boolean {
  return dfxNetwork === "local";
}

function isExactLoopbackOrigin(value: string): boolean {
  if (value === "" || value !== value.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Decide whether an IC agent may fetch a local replica root key. The private-IP case is exact: only
 * the one validated LAN origin supplied by the development runtime receives the exemption.
 */
export function isLocalDevelopmentIcOrigin(
  value: string,
  configuredLanOrigin: string | undefined,
): boolean {
  return isExactLoopbackOrigin(value) ||
    (configuredLanOrigin !== undefined && value === configuredLanOrigin);
}
