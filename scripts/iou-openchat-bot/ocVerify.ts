// Verify OpenChat provenance — the trust anchor for the IOU↔OpenChat connector.
//
// Matched EXACTLY to the OpenChat fork (branch feat/interactive-action-card):
//  - backend/libraries/jwt/src/lib.rs        → ES256 (P-256 ECDSA), token =
//    b64url(headerJson).b64url(claimsJson).b64url(sig); header {"alg":"ES256"};
//    claims { exp (SECONDS), claim_type, ...custom }; sig is raw IEEE-P1363
//    (r||s) over the ASCII "header.claims"; verified with a P-256 SPKI PEM.
//  - backend/notification_pusher/core/src/bot_notifications/pusher.rs → the
//    Confirm forward POSTs to {endpoint}/notify with header `x-oc-signature` =
//    base64url ES256 signature over the raw request BODY bytes.
//
// The connector only ever holds OpenChat's PUBLIC key (env IOU_OPENCHAT_PUBKEY),
// so it verifies provenance but can never forge it.

import { verify as cryptoVerify, createPublicKey } from "node:crypto";

const b64urlToBuf = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/**
 * Verify the `x-oc-signature` header on a /notify POST (ES256 over the raw body).
 * This is how the connector authenticates an ActionCard-confirm forward.
 */
export function verifyOcSignature(body: Buffer, xOcSignature: string, publicKeyPem: string): boolean {
  try {
    return cryptoVerify(
      "sha256",
      body,
      { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" },
      b64urlToBuf(xOcSignature),
    );
  } catch {
    return false;
  }
}

/**
 * Verify an OpenChat ES256 JWT (the `Claims<T>` format from libraries/jwt).
 * Returns the decoded claims, or null on malformed / bad-signature / expired.
 * Used for access-token / future AiActionClaims-style provenance.
 */
export function verifyOcJwt(
  jwt: string,
  publicKeyPem: string,
  nowMs: number,
): Record<string, unknown> | null {
  try {
    const dot1 = jwt.indexOf(".");
    const dot2 = jwt.indexOf(".", dot1 + 1);
    if (dot1 <= 0 || dot2 <= dot1) return null;
    const header = jwt.slice(0, dot1);
    const claimsPart = jwt.slice(dot1 + 1, dot2);
    const sig = jwt.slice(dot2 + 1);
    const ok = cryptoVerify(
      "sha256",
      Buffer.from(`${header}.${claimsPart}`, "utf8"),
      { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" },
      b64urlToBuf(sig),
    );
    if (!ok) return null;
    const claims = JSON.parse(b64urlToBuf(claimsPart).toString("utf8")) as Record<string, unknown>;
    if (typeof claims.exp === "number" && nowMs / 1000 >= claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
