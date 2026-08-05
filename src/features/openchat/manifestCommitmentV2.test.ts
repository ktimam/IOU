import { createHash } from "node:crypto";
import { Principal } from "@dfinity/principal";
import { describe, expect, it } from "vitest";
import { buildManifestWire } from "./registerAiApp";
import {
  encodeManifestCommitmentV2,
  MANIFEST_COMMITMENT_DOMAIN_V2,
  type ManifestCommitmentV2,
} from "./manifestCommitmentV2";

const USER_INDEX = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
const OWNER = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
const APP = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
const INBOX = Principal.fromText("renrk-eyaaa-aaaaa-aaada-cai");

function commitment(): ManifestCommitmentV2 {
  return {
    user_index_canister_id: USER_INDEX,
    app_id: 7,
    app_revision: 99n,
    owner: OWNER,
    canonical_name: "iou",
    manifest: buildManifestWire("", APP.toText(), () => {}, INBOX.toText()),
  };
}

function digest(value: ManifestCommitmentV2): string {
  return createHash("sha256")
    .update(Buffer.from(MANIFEST_COMMITMENT_DOMAIN_V2))
    .update(Buffer.from(encodeManifestCommitmentV2(value)))
    .digest("hex");
}

describe("manifest verifier V2 language-neutral encoding", () => {
  it("is deterministic and binds every outer registry coordinate", () => {
    const base = commitment();
    const expected = digest(base);
    expect(digest(base)).toBe(expected);

    const changes: ManifestCommitmentV2[] = [
      { ...base, user_index_canister_id: OWNER },
      { ...base, app_id: 8 },
      { ...base, app_revision: 100n },
      { ...base, owner: USER_INDEX },
      { ...base, canonical_name: "anotherapp" },
    ];
    for (const changed of changes) expect(digest(changed)).not.toBe(expected);
  });

  it("binds manifest routing, action, card, schema, key policy and vector order", () => {
    const base = commitment();
    const expected = digest(base);
    const manifest = base.manifest as any;
    const action = manifest.actions[0];
    const changes = [
      { ...manifest, app_canister_id: [OWNER] },
      { ...manifest, inbox_canister_id: [OWNER] },
      { ...manifest, consumer_public_key: "substituted" },
      { ...manifest, per_user_keys: !manifest.per_user_keys },
      { ...manifest, surfaces: [...manifest.surfaces].reverse() },
      { ...manifest, actions: [{ ...action, endpoint: "https://evil.example/confirm" }] },
      { ...manifest, actions: [{ ...action, response_schema: '{"type":"string"}' }] },
      { ...manifest, actions: [{ ...action, card: { ...action.card, title: "Forged" } }] },
    ];
    for (const changed of changes) expect(digest({ ...base, manifest: changed })).not.toBe(expected);
  });

  it("encodes every rule and enum tag, including both option branches", () => {
    const base = commitment();
    const manifest = base.manifest as any;
    const action = manifest.actions[0];
    const rules = [
      { keyword_map: { field: "kind", mode: { hint: null }, map: [{ value: "x", keywords: ["a"] }] } },
      { keyword_map: { field: "kind", mode: { override: null }, map: [] } },
      { from_message: { field: "message", max_length: [] } },
      { from_message: { field: "message", max_length: [200] } },
      {
        normalize: {
          field: "amount",
          ops: [
            { k_m_suffix: null },
            { strip_symbols: null },
            { uppercase: null },
            { lowercase: null },
            { trim: null },
          ],
        },
      },
      { instruction: { text: "Do the safe thing" } },
      { context: { provide: [{ today: null }] } },
    ];
    const withRules = {
      ...base,
      manifest: { ...manifest, actions: [{ ...action, consumer_public_key: ["key"], rules }] },
    };
    expect(() => encodeManifestCommitmentV2(withRules)).not.toThrow();
    const reversed = {
      ...withRules,
      manifest: { ...withRules.manifest, actions: [{ ...action, consumer_public_key: ["key"], rules: [...rules].reverse() }] },
    };
    expect(digest(reversed)).not.toBe(digest(withRules));
  });

  it("rejects malformed options, unknown variants and unsafe integers", () => {
    const base = commitment();
    const manifest = base.manifest as any;
    const action = manifest.actions[0];
    expect(() => encodeManifestCommitmentV2({ ...base, app_revision: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      /u64 is out of range/,
    );
    expect(() =>
      encodeManifestCommitmentV2({ ...base, manifest: { ...manifest, icon_url: ["a", "b"] } }),
    ).toThrow(/option/);
    expect(() =>
      encodeManifestCommitmentV2({
        ...base,
        manifest: { ...manifest, actions: [{ ...action, rules: [{ forged: {} }] }] },
      }),
    ).toThrow(/unknown variant/);
    expect(() =>
      encodeManifestCommitmentV2({
        ...base,
        manifest: { ...manifest, surfaces: [{ ...manifest.surfaces[0], display: { popup: null } }] },
      }),
    ).toThrow(/unknown variant/);
  });

  it("uses UTF-8 byte lengths rather than JavaScript character counts", () => {
    const base = commitment();
    const ascii = digest({ ...base, canonical_name: "iou" });
    const unicode = digest({ ...base, canonical_name: "ioù" });
    expect(unicode).not.toBe(ascii);
    expect(() => encodeManifestCommitmentV2({ ...base, canonical_name: "ioù" })).not.toThrow();
  });
});
