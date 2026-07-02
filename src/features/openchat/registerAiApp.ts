// Shared, BROWSER-SAFE core of "register IOU as an OpenChat AI app".
//
// Used by two callers that must stay byte-identical on the wire:
//   - the in-app "Link to OpenChat" button (ActionInboxSettings) — one tap, no key copying;
//   - scripts/register-openchat-app.ts — the Node CLI for CI/deploy pipelines.
//
// It builds IOU's single AiAppManifest (from actionManifest.ts + docs/openchat-registration.json)
// and speaks PLAIN CANDID to OpenChat's user_index `register_ai_app`. No Node-only imports here
// (no fs/process): the paste JSON is a static import, and key/identity/env handling stays with
// the callers.
//
// CRITICAL wire detail: candid variant labels are the PascalCase Rust enum variant names —
// candid's derive does NOT honour `#[serde(rename_all = "snake_case")]` (that only affects the
// msgpack/JSON wire, which this module never speaks). Record fields mirror the Rust struct
// fields; Option<T> maps to IDL.Opt. Do not change the label tables or the IDL below without
// checking user_index/api/can.did.

import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { IDL } from "@dfinity/candid";
import { iouActionManifest } from "./actionManifest";
import type { AiActionRule } from "./actionManifest";
import registrationJson from "../../../docs/openchat-registration.json";

// ---------------------------------------------------------------------------------------------
// Candid IDL — hand-written per the fixed Phase A wire contract (user_index/api/can.did).
// ---------------------------------------------------------------------------------------------

export function buildIdl() {
  // snake_case labels: the Rust enums use per-variant #[serde(rename = "...")], which BOTH
  // candid_derive and serde honor — so the candid wire labels are the snake_case names (matching
  // the msgpack wire). (An earlier revision used the PascalCase Rust idents on the assumption that
  // candid ignores serde renames — true only for rename_all, not per-variant rename.)
  const AiActionRuleMode = IDL.Variant({ hint: IDL.Null, override: IDL.Null });
  const AiActionNormalizeOp = IDL.Variant({
    k_m_suffix: IDL.Null,
    strip_symbols: IDL.Null,
    uppercase: IDL.Null,
    lowercase: IDL.Null,
    trim: IDL.Null,
  });
  const AiActionContextItem = IDL.Variant({ today: IDL.Null });
  const AiActionKeywordMapEntry = IDL.Record({
    value: IDL.Text,
    keywords: IDL.Vec(IDL.Text),
  });
  const AiActionRuleIdl = IDL.Variant({
    keyword_map: IDL.Record({
      field: IDL.Text,
      mode: AiActionRuleMode,
      map: IDL.Vec(AiActionKeywordMapEntry),
    }),
    from_message: IDL.Record({
      field: IDL.Text,
      max_length: IDL.Opt(IDL.Nat32),
    }),
    normalize: IDL.Record({
      field: IDL.Text,
      ops: IDL.Vec(AiActionNormalizeOp),
    }),
    instruction: IDL.Record({ text: IDL.Text }),
    context: IDL.Record({ provide: IDL.Vec(AiActionContextItem) }),
  });
  const AiActionCardRowTemplate = IDL.Record({ field: IDL.Text, label: IDL.Text });
  const AiActionCardTemplate = IDL.Record({
    title: IDL.Text,
    confirm_label: IDL.Text,
    cancel_label: IDL.Text,
    rows: IDL.Vec(AiActionCardRowTemplate),
    disclosure: IDL.Opt(IDL.Text),
  });
  const AiActionDefinition = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    prompt_template: IDL.Text,
    response_schema: IDL.Text,
    card: AiActionCardTemplate,
    endpoint: IDL.Text,
    consumer_public_key: IDL.Opt(IDL.Text),
    rules: IDL.Vec(AiActionRuleIdl),
  });
  const AiAppManifest = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    icon_url: IDL.Opt(IDL.Text),
    consumer_public_key: IDL.Text,
    // Multi-user delivery: when true, OpenChat delivers each user's confirmed actions to THAT
    // user's own registered key (paired via claim_ai_app_link_code) instead of the app key.
    // `#[serde(default)] bool` on the Rust side, but candid still REQUIRES the field on encode.
    per_user_keys: IDL.Bool,
    actions: IDL.Vec(AiActionDefinition),
  });
  const UserId = IDL.Principal;
  const AiAppRegistration = IDL.Record({
    id: IDL.Nat32,
    owner: UserId,
    manifest: AiAppManifest,
    created: IDL.Nat64,
    updated: IDL.Nat64,
  });
  // OCError is a Rust tuple struct (u16, Option<String>).
  const OCError = IDL.Tuple(IDL.Nat16, IDL.Opt(IDL.Text));
  const RegisterAiAppArgs = IDL.Record({ manifest: AiAppManifest });
  const RegisterAiAppResponse = IDL.Variant({
    Success: AiAppRegistration,
    InvalidRequest: IDL.Text,
    Error: OCError,
  });
  const AiAppsArgs = IDL.Record({});
  const AiAppsResponse = IDL.Variant({
    Success: IDL.Record({ apps: IDL.Vec(AiAppRegistration) }),
  });
  // Per-user key pairing: the app pushes a user's public key to OpenChat, authorized by the
  // single-use 6-digit link code OpenChat displayed to that user. No caller guard — the code IS
  // the authorization — so an anonymous agent works.
  const ClaimAiAppLinkCodeArgs = IDL.Record({ code: IDL.Text, public_key: IDL.Text });
  const ClaimAiAppLinkCodeResponse = IDL.Variant({
    Success: IDL.Null,
    CodeNotFound: IDL.Null,
    CodeExpired: IDL.Null,
    InvalidRequest: IDL.Text,
    Error: OCError,
  });

  const service = IDL.Service({
    register_ai_app: IDL.Func([RegisterAiAppArgs], [RegisterAiAppResponse], []),
    ai_apps: IDL.Func([AiAppsArgs], [AiAppsResponse], ["query"]),
    claim_ai_app_link_code: IDL.Func([ClaimAiAppLinkCodeArgs], [ClaimAiAppLinkCodeResponse], []),
  });

  return { RegisterAiAppArgs, ClaimAiAppLinkCodeArgs, service };
}

// ---------------------------------------------------------------------------------------------
// Wire value construction (candid JS values: variants are { label: payload }, opt is [] / [v])
// ---------------------------------------------------------------------------------------------

export type CandidOpt<T> = [] | [T];
const some = <T>(v: T): CandidOpt<T> => [v];
const none = <T>(): CandidOpt<T> => [];
const opt = <T>(v: T | undefined | null): CandidOpt<T> => (v == null ? none() : some(v));

// The candid wire labels equal the TS manifest's snake_case names: the Rust enums carry per-variant
// #[serde(rename)] which BOTH candid_derive and serde honor, so candid and msgpack agree. The label
// tables validate against typos while passing values through unchanged.
const MODE_LABEL: Record<string, string> = { hint: "hint", override: "override" };
const OP_LABEL: Record<string, string> = {
  k_m_suffix: "k_m_suffix",
  strip_symbols: "strip_symbols",
  uppercase: "uppercase",
  lowercase: "lowercase",
  trim: "trim",
};
const CONTEXT_LABEL: Record<string, string> = { today: "today" };

function candidLabel(table: Record<string, string>, value: string, what: string): string {
  const label = table[value];
  if (label === undefined) {
    throw new Error(`unknown ${what} '${value}' in actionManifest.ts — update registerAiApp.ts's label tables`);
  }
  return label;
}

function ruleToWire(rule: AiActionRule): Record<string, unknown> {
  switch (rule.kind) {
    case "keyword_map":
      return {
        keyword_map: {
          field: rule.field,
          mode: { [candidLabel(MODE_LABEL, rule.mode, "rule mode")]: null },
          map: rule.map.map((m) => ({ value: m.value, keywords: m.keywords })),
        },
      };
    case "from_message":
      return { from_message: { field: rule.field, max_length: opt(rule.maxLength) } };
    case "normalize":
      return {
        normalize: {
          field: rule.field,
          ops: rule.ops.map((op) => ({ [candidLabel(OP_LABEL, op, "normalize op")]: null })),
        },
      };
    case "instruction":
      return { instruction: { text: rule.text } };
    case "context":
      return {
        context: {
          provide: rule.provide.map((p) => ({ [candidLabel(CONTEXT_LABEL, p, "context item")]: null })),
        },
      };
  }
}

type PasteJson = {
  name: string;
  description: string;
  promptTemplate: string;
  responseSchema: unknown;
  card: {
    title: string;
    confirmLabel: string;
    cancelLabel: string;
    rows: { label: string; valueKey: string }[];
    disclosure?: string;
  };
  endpoint: string;
  // Multi-user delivery flag; documentation copy of iouActionManifest.perUserKeys (the TS
  // manifest is the registered source of truth).
  perUserKeys?: boolean;
};

/**
 * Build the app manifest wire value. The TS manifest (actionManifest.ts) is the source of truth
 * for prompt / schema / rules; the paste JSON (docs/openchat-registration.json, statically
 * imported so this stays browser-safe) supplies the fields that only exist there (action
 * description, full card template, endpoint).
 *
 * `consumerPublicKeyPem` may be the EMPTY string when the manifest sets `perUserKeys=true`:
 * delivery then always uses each user's own paired key, the app-level key is unused, and
 * OpenChat's register_ai_app accepts `consumer_public_key = ""`. Without per-user keys the app
 * key IS the delivery key, so an empty value is rejected here (before any network call).
 *
 * `onPromptDrift` fires when the paste JSON's promptTemplate has drifted from actionManifest.ts
 * (the actionManifest.ts prompt is registered regardless); callers may override to reword/route
 * the warning.
 */
export function buildManifestWire(
  consumerPublicKeyPem: string,
  onPromptDrift: () => void = () => {
    console.warn("[registerAiApp] WARNING: docs/openchat-registration.json promptTemplate has drifted from");
    console.warn("[registerAiApp]          actionManifest.ts — registering the actionManifest.ts prompt.");
  },
): Record<string, unknown> {
  const paste = registrationJson as PasteJson;

  if (consumerPublicKeyPem.trim() === "" && !iouActionManifest.perUserKeys) {
    throw new Error(
      "an empty consumer_public_key is only allowed when the manifest sets perUserKeys=true — " +
        "supply the app-level delivery key PEM",
    );
  }

  if (paste.promptTemplate !== iouActionManifest.prompt) {
    onPromptDrift();
  }

  const action = {
    name: iouActionManifest.id,
    description: paste.description,
    prompt_template: iouActionManifest.prompt,
    response_schema: JSON.stringify(iouActionManifest.outputSchema),
    card: {
      title: paste.card.title,
      confirm_label: paste.card.confirmLabel,
      cancel_label: paste.card.cancelLabel,
      rows: paste.card.rows.map((r) => ({ field: r.valueKey, label: r.label })),
      disclosure: opt(paste.card.disclosure),
    },
    endpoint: paste.endpoint,
    // No per-action key: the app-level consumer_public_key below is the effective delivery key.
    consumer_public_key: none<string>(),
    rules: iouActionManifest.rules.map(ruleToWire),
  };

  return {
    name: "iou",
    description: iouActionManifest.title,
    icon_url: none<string>(),
    consumer_public_key: consumerPublicKeyPem,
    // Per-user delivery: OpenChat routes each user's confirmed actions to that user's OWN
    // registered key (paired once via the 6-digit link code); the app-level key above is
    // unused ("" is the norm) and only meaningful for per_user_keys=false manifests.
    per_user_keys: iouActionManifest.perUserKeys,
    actions: [action],
  };
}

// ---------------------------------------------------------------------------------------------
// One-call registration (browser + Node) — build manifest, call register_ai_app, decode result.
// ---------------------------------------------------------------------------------------------

export type RegisterAiAppOptions = {
  /** IC gateway serving the OpenChat user_index (NOT IOU's own replica). */
  host: string;
  /** OpenChat user_index canister id. */
  userIndexCanisterId: string;
  /**
   * App-level delivery key (consumer P-256 SPKI PEM). Pass "" for per-user-keys manifests
   * (the IOU manifest sets perUserKeys=true, so "" is the norm — the app key is unused there).
   */
  consumerPublicKeyPem: string;
  /** Caller identity; omit for anonymous (accepted by test_mode local deployments). */
  identity?: Identity;
};

export type RegisterAiAppOutcome =
  | { kind: "success"; appId: number; owner: string }
  | { kind: "invalid_request"; message: string }
  | { kind: "oc_error"; code: number; message?: string };

/**
 * Register (upsert by owner + app name) the IOU app manifest with OpenChat's user_index.
 * Returns a decoded outcome instead of throwing on canister-level rejections; network/agent
 * failures still throw.
 */
export async function registerAiApp(opts: RegisterAiAppOptions): Promise<RegisterAiAppOutcome> {
  const manifest = buildManifestWire(opts.consumerPublicKeyPem);
  const { service } = buildIdl();

  const agent = new HttpAgent({ host: opts.host, ...(opts.identity ? { identity: opts.identity } : {}) });
  if (opts.host.includes("127.0.0.1") || opts.host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(() => service, { agent, canisterId: opts.userIndexCanisterId });

  const response = await actor.register_ai_app({ manifest });
  if ("InvalidRequest" in response) {
    return { kind: "invalid_request", message: response.InvalidRequest as string };
  }
  if ("Error" in response) {
    const [code, message] = response.Error as [number, CandidOpt<string>];
    return { kind: "oc_error", code, message: message.length ? message[0] : undefined };
  }
  const registration = response.Success as { id: number; owner: { toText(): string } };
  return { kind: "success", appId: Number(registration.id), owner: registration.owner.toText() };
}

// ---------------------------------------------------------------------------------------------
// Per-user key pairing — claim a 6-digit link code (from OpenChat's consent sheet) with this
// user's consumer public key. Same agent/host conventions as registerAiApp above.
// ---------------------------------------------------------------------------------------------

export type ClaimLinkCodeOptions = {
  /** IC gateway serving the OpenChat user_index (NOT IOU's own replica). */
  host: string;
  /** OpenChat user_index canister id. */
  userIndexCanisterId: string;
  /** The 6-digit code OpenChat displayed to the user. */
  code: string;
  /** The user's consumer public key (P-256 SPKI PEM) to bind to their OpenChat account. */
  publicKeyPem: string;
  /** Caller identity; optional — the code itself is the authorization, so anonymous works. */
  identity?: Identity;
};

export type ClaimLinkCodeOutcome =
  | { kind: "success" }
  | { kind: "code_not_found" }
  | { kind: "code_expired" }
  | { kind: "invalid_request"; message: string }
  | { kind: "oc_error"; code: number; message?: string };

/**
 * Claim an OpenChat AI-app link code: pushes `publicKeyPem` as the code-owner's per-user
 * delivery key via the user_index's `claim_ai_app_link_code` (plain candid; the single-use
 * code is the bearer authorization). Returns a decoded outcome instead of throwing on
 * canister-level rejections; network/agent failures still throw.
 */
export async function claimAiAppLinkCode(opts: ClaimLinkCodeOptions): Promise<ClaimLinkCodeOutcome> {
  const { service } = buildIdl();

  const agent = new HttpAgent({ host: opts.host, ...(opts.identity ? { identity: opts.identity } : {}) });
  if (opts.host.includes("127.0.0.1") || opts.host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(() => service, { agent, canisterId: opts.userIndexCanisterId });

  const response = await actor.claim_ai_app_link_code({ code: opts.code, public_key: opts.publicKeyPem });
  if ("Success" in response) {
    return { kind: "success" };
  }
  if ("CodeNotFound" in response) {
    return { kind: "code_not_found" };
  }
  if ("CodeExpired" in response) {
    return { kind: "code_expired" };
  }
  if ("InvalidRequest" in response) {
    return { kind: "invalid_request", message: response.InvalidRequest as string };
  }
  const [code, message] = response.Error as [number, CandidOpt<string>];
  return { kind: "oc_error", code, message: message.length ? message[0] : undefined };
}
