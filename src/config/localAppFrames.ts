/** Explicit local-test app windows only; this setting never changes production framing. */
export function resolveLocalAppFrameOrigins(value: unknown, context: { isDevelopment: boolean; dfxNetwork: string }): string[] {
  if (!context.isDevelopment || context.dfxNetwork !== "local" || value === undefined || value === "") return [];
  if (typeof value !== "string") throw new Error("Local app frame origins must be a JSON list");
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 4 || new Set(parsed).size !== parsed.length) {
    throw new Error("Configure one to four distinct local app frame origins");
  }
  return parsed.map(origin => {
    if (typeof origin !== "string" || !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):[1-9][0-9]{3,4}$/.test(origin)) {
      throw new Error("Local app frame origins must be exact loopback addresses with ports");
    }
    const url = new URL(origin);
    if (url.origin !== origin || Number(url.port) < 1024 || Number(url.port) > 65535) throw new Error("Invalid local app frame origin");
    return origin;
  });
}

export function isLocalAppFrameRoute(requestUrl: string | undefined): boolean {
  return requestUrl === "/openchat/import" || requestUrl === "/openchat/connect" || requestUrl === "/openchat/connect.html";
}
