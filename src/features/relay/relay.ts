// Client for the key-blind draft relay (no-paste chat import).
//
// The chat connector pushes a prepared draft to the relay; this app polls for
// the user's pending drafts and imports each through the normal confirm screen
// (the encrypted write happens here, on-device). The relay only ever holds the
// plaintext draft — never K_sheet. See scripts/iou-relay/server.ts and
// docs/chat-agent.md.
//
// Routing/auth (prototype): an opaque LINK TOKEN — a shared secret the user
// generates here and copies once into their connector config (IOU_LINK_TOKEN).
// Treat it like a password. Mobile/production would replace it with OAuth
// (Claude-user → IOU-principal); the relay API below is unchanged.

import { scopedStorageKey } from "../storage/scopedStorage";
import type { InboxDraftContext } from "../openchat/actionInboxClient";

const URL_KEY = "iou:relay:url";
const TOKEN_KEY = "iou:relay:token";

export function relayStorageKey(
  kind: "url" | "token",
  principal: string,
  deployment?: string,
): string {
  return scopedStorageKey(kind === "url" ? URL_KEY : TOKEN_KEY, principal, deployment);
}

function purgeUnscopedRelaySecrets(): void {
  try {
    localStorage.removeItem(URL_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage may be unavailable */
  }
}

export type RelayConfig = { url: string; token: string };
export type PendingDraft = {
  id: string;
  draft: unknown;
  created_at: number;
  // Where the draft came from. Absent/"connector" = the Claude/MCP connector
  // or a paste; "openchat" = forwarded by a paired OpenChat integration.
  source?: "connector" | "openchat";
  provenance?: { openchat_user: string };
  // App-scoped delivery provenance from the on-chain v4 envelope. It contains only
  // HMAC pseudonyms; raw OpenChat user/chat/message coordinates never enter IOU.
  context?: InboxDraftContext;
};
export type OpenChatPairing = { openchat_user: string; created_at: number };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Relay credentials are bearer secrets. Remote relays therefore require TLS;
 * cleartext HTTP is accepted only for an exact loopback hostname during local
 * development. A relay setting is an origin, not a path-bearing endpoint.
 */
export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("relay URL must be an absolute HTTPS origin");
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("relay URL must use HTTPS (HTTP is allowed only for loopback development)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("relay URL must not contain credentials, a query, or a fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("relay URL must be an origin without a path");
  }
  return url.origin;
}

export function getRelayConfig(principal: string | null | undefined): RelayConfig | null {
  if (!principal) return null;
  try {
    purgeUnscopedRelaySecrets();
    const url = localStorage.getItem(relayStorageKey("url", principal))?.trim();
    const token = localStorage.getItem(relayStorageKey("token", principal))?.trim();
    if (!url || !token) return null;
    return { url: normalizeRelayUrl(url), token };
  } catch {
    return null;
  }
}

export function getRelayUrl(principal: string | null | undefined): string {
  if (!principal) return "";
  try {
    purgeUnscopedRelaySecrets();
    return localStorage.getItem(relayStorageKey("url", principal))?.trim() ?? "";
  } catch {
    return "";
  }
}

export function getRelayToken(principal: string | null | undefined): string {
  if (!principal) return "";
  try {
    purgeUnscopedRelaySecrets();
    return localStorage.getItem(relayStorageKey("token", principal))?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setRelayConfig(
  principal: string | null | undefined,
  url: string,
  token: string,
): void {
  if (!principal) throw new Error("sign in before saving relay credentials");
  try {
    purgeUnscopedRelaySecrets();
    const urlKey = relayStorageKey("url", principal);
    const tokenKey = relayStorageKey("token", principal);
    if (url.trim()) localStorage.setItem(urlKey, normalizeRelayUrl(url));
    else localStorage.removeItem(urlKey);
    if (token.trim()) localStorage.setItem(tokenKey, token.trim());
    else localStorage.removeItem(tokenKey);
  } catch {
    /* ignore */
  }
}

/** Generate a random link token (>= 24 chars) to copy into the connector. */
export function generateToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return "iou_" + hex; // 4 + 48 = 52 chars
}

function base(url: string): string {
  return normalizeRelayUrl(url);
}

function authenticatedInit(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers).entries()), Authorization: `Bearer ${token}` },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  };
}

export async function fetchPending(cfg: RelayConfig): Promise<PendingDraft[]> {
  const r = await fetch(`${base(cfg.url)}/v1/drafts`, authenticatedInit(cfg.token));
  if (!r.ok) throw new Error(`relay ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.drafts) ? j.drafts : [];
}

export async function deletePending(cfg: RelayConfig, id: string): Promise<void> {
  await fetch(
    `${base(cfg.url)}/v1/drafts/${encodeURIComponent(id)}`,
    authenticatedInit(cfg.token, { method: "DELETE" }),
  );
}

// --- OpenChat pairing (consumer side) ---
// The relay binds an OpenChat user to this link token so OpenChat-forwarded
// drafts route to this account's inbox. Provenance is verified relay-side
// against OpenChat's public key; the relay stays key-blind (never K_sheet).

/** Start a pairing: returns a short code the user gives the OpenChat integration. */
export async function startPairing(
  cfg: RelayConfig,
): Promise<{ code: string; expires_in_ms: number }> {
  const r = await fetch(`${base(cfg.url)}/v1/pairings/start`, {
    ...authenticatedInit(cfg.token, { method: "POST" }),
  });
  if (!r.ok) throw new Error(`pairing start ${r.status}`);
  return r.json();
}

/** List the OpenChat users currently linked to this account. */
export async function listPairings(cfg: RelayConfig): Promise<OpenChatPairing[]> {
  const r = await fetch(`${base(cfg.url)}/v1/pairings`, authenticatedInit(cfg.token));
  if (!r.ok) throw new Error(`pairings ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.pairings) ? j.pairings : [];
}

/** Revoke a linked OpenChat user. */
export async function revokePairing(cfg: RelayConfig, openchatUser: string): Promise<void> {
  await fetch(
    `${base(cfg.url)}/v1/pairings/${encodeURIComponent(openchatUser)}`,
    authenticatedInit(cfg.token, { method: "DELETE" }),
  );
}
