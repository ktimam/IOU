import type { Principal } from "@dfinity/principal";

/** Must remain byte-for-byte aligned with OpenChat ai_app_verifier V2. */
export const MANIFEST_COMMITMENT_ENCODING_V2 = new TextEncoder().encode("OC-MANIFEST\u0002");
export const MANIFEST_COMMITMENT_DOMAIN_V2 = new TextEncoder().encode(
  "openchat.ai-app-manifest.v2\u0000",
);

const MAX_U32 = 0xffff_ffffn;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const MAX_COMMITMENT_BYTES = 4 * 1024 * 1024;
const utf8 = new TextEncoder();

export type ManifestCommitmentV2 = {
  user_index_canister_id: Principal;
  app_id: number | bigint;
  app_revision: number | bigint;
  owner: Principal;
  canonical_name: string;
  manifest: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(record: Record<string, unknown>, name: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, name)) {
    throw new Error(`manifest commitment is missing ${name}`);
  }
  return record[name];
}

function recordField(record: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = field(record, name);
  if (!isRecord(value)) throw new Error(`manifest commitment ${name} must be a record`);
  return value;
}

function stringField(record: Record<string, unknown>, name: string): string {
  const value = field(record, name);
  if (typeof value !== "string") throw new Error(`manifest commitment ${name} must be text`);
  return value;
}

function boolField(record: Record<string, unknown>, name: string): boolean {
  const value = field(record, name);
  if (typeof value !== "boolean") throw new Error(`manifest commitment ${name} must be bool`);
  return value;
}

function arrayField(record: Record<string, unknown>, name: string): unknown[] {
  const value = field(record, name);
  if (!Array.isArray(value)) throw new Error(`manifest commitment ${name} must be a vector`);
  return value;
}

function principalBytes(value: unknown): Uint8Array {
  if (!isRecord(value) && (typeof value !== "object" || value === null)) {
    throw new Error("manifest commitment principal is invalid");
  }
  const principal = value as { toUint8Array?: () => Uint8Array };
  if (typeof principal.toUint8Array !== "function") {
    throw new Error("manifest commitment principal is invalid");
  }
  return principal.toUint8Array();
}

function variant(value: unknown, allowed: readonly string[], description: string): string {
  if (!isRecord(value)) throw new Error(`manifest commitment ${description} must be a variant`);
  const keys = Object.keys(value).filter((key) => Object.prototype.hasOwnProperty.call(value, key));
  if (keys.length !== 1 || !allowed.includes(keys[0])) {
    throw new Error(`manifest commitment ${description} has an unknown variant`);
  }
  return keys[0];
}

class CommitmentEncoder {
  readonly #bytes: number[] = [];

  finish(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }

  raw(value: Uint8Array): void {
    if (this.#bytes.length + value.length > MAX_COMMITMENT_BYTES) {
      throw new Error("manifest commitment is too large");
    }
    this.#bytes.push(...value);
  }

  u8(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new Error("manifest commitment u8 is out of range");
    }
    this.#bytes.push(value);
  }

  bool(value: boolean): void {
    this.u8(value ? 1 : 0);
  }

  u32(value: number | bigint): void {
    const n = this.uint(value, MAX_U32, "u32");
    for (const shift of [24n, 16n, 8n, 0n]) this.u8(Number((n >> shift) & 0xffn));
  }

  u64(value: number | bigint): void {
    const n = this.uint(value, MAX_U64, "u64");
    for (const shift of [56n, 48n, 40n, 32n, 24n, 16n, 8n, 0n]) {
      this.u8(Number((n >> shift) & 0xffn));
    }
  }

  private uint(value: number | bigint, max: bigint, name: string): bigint {
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error(`manifest commitment ${name} is out of range`);
    }
    if (typeof value !== "number" && typeof value !== "bigint") {
      throw new Error(`manifest commitment ${name} is invalid`);
    }
    const n = BigInt(value);
    if (n < 0n || n > max) throw new Error(`manifest commitment ${name} is out of range`);
    return n;
  }

  length(value: number): void {
    this.u32(value);
  }

  byteString(value: Uint8Array): void {
    this.length(value.length);
    this.raw(value);
  }

  string(value: string): void {
    this.byteString(utf8.encode(value));
  }

  principal(value: unknown): void {
    this.byteString(principalBytes(value));
  }

  option(value: unknown, encode: (encoder: CommitmentEncoder, item: unknown) => void): void {
    if (!Array.isArray(value) || value.length > 1) {
      throw new Error("manifest commitment option must contain zero or one value");
    }
    if (value.length === 0) {
      this.u8(0);
    } else {
      this.u8(1);
      encode(this, value[0]);
    }
  }
}

function encodeCard(out: CommitmentEncoder, card: Record<string, unknown>): void {
  out.string(stringField(card, "title"));
  out.string(stringField(card, "confirm_label"));
  out.string(stringField(card, "cancel_label"));
  const rows = arrayField(card, "rows");
  out.length(rows.length);
  for (const rowValue of rows) {
    if (!isRecord(rowValue)) throw new Error("manifest commitment card row must be a record");
    out.string(stringField(rowValue, "field"));
    out.string(stringField(rowValue, "label"));
  }
  out.option(field(card, "disclosure"), (encoder, value) => {
    if (typeof value !== "string") throw new Error("manifest commitment disclosure must be text");
    encoder.string(value);
  });
}

function encodeRule(out: CommitmentEncoder, ruleValue: unknown): void {
  const tag = variant(
    ruleValue,
    ["keyword_map", "from_message", "normalize", "instruction", "context"],
    "rule",
  );
  const rule = recordField(ruleValue as Record<string, unknown>, tag);
  if (tag === "keyword_map") {
    out.u8(0);
    out.string(stringField(rule, "field"));
    const mode = variant(field(rule, "mode"), ["hint", "override"], "rule mode");
    out.u8(mode === "hint" ? 0 : 1);
    const mappings = arrayField(rule, "map");
    out.length(mappings.length);
    for (const mappingValue of mappings) {
      if (!isRecord(mappingValue)) throw new Error("manifest commitment keyword mapping must be a record");
      out.string(stringField(mappingValue, "value"));
      const keywords = arrayField(mappingValue, "keywords");
      out.length(keywords.length);
      for (const keyword of keywords) {
        if (typeof keyword !== "string") throw new Error("manifest commitment keyword must be text");
        out.string(keyword);
      }
    }
    return;
  }
  if (tag === "from_message") {
    out.u8(1);
    out.string(stringField(rule, "field"));
    out.option(field(rule, "max_length"), (encoder, value) => {
      if (typeof value !== "number" && typeof value !== "bigint") {
        throw new Error("manifest commitment max_length must be nat32");
      }
      encoder.u32(value);
    });
    return;
  }
  if (tag === "normalize") {
    out.u8(2);
    out.string(stringField(rule, "field"));
    const ops = arrayField(rule, "ops");
    out.length(ops.length);
    const labels = ["k_m_suffix", "strip_symbols", "uppercase", "lowercase", "trim"] as const;
    for (const op of ops) out.u8(labels.indexOf(variant(op, labels, "normalize operation") as typeof labels[number]));
    return;
  }
  if (tag === "instruction") {
    out.u8(3);
    out.string(stringField(rule, "text"));
    return;
  }
  out.u8(4);
  const provided = arrayField(rule, "provide");
  out.length(provided.length);
  for (const item of provided) {
    variant(item, ["today"], "context item");
    out.u8(0);
  }
}

function encodeManifest(out: CommitmentEncoder, manifest: Record<string, unknown>): void {
  out.string(stringField(manifest, "name"));
  out.string(stringField(manifest, "description"));
  out.option(field(manifest, "icon_url"), (encoder, value) => {
    if (typeof value !== "string") throw new Error("manifest commitment icon_url must be text");
    encoder.string(value);
  });
  out.option(field(manifest, "app_canister_id"), (encoder, value) => encoder.principal(value));
  out.option(field(manifest, "inbox_canister_id"), (encoder, value) => encoder.principal(value));
  out.string(stringField(manifest, "consumer_public_key"));
  out.bool(boolField(manifest, "per_user_keys"));

  const actions = arrayField(manifest, "actions");
  out.length(actions.length);
  for (const actionValue of actions) {
    if (!isRecord(actionValue)) throw new Error("manifest commitment action must be a record");
    out.string(stringField(actionValue, "name"));
    out.string(stringField(actionValue, "description"));
    out.string(stringField(actionValue, "prompt_template"));
    out.string(stringField(actionValue, "response_schema"));
    encodeCard(out, recordField(actionValue, "card"));
    out.string(stringField(actionValue, "endpoint"));
    out.option(field(actionValue, "consumer_public_key"), (encoder, value) => {
      if (typeof value !== "string") throw new Error("manifest commitment action key must be text");
      encoder.string(value);
    });
    const rules = arrayField(actionValue, "rules");
    out.length(rules.length);
    for (const rule of rules) encodeRule(out, rule);
    out.bool(boolField(actionValue, "accepts_image"));
  }

  const surfaces = arrayField(manifest, "surfaces");
  out.length(surfaces.length);
  for (const surfaceValue of surfaces) {
    if (!isRecord(surfaceValue)) throw new Error("manifest commitment surface must be a record");
    out.string(stringField(surfaceValue, "kind"));
    out.string(stringField(surfaceValue, "url"));
    const display = variant(field(surfaceValue, "display"), ["sheet", "external"], "surface display");
    out.u8(display === "sheet" ? 0 : 1);
  }
}

function appendRecipientScopeExtension(
  out: CommitmentEncoder,
  manifest: Record<string, unknown>,
): void {
  const appAuthorized: number[] = [];
  const actions = arrayField(manifest, "actions");
  for (const [index, actionValue] of actions.entries()) {
    if (!isRecord(actionValue)) throw new Error("manifest commitment action must be a record");
    // Backward compatibility: this field did not exist in verifier V2's frozen base encoding.
    // Missing/None/explicit Confirmer therefore append no bytes and retain the exact legacy hash.
    const scopeValue = Object.prototype.hasOwnProperty.call(actionValue, "recipient_scope")
      ? actionValue.recipient_scope
      : [];
    if (!Array.isArray(scopeValue) || scopeValue.length > 1) {
      throw new Error("manifest commitment recipient_scope must contain zero or one value");
    }
    if (scopeValue.length === 0) continue;
    const tag = variant(
      scopeValue[0],
      ["confirmer", "app_authorized"],
      "recipient scope",
    );
    if (tag === "app_authorized") appAuthorized.push(index);
  }
  if (appAuthorized.length === 0) return;

  // Frozen additive extension shared with OpenChat. It is omitted entirely for legacy/default
  // scopes, so already installed verifier-v2 manifest hashes remain valid across the upgrade.
  out.raw(utf8.encode("OC-RECIPIENT-SCOPE"));
  out.u8(1);
  out.u32(appAuthorized.length);
  for (const index of appAuthorized) {
    out.u32(index);
    out.u8(1); // app_authorized
  }
}

/** Explicit, language-neutral OpenChat verifier-v2 encoding. */
export function encodeManifestCommitmentV2(commitment: ManifestCommitmentV2): Uint8Array {
  const out = new CommitmentEncoder();
  out.raw(MANIFEST_COMMITMENT_ENCODING_V2);
  out.principal(commitment.user_index_canister_id);
  out.u32(commitment.app_id);
  out.u64(commitment.app_revision);
  out.principal(commitment.owner);
  if (typeof commitment.canonical_name !== "string") {
    throw new Error("manifest commitment canonical_name must be text");
  }
  out.string(commitment.canonical_name);
  if (!isRecord(commitment.manifest)) throw new Error("manifest commitment manifest must be a record");
  encodeManifest(out, commitment.manifest);
  appendRecipientScopeExtension(out, commitment.manifest);
  return out.finish();
}
