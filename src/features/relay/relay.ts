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
export type PendingDraft = { id: string; draft: unknown; created_at: number };

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
