import { describe, it, expect } from "vitest";
import { IDL } from "@dfinity/candid";
import { buildIdl, buildManifestWire } from "./registerAiApp";
import { iouActionManifest } from "./actionManifest";

const FAKE_PEM = "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n";

describe("buildManifestWire", () => {
  it("accepts an EMPTY app-level key for the per-user-keys manifest (zero-input registration)", () => {
    // Precondition of the whole zero-input flow: IOU's manifest uses per-user delivery keys.
    expect(iouActionManifest.perUserKeys).toBe(true);

    const manifest = buildManifestWire("", undefined, () => {});
    expect(manifest.consumer_public_key).toBe("");
    expect(manifest.per_user_keys).toBe(true);
  });

  it("still carries an explicit app-level key when one is supplied (legacy path)", () => {
    const manifest = buildManifestWire(FAKE_PEM, undefined, () => {});
    expect(manifest.consumer_public_key).toBe(FAKE_PEM);
    expect(manifest.per_user_keys).toBe(true);
  });

  it("sends app_canister_id as an opt principal when a valid one is supplied, [] otherwise", () => {
    const withId = buildManifestWire("", "aaaaa-aa", () => {});
    expect(withId.app_canister_id).toHaveLength(1);
    const withoutId = buildManifestWire("", undefined, () => {});
    expect(withoutId.app_canister_id).toEqual([]);
    // A non-principal (e.g. the local dfx alias) is tolerated and omitted, not thrown.
    const aliasId = buildManifestWire("", "iou_backend", () => {});
    expect(aliasId.app_canister_id).toEqual([]);
  });

  it("sends inbox_canister_id as an opt principal when supplied, [] otherwise", () => {
    // Regression guard: register_ai_app is an UPSERT, so every (re)registration must carry the per-app
    // inbox override. Dropping it (the browser registerAiApp once hard-coded `undefined`) makes OpenChat
    // route confirmed-action deposits nowhere — confirms then fail deposit with `NotConfigured` and the
    // action never reaches IOU's inbox. The 4th positional arg is the inbox canister id.
    const withInbox = buildManifestWire("", undefined, () => {}, "aaaaa-aa");
    expect(withInbox.inbox_canister_id).toHaveLength(1);
    const withoutInbox = buildManifestWire("", undefined, () => {});
    expect(withoutInbox.inbox_canister_id).toEqual([]);
    // A non-principal (e.g. the local dfx alias) is tolerated and omitted, not thrown.
    const aliasInbox = buildManifestWire("", undefined, () => {}, "iou_backend");
    expect(aliasInbox.inbox_canister_id).toEqual([]);
  });

  it("candid-encodes the empty-key manifest against the register_ai_app IDL", () => {
    const manifest = buildManifestWire("", undefined, () => {});
    const { RegisterAiAppArgs } = buildIdl();
    const encoded = IDL.encode([RegisterAiAppArgs], [{ manifest }]);
    expect(encoded.byteLength).toBeGreaterThan(0);
  });

  it("carries the chat_link + connect + home surfaces with snake-label display variants", () => {
    const manifest = buildManifestWire("", undefined, () => {});
    const surfaces = manifest.surfaces as { kind: string; url: string; display: Record<string, null> }[];
    expect(surfaces).toHaveLength(3);
    const chatLink = surfaces.find((s) => s.kind === "chat_link")!;
    expect(chatLink.url).toContain("/openchat/link-chat?chat={chatKey}");
    const connect = surfaces.find((s) => s.kind === "connect")!;
    expect(connect.url).toContain("/settings#openchat-connect");
    const home = surfaces.find((s) => s.kind === "home")!;
    // Per-variant #[serde(rename)] labels: the candid wire variant is a single lowercase key
    // ("sheet"/"external"), never the PascalCase Rust ident.
    expect(chatLink.display).toEqual({ external: null });
    expect(connect.display).toEqual({ external: null });
    expect(home.display).toEqual({ sheet: null });
  });
});
