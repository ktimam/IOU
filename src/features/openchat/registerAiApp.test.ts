import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { buildIdl, buildManifestWire } from "./registerAiApp";
import {
  iouActionManifest,
  IOU_IMAGE_EXTRACTION_PROMPT,
} from "./actionManifest";
import {
  encodeManifestCommitmentV2,
  MANIFEST_COMMITMENT_DOMAIN_V2,
} from "./manifestCommitmentV2";

const FAKE_PEM = "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n";

describe("buildManifestWire", () => {
  it("accepts an EMPTY app-level key for the per-user-keys manifest (zero-input registration)", () => {
    // Precondition of the whole zero-input flow: IOU's manifest uses per-user delivery keys.
    expect(iouActionManifest.perUserKeys).toBe(true);

    const manifest = buildManifestWire("", undefined, () => {});
    expect(manifest.consumer_public_key).toBe("");
    expect(manifest.per_user_keys).toBe(true);
  });

  it("opts the IOU action into app-authorized account-scoped recipients", () => {
    expect(iouActionManifest.recipientScope).toBe("app_authorized");

    const manifest = buildManifestWire("", undefined, () => {}) as {
      actions: { recipient_scope: { app_authorized: null }[] }[];
    };
    expect(manifest.actions[0]?.recipient_scope).toEqual([{ app_authorized: null }]);
  });

  it("still carries an explicit app-level key when one is supplied (legacy path)", () => {
    const manifest = buildManifestWire(FAKE_PEM, undefined, () => {});
    expect(manifest.consumer_public_key).toBe(FAKE_PEM);
    expect(manifest.per_user_keys).toBe(true);
  });

  it("uses the public app origin for the registry icon instead of a disallowed data URL", () => {
    const manifest = buildManifestWire("", undefined, () => {}) as { icon_url: string[] };
    expect(manifest.icon_url).toEqual(["http://127.0.0.1:3000/favicon.svg"]);
    expect(manifest.icon_url[0]?.startsWith("data:")).toBe(false);
  });

  it("does not add a redundant disclosure acknowledgement to the explicit Add to IOU action", () => {
    const manifest = buildManifestWire("", undefined, () => {}) as {
      actions: { card: { disclosure: string[] } }[];
    };
    expect(manifest.actions[0]?.card.disclosure).toEqual([]);
  });

  it("carries the exact image-only prompt contract through the unchanged response-schema wire", () => {
    const manifest = buildManifestWire("", undefined, () => {}) as {
      actions: { response_schema: string }[];
    };
    const schema = JSON.parse(manifest.actions[0].response_schema);

    expect(schema["x-openchat-image-prompt-template"]).toEqual({
      version: 1,
      template: IOU_IMAGE_EXTRACTION_PROMPT,
      includeRuleGuidance: false,
    });
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

  it("does not leak supplied account templates into the public wire manifest", () => {
    // The fifth argument exists only as a regression seam: production callers
    // cannot pass templates, and the wire builder must ignore them if supplied.
    const templates = [
      { id: "z1", name: "Reservation", keywords: ["private-reservation-trigger"] },
      { id: "z2", name: "Rent", keywords: ["rent"] },
    ];
    const manifest = buildManifestWire("", undefined, () => {}, undefined, templates) as {
      actions: {
        rules: { keyword_map?: { field: string; map: { value: string; keywords: string[] }[] } }[];
        response_schema: string;
        card: { rows: { field: string; label: string }[] };
      }[];
    };
    const action = manifest.actions[0];
    const tmplRule = action.rules.find((r) => r.keyword_map?.field === "template");
    expect(tmplRule).toBeUndefined();
    expect(JSON.parse(action.response_schema).properties.template).toBeUndefined();
    expect(action.card.rows.find((row) => row.field === "template")).toBeUndefined();
    expect(JSON.stringify(action)).not.toContain("Reservation");
    expect(JSON.stringify(action)).not.toContain("private-reservation-trigger");
  });

  it("omits template metadata when the regression seam receives an empty list", () => {
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

  it("matches OpenChat's verifier-v2 canonical manifest commitment golden", () => {
    const principal = (byte: number) => Principal.fromUint8Array(Uint8Array.of(byte));
    const manifest = {
      name: "Sample App",
      description: "A generic app",
      icon_url: ["https://app.example/icon.png"],
      app_canister_id: [principal(3)],
      inbox_canister_id: [principal(4)],
      consumer_public_key: "canonical-app-key",
      per_user_keys: false,
      actions: [{
        name: "sample.confirm",
        description: "Confirm",
        prompt_template: "Return JSON",
        response_schema: '{"type":"object"}',
        card: {
          title: "Review",
          confirm_label: "Confirm",
          cancel_label: "Cancel",
          rows: [{ field: "value", label: "Value" }],
          disclosure: [],
        },
        endpoint: "https://app.example/confirm",
        consumer_public_key: [],
        recipient_scope: [],
        rules: [],
        accepts_image: false,
      }],
      surfaces: [{
        kind: "card",
        url: "https://app.example/card/{appId}",
        display: { sheet: null },
      }],
    };
    const encoded = encodeManifestCommitmentV2({
      user_index_canister_id: principal(1),
      app_id: 7,
      app_revision: 99n,
      owner: principal(2),
      canonical_name: "sampleapp",
      manifest,
    });
    const encodedHex = Buffer.from(encoded).toString("hex");
    const digest = createHash("sha256")
      .update(Buffer.from(MANIFEST_COMMITMENT_DOMAIN_V2))
      .update(Buffer.from(encoded))
      .digest("hex");
    expect({ digest, encodedHex }).toEqual({
      digest: "93f82f31d31c7cea66bd8d6e434b77442c035d7386f52fad4019250625db71b9",
      encodedHex:
        "4f432d4d414e494645535402000000010100000007000000000000006300000001020000000973616d706c656170700000000a53616d706c65204170700000000d412067656e6572696320617070010000001c68747470733a2f2f6170702e6578616d706c652f69636f6e2e706e670100000001030100000001040000001163616e6f6e6963616c2d6170702d6b657900000000010000000e73616d706c652e636f6e6669726d00000007436f6e6669726d0000000b52657475726e204a534f4e000000117b2274797065223a226f626a656374227d0000000652657669657700000007436f6e6669726d0000000643616e63656c000000010000000576616c75650000000556616c7565000000001b68747470733a2f2f6170702e6578616d706c652f636f6e6669726d0000000000000000000100000004636172640000002068747470733a2f2f6170702e6578616d706c652f636172642f7b61707049647d00",
    });
  });

  it("carries only raw-free registered surfaces with snake-label display variants", () => {
    const manifest = buildManifestWire("", undefined, () => {});
    const surfaces = manifest.surfaces as { kind: string; url: string; display: Record<string, null> }[];
    expect(surfaces).toHaveLength(5);
    const routing = surfaces.find((s) => s.kind === "chat_link");
    expect(routing).toBeDefined();
    expect(routing!.url).toMatch(
      /\/settings#openchat-routing\/\{chatLinkToken\}$/,
    );
    expect(routing!.display).toEqual({ external: null });
    expect(surfaces.every((s) => !/[?&](?:chat|message|user)=/i.test(s.url))).toBe(true);
    const connect = surfaces.find((s) => s.kind === "connect")!;
    expect(connect.url).toContain("/settings#openchat-connect");
    const home = surfaces.find((s) => s.kind === "home")!;
    const card = surfaces.find((s) => s.kind === "card")!;
    const privateMatch = surfaces.find((s) => s.kind === "private_match")!;
    expect(card.url).toContain("/openchat/card");
    expect(privateMatch.url).toContain("/openchat/private-match");
    expect(privateMatch.url).not.toMatch(/[?#]/);
    // Per-variant #[serde(rename)] labels: the candid wire variant is a single lowercase key
    // ("sheet"/"external"), never the PascalCase Rust ident.
    expect(connect.display).toEqual({ external: null });
    expect(home.display).toEqual({ sheet: null });
    // The app-rendered card is embedded (storage-partitioned but session-less).
    expect(card.display).toEqual({ sheet: null });
    expect(privateMatch.display).toEqual({ sheet: null });
  });
});
