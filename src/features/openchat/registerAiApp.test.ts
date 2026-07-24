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

  it("folds a user's saved TYPES into the wire manifest as a `template` keyword_map + schema (P0-9)", () => {
    // The 5th positional arg is the user's templates. This is the WIRE end of the type-routing
    // path: each type's trigger words must become a keyword_map on a `template` field so a chat
    // message routes to that type. (buildIouRules is unit-tested in isolation elsewhere; this pins
    // that buildManifestWire actually carries it into the registered manifest.)
    const templates = [
      { id: "z1", name: "Reservation", keywords: ["reservation", "booking"] },
      { id: "z2", name: "Rent", keywords: ["rent"] },
    ];
    const manifest = buildManifestWire("", undefined, () => {}, undefined, templates) as {
      actions: { rules: { keyword_map?: { field: string; map: { value: string; keywords: string[] }[] } }[]; response_schema: string }[];
    };
    const action = manifest.actions[0];
    const tmplRule = action.rules.find((r) => r.keyword_map?.field === "template");
    expect(tmplRule).toBeDefined();
    const entries = tmplRule!.keyword_map!.map;
    expect(entries.map((e) => e.value).sort()).toEqual(["Rent", "Reservation"]);
    expect(entries.find((e) => e.value === "Reservation")!.keywords).toEqual(
      expect.arrayContaining(["reservation", "booking"]),
    );
    // The response schema advertises the optional `template` field so the model may emit it.
    expect(JSON.parse(action.response_schema).properties.template).toBeDefined();
  });

  it("omits the template keyword_map + schema field when the user has NO routable types", () => {
    const manifest = buildManifestWire("", undefined, () => {}, undefined, []) as {
      actions: { rules: { keyword_map?: { field: string } }[]; response_schema: string }[];
    };
    const action = manifest.actions[0];
    expect(action.rules.find((r) => r.keyword_map?.field === "template")).toBeUndefined();
    expect(JSON.parse(action.response_schema).properties.template).toBeUndefined();
  });

  it("candid-encodes the empty-key manifest against the register_ai_app IDL", () => {
    const manifest = buildManifestWire("", undefined, () => {});
    const { RegisterAiAppArgs } = buildIdl();
    const encoded = IDL.encode([RegisterAiAppArgs], [{ manifest }]);
    expect(encoded.byteLength).toBeGreaterThan(0);
  });

  it("carries the chat_link + connect + home + card surfaces with snake-label display variants", () => {
    const manifest = buildManifestWire("", undefined, () => {});
    const surfaces = manifest.surfaces as { kind: string; url: string; display: Record<string, null> }[];
    expect(surfaces).toHaveLength(4);
    const chatLink = surfaces.find((s) => s.kind === "chat_link")!;
    expect(chatLink.url).toContain("/openchat/link-chat?chat={chatKey}");
    const connect = surfaces.find((s) => s.kind === "connect")!;
    expect(connect.url).toContain("/settings#openchat-connect");
    const home = surfaces.find((s) => s.kind === "home")!;
    const card = surfaces.find((s) => s.kind === "card")!;
    expect(card.url).toContain("/openchat/card");
    // Per-variant #[serde(rename)] labels: the candid wire variant is a single lowercase key
    // ("sheet"/"external"), never the PascalCase Rust ident.
    expect(chatLink.display).toEqual({ external: null });
    expect(connect.display).toEqual({ external: null });
    expect(home.display).toEqual({ sheet: null });
    // The app-rendered card is embedded (storage-partitioned but session-less).
    expect(card.display).toEqual({ sheet: null });
  });
});
