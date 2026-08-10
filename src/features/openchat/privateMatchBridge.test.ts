import { describe, expect, it } from "vitest";
import {
  buildPrivateMatchReady,
  buildPrivateMatchResult,
  buildPrivateMatchSourceReady,
  parsePrivateMatchAuthorize,
  parsePrivateMatchBootstrap,
  parsePrivateMatchSource,
  privateMatchParentTargetOrigin,
  PRIVATE_MATCH_MSG,
  PRIVATE_MATCH_VERSION,
} from "./privateMatchBridge";

function b64url(bytes: number, fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes).fill(fill)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const binding = { frameNonce: b64url(32, 1), attemptId: b64url(16, 2) };

describe("private-match iframe protocol", () => {
  it("binds bootstrap, ready and boolean-only result to one document attempt", () => {
    expect(
      parsePrivateMatchBootstrap({
        type: PRIVATE_MATCH_MSG.bootstrap,
        version: PRIVATE_MATCH_VERSION,
        ...binding,
      }),
    ).toEqual(binding);
    expect(buildPrivateMatchReady(binding, b64url(48, 3))).toMatchObject({
      ...binding,
      recipientPublicKey: b64url(48, 3),
    });
    expect(buildPrivateMatchResult(binding, true)).toEqual({
      type: PRIVATE_MATCH_MSG.result,
      version: PRIVATE_MATCH_VERSION,
      ...binding,
      matched: true,
    });
    expect(Object.keys(buildPrivateMatchResult(binding, false)).sort()).toEqual(
      ["attemptId", "frameNonce", "matched", "type", "version"].sort(),
    );
  });

  it("authorizes before accepting any exact source text", () => {
    const authorize = {
      type: PRIVATE_MATCH_MSG.authorize,
      version: PRIVATE_MATCH_VERSION,
      ...binding,
      capability: b64url(32, 4),
    };
    expect(parsePrivateMatchAuthorize(authorize, binding)?.capability).toBe(b64url(32, 4));
    expect(
      parsePrivateMatchAuthorize({ ...authorize, messageText: "must not cross yet" }, binding),
    ).toBeNull();
    expect(buildPrivateMatchSourceReady(binding)).toEqual({
      type: PRIVATE_MATCH_MSG.sourceReady,
      version: PRIVATE_MATCH_VERSION,
      ...binding,
    });

    const source = {
      type: PRIVATE_MATCH_MSG.source,
      version: PRIVATE_MATCH_VERSION,
      ...binding,
      messageText: "School expense 350 EGP ",
    };
    expect(parsePrivateMatchSource(source, binding)?.messageText).toBe(
      "School expense 350 EGP ",
    );
    expect(
      parsePrivateMatchSource({ ...source, attemptId: b64url(16, 9) }, binding),
    ).toBeNull();
    expect(parsePrivateMatchAuthorize({ ...authorize, capability: "not-a-token" }, binding)).toBeNull();
    expect(parsePrivateMatchSource({ ...source, messageText: "x".repeat(32 * 1024 + 1) }, binding)).toBeNull();
  });

  it("never falls back to wildcard for an opaque or missing parent origin", () => {
    expect(privateMatchParentTargetOrigin("https://oc.example")).toBe("https://oc.example");
    expect(privateMatchParentTargetOrigin("null")).toBeNull();
    expect(privateMatchParentTargetOrigin("")).toBeNull();
  });
});
