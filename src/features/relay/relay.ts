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

const URL_KEY = "iou:relay:url";
const TOKEN_KEY = "iou:relay:token";

export type RelayConfig = { url: string; token: string };
export type PendingDraft = {
  id: string;
  draft: unknown;
  created_at: number;
  // Where the draft came from. Absent/"connector" = the Claude/MCP connector
  // or a paste; "openchat" = forwarded by a paired OpenChat integration.
  source?: "connector" | "openchat";
  provenance?: { openchat_user: string };
};
export type OpenChatPairing = { openchat_user: string; created_at: number };

export function getRelayConfig(): RelayConfig | null {
  try {
    const url = localStorage.getItem(URL_KEY)?.trim();
    const token = localStorage.getItem(TOKEN_KEY)?.trim();
    if (!url || !token) return null;
    return { url, token };
  } catch {
    return null;
  }
}

export function getRelayUrl(): string {
  try {
    return localStorage.getItem(URL_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function getRelayToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function setRelayConfig(url: string, token: string): void {
  try {
    if (url.trim()) localStorage.setItem(URL_KEY, url.trim());
    else localStorage.removeItem(URL_KEY);
    if (token.trim()) localStorage.setItem(TOKEN_KEY, token.trim());
    else localStorage.removeItem(TOKEN_KEY);
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
  return url.replace(/\/+$/, "");
}

export async function fetchPending(cfg: RelayConfig): Promise<PendingDraft[]> {
  const r = await fetch(
    `${base(cfg.url)}/v1/drafts?token=${encodeURIComponent(cfg.token)}`,
  );
  if (!r.ok) throw new Error(`relay ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.drafts) ? j.drafts : [];
}

export async function deletePending(cfg: RelayConfig, id: string): Promise<void> {
  await fetch(
    `${base(cfg.url)}/v1/drafts/${encodeURIComponent(id)}?token=${encodeURIComponent(cfg.token)}`,
    { method: "DELETE" },
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: cfg.token }),
  });
  if (!r.ok) throw new Error(`pairing start ${r.status}`);
  return r.json();
}

/** List the OpenChat users currently linked to this account. */
export async function listPairings(cfg: RelayConfig): Promise<OpenChatPairing[]> {
  const r = await fetch(
    `${base(cfg.url)}/v1/pairings?token=${encodeURIComponent(cfg.token)}`,
  );
  if (!r.ok) throw new Error(`pairings ${r.status}`);
  const j = await r.json();
  return Array.isArray(j.pairings) ? j.pairings : [];
}

/** Revoke a linked OpenChat user. */
export async function revokePairing(cfg: RelayConfig, openchatUser: string): Promise<void> {
  await fetch(
    `${base(cfg.url)}/v1/pairings/${encodeURIComponent(openchatUser)}?token=${encodeURIComponent(cfg.token)}`,
    { method: "DELETE" },
  );
}
