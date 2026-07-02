import { describe, it, expect } from "vitest";
import { IDL } from "@dfinity/candid";
import { buildIdl, buildManifestWire } from "./registerAiApp";
import { iouActionManifest } from "./actionManifest";

const FAKE_PEM = "-----BEGIN PUBLIC KEY-----\nMFkw...\n-----END PUBLIC KEY-----\n";

describe("buildManifestWire", () => {
  it("accepts an EMPTY app-level key for the per-user-keys manifest (zero-input registration)", () => {
    // Precondition of the whole zero-input flow: IOU's manifest uses per-user delivery keys.
    expect(iouActionManifest.perUserKeys).toBe(true);

    const manifest = buildManifestWire("", () => {});
    expect(manifest.consumer_public_key).toBe("");
    expect(manifest.per_user_keys).toBe(true);
  });

  it("still carries an explicit app-level key when one is supplied (legacy path)", () => {
    const manifest = buildManifestWire(FAKE_PEM, () => {});
    expect(manifest.consumer_public_key).toBe(FAKE_PEM);
    expect(manifest.per_user_keys).toBe(true);
  });

  it("candid-encodes the empty-key manifest against the register_ai_app IDL", () => {
    const manifest = buildManifestWire("", () => {});
    const { RegisterAiAppArgs } = buildIdl();
    const encoded = IDL.encode([RegisterAiAppArgs], [{ manifest }]);
    expect(encoded.byteLength).toBeGreaterThan(0);
  });

  it("carries the chat_link + connect surfaces with snake-label display variants", () => {
    const manifest = buildManifestWire("", () => {});
    const surfaces = manifest.surfaces as { kind: string; url: string; display: Record<string, null> }[];
    expect(surfaces).toHaveLength(2);
    const chatLink = surfaces.find((s) => s.kind === "chat_link")!;
    expect(chatLink.url).toContain("/openchat/link-chat?chat={chatKey}");
    const connect = surfaces.find((s) => s.kind === "connect")!;
    expect(connect.url).toContain("/settings#openchat-connect");
    // Per-variant #[serde(rename)] labels: the candid wire variant is a single lowercase key
    // ("sheet"/"external"), never the PascalCase Rust ident.
    expect(chatLink.display).toEqual({ external: null });
    expect(connect.display).toEqual({ external: null });
  });
});
