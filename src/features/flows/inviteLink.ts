// Invite-link build/parse helpers.
//
// The invite link replaces the old "6-digit code + creator grants access"
// flow. Opening it lets the invitee self-join (accept_invite) with immediate
// read/write access — no creator step. The secret material rides in the URL
// FRAGMENT (`#…`), which browsers never send to any server, so the invite code
// and independent production invite unlock secret stay client-only.
//
// Format:  <origin>/pair/accept#c=<invite_code>&s=<active_sheet_id>&k=<base64url(K_sheet)>
// Production uses `v=1&u=<random invite secret>` to unlock an encrypted server
// envelope. `k` remains a development-only raw key; old production links fail closed.
//
// SECURITY: the link is a single-use bearer capability — whoever holds it can
// accept once (the canister consumes the invite on accept). Treat it like a
// password.

export const ACCEPT_PATH = "/pair/accept";

export type InviteParams = {
  code: string;
  sheetId: string;
  keyB64u?: string; // present in dev; absent in prod
  inviteSecretB64u?: string; // independent 256-bit production invite secret, never K_sheet
};

// URL-safe base64 (no padding), portable across browser + node (tests).
export function b64uEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(bytes).toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin =
    typeof atob === "function"
      ? atob(b64 + pad)
      : Buffer.from(b64 + pad, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Build a bearer link; never mix development raw keys and production secrets. */
export function buildInviteLink(
  origin: string,
  p: { code: string; sheetId: string; kSheet?: Uint8Array; inviteSecretB64u?: string },
): string {
  if (p.kSheet && p.inviteSecretB64u) throw new Error("Ambiguous invitation key format");
  const frag = new URLSearchParams();
  frag.set("c", p.code);
  frag.set("s", p.sheetId);
  if (p.kSheet && p.kSheet.length > 0) frag.set("k", b64uEncode(p.kSheet));
  if (p.inviteSecretB64u) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.inviteSecretB64u) || b64uEncode(b64uDecode(p.inviteSecretB64u)) !== p.inviteSecretB64u) throw new Error("Invalid invitation secret");
    frag.set("v", "1"); frag.set("u", p.inviteSecretB64u);
  }
  // strip a trailing slash on origin so we never emit "…//pair/accept"
  const base = origin.replace(/\/+$/, "");
  return `${base}${ACCEPT_PATH}#${frag.toString()}`;
}

/**
 * Parse the invite parameters from a URL fragment (with or without the leading
 * "#"). Returns null if the required `c` (code) or `s` (sheet id) are missing.
 */
export function parseInviteFragment(fragment: string): InviteParams | null {
  const f = (fragment || "").replace(/^#/, "");
  if (!f) return null;
  const q = new URLSearchParams(f);
  const code = (q.get("c") || "").trim();
  const sheetId = (q.get("s") || "").trim();
  if (!code || !sheetId) return null;
  const k = (q.get("k") || "").trim();
  const secret = (q.get("u") || "").trim();
  if (secret || q.has("v")) {
    if (k || q.get("v") !== "1" || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    try { if (b64uEncode(b64uDecode(secret)) !== secret) return null; } catch { return null; }
    return { code, sheetId, inviteSecretB64u: secret };
  }
  return { code, sheetId, keyB64u: k || undefined };
}
