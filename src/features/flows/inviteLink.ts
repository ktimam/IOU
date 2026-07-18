// Invite-link build/parse helpers.
//
// The invite link replaces the old "6-digit code + creator grants access"
// flow. Opening it lets the invitee self-join (accept_invite) with immediate
// read/write access — no creator step. The secret material rides in the URL
// FRAGMENT (`#…`), which browsers never send to any server, so the invite code
// and (in the dev/P-256 build) the sheet key K_sheet stay client-only.
//
// Format:  <origin>/pair/accept#c=<invite_code>&s=<active_sheet_id>&k=<base64url(K_sheet)>
// In the prod (vetkd IBE) build `k` is omitted — the IC re-derives K_sheet for
// any member, so membership alone (accept_invite flipping member_b) suffices.
//
// SECURITY: the link is a single-use bearer capability — whoever holds it can
// accept once (the canister consumes the invite on accept). Treat it like a
// password.

export const ACCEPT_PATH = "/pair/accept";

export type InviteParams = {
  code: string;
  sheetId: string;
  keyB64u?: string; // present in dev; absent in prod
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

/** Build the shareable invite link. Omit `kSheet` in the prod build. */
export function buildInviteLink(
  origin: string,
  p: { code: string; sheetId: string; kSheet?: Uint8Array },
): string {
  const frag = new URLSearchParams();
  frag.set("c", p.code);
  frag.set("s", p.sheetId);
  if (p.kSheet && p.kSheet.length > 0) frag.set("k", b64uEncode(p.kSheet));
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
  return { code, sheetId, keyB64u: k || undefined };
}
