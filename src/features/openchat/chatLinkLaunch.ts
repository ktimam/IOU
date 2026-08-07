export const OPENCHAT_ROUTING_HASH = "#openchat-routing";
const OPENCHAT_ROUTING_TOKEN_PREFIX = `${OPENCHAT_ROUTING_HASH}/`;
const CANONICAL_TOKEN = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

type LocationLike = Pick<Location, "hash" | "pathname" | "search">;
type HistoryLike = Pick<History, "state" | "replaceState">;

/** Accept only the manifest's exact fragment form and canonical 32-byte base64url spelling. */
export function parseOpenChatRoutingToken(hash: string): string | null {
  if (!hash.startsWith(OPENCHAT_ROUTING_TOKEN_PREFIX)) return null;
  const token = hash.slice(OPENCHAT_ROUTING_TOKEN_PREFIX.length);
  return CANONICAL_TOKEN.test(token) ? token : null;
}

/**
 * Remove token-shaped and malformed routing fragments from browser history before any network
 * call. The returned token exists only in JavaScript memory; it is never copied to storage, DOM,
 * query parameters, logs, or an error message.
 */
export function consumeAndScrubOpenChatRoutingFragment(
  location: LocationLike,
  history: HistoryLike,
): string | null {
  if (!location.hash.startsWith(OPENCHAT_ROUTING_TOKEN_PREFIX)) return null;
  const token = parseOpenChatRoutingToken(location.hash);
  history.replaceState(
    history.state,
    "",
    `${location.pathname}${location.search}${OPENCHAT_ROUTING_HASH}`,
  );
  return token;
}

// Authentication changes remount SessionProviders. A module-scoped, process-memory-only handoff
// keeps the already-scrubbed token alive across that remount (including signing out of the wrong
// default-browser account and into the matching IOU account) without weakening the storage rule.
let pendingLaunchToken: string | null = null;

export function captureOpenChatRoutingLaunch(): string | null {
  if (typeof window === "undefined") return pendingLaunchToken;
  if (window.location.hash.startsWith(OPENCHAT_ROUTING_TOKEN_PREFIX)) {
    pendingLaunchToken = consumeAndScrubOpenChatRoutingFragment(
      window.location,
      window.history,
    );
  }
  return pendingLaunchToken;
}

export function clearOpenChatRoutingLaunch(expectedToken: string): void {
  if (pendingLaunchToken === expectedToken) pendingLaunchToken = null;
}
