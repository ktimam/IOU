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

export type OpenChatClaims = {
  sub: string; // OpenChat user id
  iat: number; // issued-at (ms epoch)
  exp: number; // expiry (ms epoch)
};

const b64url = (b: Buffer): string =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

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
): OpenChatClaims | null {
  try {
    const key = typeof publicKeyPem === "string" ? createPublicKey(publicKeyPem) : publicKeyPem;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const payloadPart = token.slice(0, dot);
    const sigPart = token.slice(dot + 1);
    if (!edVerify(null, Buffer.from(payloadPart, "utf8"), key, fromB64url(sigPart))) return null;
    const claims = JSON.parse(fromB64url(payloadPart).toString("utf8")) as OpenChatClaims;
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    if (typeof claims.exp !== "number" || now >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
