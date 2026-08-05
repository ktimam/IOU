// Provenance tokens for the OpenChat → IOU draft path.
//
// In the confirmed-draft flow, OpenChat forwards a plaintext draft to IOU's
// relay together with a signed token proving WHICH OpenChat user produced it.
// IOU's relay verifies that token before routing the draft. This module is the
// verification seam: an Ed25519-signed compact token `b64url(payload).b64url(sig)`.
//
// PRODUCTION SEAM: OpenChat signs with ITS key; IOU's relay holds OpenChat's
// PUBLIC key (env IOU_OPENCHAT_PUBKEY, PEM) and only verifies — it never holds a
// private key, so it cannot forge provenance. The exact claim set / key format
// will be finalized against the OpenChat PR; the verify function below is the
// single place to adapt. `sign` exists for tests and for a local IOU bot that
// stands in for OpenChat until the real connector lands.

import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

export type OpenChatTokenPurpose = "pairing" | "draft";

export type OpenChatClaims = {
  iss: "openchat";
  aud: "iou-relay";
  purpose: OpenChatTokenPurpose;
  sub: string; // OpenChat user id
  jti: string; // unique token id, consumed once by the relay
  iat: number; // issued-at (ms epoch)
  exp: number; // expiry (ms epoch)
};

const MAX_TOKEN_CHARS = 4096;
const MAX_PAYLOAD_BYTES = 2048;
const MAX_TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 30 * 1000;
const TOKEN_ID = /^[A-Za-z0-9_-]{22,128}$/;

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  const decoded = Buffer.from(
    s.replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
  return b64url(decoded) === s ? decoded : null;
};

/** Bounded in-memory single-use token cache. Tokens expire within five minutes. */
export class OpenChatReplayGuard {
  private readonly used = new Map<string, number>();

  constructor(private readonly maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
  }

  consume(claims: OpenChatClaims, now: number): boolean {
    for (const [jti, expiry] of this.used) {
      if (expiry <= now) this.used.delete(jti);
    }
    if (claims.exp <= now || this.used.has(claims.jti)) return false;
    if (this.used.size >= this.maxEntries) return false;
    this.used.set(claims.jti, claims.exp);
    return true;
  }
}

/** Sign claims into a compact token (test / local-bot use; OpenChat does this in prod). */
export function signOpenChatToken(claims: OpenChatClaims, privateKeyPem: string | KeyObject): string {
  const key = typeof privateKeyPem === "string" ? createPrivateKey(privateKeyPem) : privateKeyPem;
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = b64url(edSign(null, Buffer.from(payload, "utf8"), key));
  return `${payload}.${sig}`;
}

/**
 * Verify a token against OpenChat's public key. Returns the claims, or null if
 * malformed / bad signature / expired. Never throws.
 */
export function verifyOpenChatToken(
  token: string,
  publicKeyPem: string | KeyObject,
  now: number,
  expectedPurpose: OpenChatTokenPurpose,
): OpenChatClaims | null {
  try {
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > MAX_TOKEN_CHARS ||
      !Number.isSafeInteger(now)
    ) {
      return null;
    }
    const key = typeof publicKeyPem === "string" ? createPublicKey(publicKeyPem) : publicKeyPem;
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [payloadPart, sigPart] = parts;
    const payload = fromB64url(payloadPart);
    const signature = fromB64url(sigPart);
    if (
      !payload ||
      payload.length > MAX_PAYLOAD_BYTES ||
      !signature ||
      signature.length !== 64
    ) {
      return null;
    }
    if (!edVerify(null, Buffer.from(payloadPart, "utf8"), key, signature)) return null;
    const claims = JSON.parse(payload.toString("utf8")) as OpenChatClaims;
    if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
    if (claims.iss !== "openchat" || claims.aud !== "iou-relay") return null;
    if (claims.purpose !== expectedPurpose) return null;
    if (
      typeof claims.sub !== "string" ||
      claims.sub.length < 1 ||
      claims.sub.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(claims.sub)
    ) {
      return null;
    }
    if (typeof claims.jti !== "string" || !TOKEN_ID.test(claims.jti)) return null;
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)) {
      return null;
    }
    if (
      claims.iat > now + MAX_CLOCK_SKEW_MS ||
      claims.exp <= now ||
      claims.exp <= claims.iat ||
      claims.exp - claims.iat > MAX_TOKEN_LIFETIME_MS
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
