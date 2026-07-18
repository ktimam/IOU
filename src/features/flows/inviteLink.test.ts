// Unit tests for invite-link build/parse + the dev accept-flow crypto.
// No canister/replica needed — pure functions + real WebCrypto.

import { describe, it, expect } from "vitest";
import { webcrypto } from "node:crypto";

if (!(globalThis as any).crypto) {
  (globalThis as any).crypto = webcrypto;
}
const _ls = new Map<string, string>();
(globalThis as any).localStorage ??= {
  getItem: (k: string) => (_ls.has(k) ? _ls.get(k)! : null),
  setItem: (k: string, v: string) => { _ls.set(k, v); },
  removeItem: (k: string) => { _ls.delete(k); },
};

import {
  buildInviteLink,
  parseInviteFragment,
  b64uEncode,
  b64uDecode,
} from "./inviteLink";
import {
  newSheetKey,
  deriveUserKeypair,
  wrapSheetKey,
  wrapSheetKeyTagged,
  unwrapSheetKey,
  unwrapTaggedSheetKey,
} from "../crypto/devVetkd";

describe("inviteLink build/parse", () => {
  it("round-trips code + sheetId + key through the URL fragment", () => {
    const k = newSheetKey();
    const link = buildInviteLink("http://127.0.0.1:3000", {
      code: "AB12-CD34",
      sheetId: "0eb3f4936d8c45d4",
      kSheet: k,
    });
    expect(link).toMatch(/^http:\/\/127\.0\.0\.1:3000\/pair\/accept#/);
    const p = parseInviteFragment(link.slice(link.indexOf("#")));
    expect(p).not.toBeNull();
    expect(p!.code).toBe("AB12-CD34");
    expect(p!.sheetId).toBe("0eb3f4936d8c45d4");
    // the sheet key survives the link byte-for-byte
    expect(Array.from(b64uDecode(p!.keyB64u!))).toEqual(Array.from(k));
  });

  it("omits the key for prod-style links; parse tolerates its absence", () => {
    const link = buildInviteLink("http://x", { code: "C", sheetId: "S" });
    expect(link).not.toContain("k=");
    expect(parseInviteFragment(link.slice(link.indexOf("#")))).toEqual({
      code: "C",
      sheetId: "S",
      keyB64u: undefined,
    });
  });

  it("rejects a fragment missing the code or the sheet id", () => {
    expect(parseInviteFragment("")).toBeNull();
    expect(parseInviteFragment("#c=only")).toBeNull(); // no s
    expect(parseInviteFragment("#s=only")).toBeNull(); // no c
    expect(parseInviteFragment("#x=y")).toBeNull();
  });

  it("strips a trailing slash on origin (no double slash)", () => {
    expect(buildInviteLink("http://x/", { code: "c", sheetId: "s" })).toBe(
      "http://x/pair/accept#c=c&s=s",
    );
  });

  it("b64u is url-safe (no + / = chars) and reversible", () => {
    const bytes = new Uint8Array([251, 255, 191, 0, 1, 2]); // forces +,/ in std base64
    const e = b64uEncode(bytes);
    expect(e).not.toMatch(/[+/=]/);
    expect(Array.from(b64uDecode(e))).toEqual(Array.from(bytes));
  });
});

describe("inviteLink dev accept-flow crypto (self-wrap → member_b read)", () => {
  it("accept_invite: the joiner SELF-wraps K from the link, and reads it back via self-unwrap", async () => {
    // Dev/P-256: the joiner has K_sheet from the link. AcceptInvitePage self-wraps
    // it under the joiner's OWN key (ECDH(joinerPriv, joinerPub)); the read path
    // (SheetKeyContext) self-unwraps the same way — no creator pubkey needed.
    const K = newSheetKey();
    const joiner = await deriveUserKeypair("joiner-principal-xyz");

    // K travels through the link and comes out intact:
    const link = buildInviteLink("http://x", { code: "c", sheetId: "s", kSheet: K });
    const Klink = b64uDecode(parseInviteFragment(link.slice(link.indexOf("#")))!.keyB64u!);
    expect(Array.from(Klink)).toEqual(Array.from(K));

    // What AcceptInvitePage actually stores: SELF-wrap under the joiner's own key.
    const wrappedForB = await wrapSheetKey(Klink, joiner.publicKey, joiner.privateKey);
    // What SheetKeyContext.unwrapFor actually does first: SELF-unwrap.
    const back = await unwrapSheetKey(wrappedForB, joiner.privateKey, joiner.publicKey);
    expect(Array.from(back)).toEqual(Array.from(K));

    // and a stranger's keypair does NOT unwrap it
    const stranger = await deriveUserKeypair("stranger");
    await expect(
      unwrapSheetKey(wrappedForB, stranger.privateKey, stranger.publicKey),
    ).rejects.toBeTruthy();
  });

  it("new sheet on a shared pair: creator TAGGED-cross-wraps for the partner, who reads with only their own key", async () => {
    // createSheetForPair (post-join) can't self-wrap for the partner — it doesn't hold
    // their private key — so it TAGGED-cross-wraps under the partner's pubkey, embedding
    // the creator's pubkey. The partner's read path tries self-unwrap (fails) then the
    // tagged unwrap, which needs NO external lookup (so it survives the creator leaving).
    const K = newSheetKey();
    const creator = await deriveUserKeypair("creator-A");
    const partner = await deriveUserKeypair("partner-B");

    const wrappedForB = await wrapSheetKeyTagged(
      K,
      partner.publicKey,
      creator.privateKey,
      creator.publicKeyB64,
    );
    // plain self-unwrap FAILS on a cross-wrapped blob …
    await expect(
      unwrapSheetKey(wrappedForB, partner.privateKey, partner.publicKey),
    ).rejects.toBeTruthy();
    // … tagged unwrap SUCCEEDS with only the partner's private key (sealer pubkey is
    // embedded — no knowledge of the creator's identity or current membership needed).
    const back = await unwrapTaggedSheetKey(wrappedForB, partner.privateKey);
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(K));

    // a plain (untagged) self-wrap is NOT mistaken for a tagged blob
    const selfWrap = await wrapSheetKey(K, partner.publicKey, partner.privateKey);
    expect(await unwrapTaggedSheetKey(selfWrap, partner.privateKey)).toBeNull();
  });
});
