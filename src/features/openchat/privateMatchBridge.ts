// Privacy-preserving Saved-type trigger bridge.
//
// OpenChat hosts /openchat/private-match as a credentialless, opaque-origin
// `sandbox="allow-scripts"` iframe. The host supplies the exact new message only
// after this fresh document has proved possession of its ephemeral public
// transport key. The iframe returns one boolean and no private roster metadata.

export const PRIVATE_MATCH_MSG = {
  bootstrap: "oc:private-match:bootstrap",
  ready: "oc:private-match:ready",
  request: "oc:private-match:request",
  result: "oc:private-match:result",
} as const;

export const PRIVATE_MATCH_VERSION = 1 as const;
export const PRIVATE_MATCH_FRAME_NONCE_BYTES = 32;
export const PRIVATE_MATCH_ATTEMPT_ID_BYTES = 16;
export const PRIVATE_MATCH_TRANSPORT_PUBLIC_KEY_BYTES = 48;
export const PRIVATE_MATCH_CAPABILITY_BYTES = 32;
export const PRIVATE_MATCH_MAX_TEXT_BYTES = 32 * 1024;
export const PRIVATE_MATCH_RECIPIENT_KEY_SCHEME = "iou.vetkd.bls12-381.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeCanonicalBase64Url(value: unknown, bytes: number): Uint8Array | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padding = "=".repeat((4 - (value.length % 4)) % 4);
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const decoded = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...decoded))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return decoded.length === bytes && canonical === value ? decoded : null;
  } catch {
    return null;
  }
}

export function isPrivateMatchFrameNonce(value: unknown): value is string {
  return decodeCanonicalBase64Url(value, PRIVATE_MATCH_FRAME_NONCE_BYTES) !== null;
}

export function isPrivateMatchAttemptId(value: unknown): value is string {
  return decodeCanonicalBase64Url(value, PRIVATE_MATCH_ATTEMPT_ID_BYTES) !== null;
}

export function isPrivateMatchCapability(value: unknown): value is string {
  return decodeCanonicalBase64Url(value, PRIVATE_MATCH_CAPABILITY_BYTES) !== null;
}

export function isPrivateMatchTransportPublicKey(value: unknown): value is string {
  return decodeCanonicalBase64Url(value, PRIVATE_MATCH_TRANSPORT_PUBLIC_KEY_BYTES) !== null;
}

export type PrivateMatchBinding = {
  frameNonce: string;
  attemptId: string;
};

export type PrivateMatchRequest = PrivateMatchBinding & {
  capability: string;
  messageText: string;
};

export function parsePrivateMatchBootstrap(value: unknown): PrivateMatchBinding | null {
  if (
    !isRecord(value) ||
    value.type !== PRIVATE_MATCH_MSG.bootstrap ||
    value.version !== PRIVATE_MATCH_VERSION ||
    !isPrivateMatchFrameNonce(value.frameNonce) ||
    !isPrivateMatchAttemptId(value.attemptId)
  ) {
    return null;
  }
  return { frameNonce: value.frameNonce, attemptId: value.attemptId };
}

export function parsePrivateMatchRequest(
  value: unknown,
  expected: PrivateMatchBinding,
): PrivateMatchRequest | null {
  if (
    !isRecord(value) ||
    value.type !== PRIVATE_MATCH_MSG.request ||
    value.version !== PRIVATE_MATCH_VERSION ||
    value.frameNonce !== expected.frameNonce ||
    value.attemptId !== expected.attemptId ||
    !isPrivateMatchCapability(value.capability) ||
    typeof value.messageText !== "string" ||
    new TextEncoder().encode(value.messageText).length > PRIVATE_MATCH_MAX_TEXT_BYTES
  ) {
    return null;
  }
  return {
    frameNonce: expected.frameNonce,
    attemptId: expected.attemptId,
    capability: value.capability,
    messageText: value.messageText,
  };
}

export function buildPrivateMatchReady(
  binding: PrivateMatchBinding,
  recipientPublicKey: string,
) {
  if (
    !isPrivateMatchFrameNonce(binding.frameNonce) ||
    !isPrivateMatchAttemptId(binding.attemptId) ||
    !isPrivateMatchTransportPublicKey(recipientPublicKey)
  ) {
    throw new Error("invalid private-match ready binding");
  }
  return {
    type: PRIVATE_MATCH_MSG.ready,
    version: PRIVATE_MATCH_VERSION,
    ...binding,
    recipientKeyScheme: PRIVATE_MATCH_RECIPIENT_KEY_SCHEME,
    recipientPublicKey,
  } as const;
}

export function buildPrivateMatchResult(binding: PrivateMatchBinding, matched: boolean) {
  if (
    !isPrivateMatchFrameNonce(binding.frameNonce) ||
    !isPrivateMatchAttemptId(binding.attemptId)
  ) {
    throw new Error("invalid private-match result binding");
  }
  return {
    type: PRIVATE_MATCH_MSG.result,
    version: PRIVATE_MATCH_VERSION,
    ...binding,
    matched: matched === true,
  } as const;
}

/** The parent is a normal OpenChat document; bind to its exact origin after bootstrap. */
export function privateMatchParentTargetOrigin(eventOrigin: string): string | null {
  return eventOrigin.length > 0 && eventOrigin !== "null" ? eventOrigin : null;
}
