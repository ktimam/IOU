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
import { Principal } from "@dfinity/principal";
import { shouldFetchLocalRootKey } from "../../config/devLanQcRuntime";
import { buildIouOutputSchema, buildIouRules, iouActionManifest, resolvePublicOrigin } from "./actionManifest";
import type { AiActionRule, ManifestTemplate } from "./actionManifest";
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
  const AiActionRecipientScope = IDL.Variant({
    confirmer: IDL.Null,
    app_authorized: IDL.Null,
  });
  const AiActionDefinition = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    prompt_template: IDL.Text,
    response_schema: IDL.Text,
    card: AiActionCardTemplate,
    endpoint: IDL.Text,
    consumer_public_key: IDL.Opt(IDL.Text),
    recipient_scope: IDL.Opt(AiActionRecipientScope),
    rules: IDL.Vec(AiActionRuleIdl),
    accepts_image: IDL.Bool,
  });
  // App surfaces: credential-free pages of the app OpenChat can open. URLs may contain only the
  // public app id; private app-scoped coordinates use the canister/card channels.
  // display uses per-variant #[serde(rename)] snake labels, same rule as the enums above.
  const SurfaceDisplay = IDL.Variant({ sheet: IDL.Null, external: IDL.Null });
  const AiAppSurface = IDL.Record({
    kind: IDL.Text,
    url: IDL.Text,
    display: SurfaceDisplay,
  });
  const AiAppManifest = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    icon_url: IDL.Opt(IDL.Text),
    // The app's own canister — OpenChat c2c-calls its c2c_verify_ai_app at publish to confirm we
    // control it (anti-squatting). `#[serde(default)] Option` on the Rust side; candid requires the
    // field on encode, so buildManifestWire always sends it ([] when not supplied).
    app_canister_id: IDL.Opt(IDL.Principal),
    // Per-app inbox override: route this app's confirmed-action deposits to its own action_inbox
    // canister ([] => OpenChat's global inbox). Mirrors AiAppManifest.inbox_canister_id in OpenChat.
    inbox_canister_id: IDL.Opt(IDL.Principal),
    consumer_public_key: IDL.Text,
    // Multi-user delivery: when true, OpenChat delivers each user's confirmed actions to THAT
    // user's own registered key (paired via IOU's app-authenticated C2C claim) instead of the app key.
    // `#[serde(default)] bool` on the Rust side, but candid still REQUIRES the field on encode.
    per_user_keys: IDL.Bool,
    actions: IDL.Vec(AiActionDefinition),
    // `#[serde(default)] Vec` on the Rust side, but candid still REQUIRES the field on encode —
    // buildManifestWire always sends it ([] when the manifest declares none).
    surfaces: IDL.Vec(AiAppSurface),
  });
  const UserId = IDL.Principal;
  const AiAppRegistration = IDL.Record({
    id: IDL.Nat32,
    owner: UserId,
    manifest: AiAppManifest,
    created: IDL.Nat64,
    updated: IDL.Nat64,
  });
  // OpenChat publication verifier V2 hashes the canonical Candid encoding of this exact record,
  // prefixed by its versioned domain separator. Exporting the IDL lets the controller-side
  // registration script compute the commitment independently before configuring IOU.
  const ManifestCommitmentV2 = IDL.Record({
    user_index_canister_id: IDL.Principal,
    app_id: IDL.Nat32,
    app_revision: IDL.Nat64,
    owner: IDL.Principal,
    canonical_name: IDL.Text,
    manifest: AiAppManifest,
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
  const service = IDL.Service({
    register_ai_app: IDL.Func([RegisterAiAppArgs], [RegisterAiAppResponse], []),
    ai_apps: IDL.Func([AiAppsArgs], [AiAppsResponse], ["query"]),
  });

  return {
    RegisterAiAppArgs,
    ManifestCommitmentV2,
    service,
  };
}

// ---------------------------------------------------------------------------------------------
// Wire value construction (candid JS values: variants are { label: payload }, opt is [] / [v])
// ---------------------------------------------------------------------------------------------

export type CandidOpt<T> = [] | [T];
const some = <T>(v: T): CandidOpt<T> => [v];
const none = <T>(): CandidOpt<T> => [];
const opt = <T>(v: T | undefined | null): CandidOpt<T> => (v == null ? none() : some(v));

// Parse a canister-id text into a Principal, tolerating a non-principal value (e.g. the local dfx
// alias "iou_backend"): returns undefined so the caller sends [] rather than throwing.
function parseCanisterId(id: string | undefined): Principal | undefined {
  if (!id) return undefined;
  try {
    return Principal.fromText(id);
  } catch {
    console.warn(`[registerAiApp] app_canister_id "${id}" is not a valid principal — omitting (publish will be blocked)`);
    return undefined;
  }
}

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
const DISPLAY_LABEL: Record<string, string> = { sheet: "sheet", external: "external" };
const RECIPIENT_SCOPE_LABEL: Record<string, string> = {
  confirmer: "confirmer",
  app_authorized: "app_authorized",
};

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
 * for prompt / schema / rules / public rows; the paste JSON
 * (docs/openchat-registration.json, statically imported so this stays browser-safe) supplies the
 * fields that only exist there (action description, card chrome, endpoint).
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
  appCanisterId?: string,
  onPromptDrift: () => void = () => {
    console.warn("[registerAiApp] WARNING: docs/openchat-registration.json promptTemplate has drifted from");
    console.warn("[registerAiApp]          actionManifest.ts — registering the actionManifest.ts prompt.");
  },
  inboxCanisterId?: string,
  // Compatibility-only regression seam: private templates must never affect the public wire.
  privateTemplatesForLeakTest: ManifestTemplate[] = [],
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
    response_schema: JSON.stringify(buildIouOutputSchema(privateTemplatesForLeakTest)),
    card: {
      title: paste.card.title,
      confirm_label: paste.card.confirmLabel,
      cancel_label: paste.card.cancelLabel,
      rows: iouActionManifest.card.fields.map(({ key, label }) => ({ field: key, label })),
      disclosure: opt(paste.card.disclosure),
    },
    endpoint: paste.endpoint,
    // No per-action key: the app-level consumer_public_key below is the effective delivery key.
    consumer_public_key: none<string>(),
    // App-authorized is an explicit opt-in. Older/other actions that omit this option retain the
    // confirmer-only default and cannot request broader delivery.
    recipient_scope: opt({
      [candidLabel(
        RECIPIENT_SCOPE_LABEL,
        iouActionManifest.recipientScope,
        "recipient scope",
      )]: null,
    }),
    rules: buildIouRules(privateTemplatesForLeakTest).map(ruleToWire),
    // Opt into OpenChat's auto-propose-on-image chip (this action extracts from receipt images).
    accepts_image: iouActionManifest.acceptsImage,
  };

  return {
    name: "iou",
    description: iouActionManifest.title,
    // OpenChat intentionally rejects data: URLs in registered manifests. Serve the same static
    // icon from the app's validated public origin; local test mode permits this loopback HTTP URL,
    // while production deployments resolve to their HTTPS origin.
    icon_url: opt(`${resolvePublicOrigin()}/favicon.svg`),
    // Our own backend canister, so OpenChat can verify we control it before publishing (its
    // c2c_verify_ai_app query vouches for name "iou"). Deployment-specific, so it's supplied at
    // registration (not in the static manifest); [] when unknown/unparseable (a local dfx alias
    // like "iou_backend" isn't a principal) — publish then stays blocked but registration works.
    app_canister_id: opt(parseCanisterId(appCanisterId)),
    // Per-app inbox override (see the IDL note): [] => OpenChat's global inbox.
    inbox_canister_id: opt(parseCanisterId(inboxCanisterId)),
    consumer_public_key: consumerPublicKeyPem,
    // Per-user delivery: OpenChat routes each user's confirmed actions to that user's OWN
    // registered key (paired once via the high-entropy claim token); the app-level key above is
    // unused ("" is the norm) and only meaningful for per_user_keys=false manifests.
    per_user_keys: iouActionManifest.perUserKeys,
    actions: [action],
    // App surfaces (candid requires the field even though the Rust side defaults it). The wire is
    // msgpack/candid-identical: {kind, url, display: "sheet"|"external"} with snake labels.
    surfaces: iouActionManifest.surfaces.map((s) => ({
      kind: s.kind,
      url: s.url,
      display: { [candidLabel(DISPLAY_LABEL, s.display, "surface display")]: null },
    })),
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
  /**
   * IOU's own backend canister id (text). OpenChat c2c-calls its c2c_verify_ai_app at publish to
   * confirm we control it. Deployment-specific; omit only if publishing is not needed.
   */
  appCanisterId?: string;
  /**
   * IOU's own action_inbox canister id (text) — the per-app inbox override written into the manifest
   * so OpenChat routes confirmed-action deposits to IOU's inbox rather than its global one. MUST be
   * supplied on EVERY (re)registration: register_ai_app is an upsert, so omitting it drops the inbox
   * override and later confirms fail deposit with `NotConfigured` (nothing reaches IOU). Omit only to
   * intentionally use OpenChat's global inbox.
   */
  inboxCanisterId?: string;
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
  const manifest = buildManifestWire(
    opts.consumerPublicKeyPem,
    opts.appCanisterId,
    undefined,
    // Preserve the per-app inbox override on every upsert — dropping it makes deposits NotConfigured.
    opts.inboxCanisterId,
  );
  const { service } = buildIdl();

  const agent = new HttpAgent({ host: opts.host, ...(opts.identity ? { identity: opts.identity } : {}) });
  if (shouldFetchLocalRootKey()) {
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

export type QueryAiAppsOptions = {
  /** IC gateway serving the OpenChat user_index. */
  host: string;
  /** OpenChat user_index canister id. */
  userIndexCanisterId: string;
  /** Caller identity; omit for anonymous — `ai_apps` is a query and returns published apps. */
  identity?: Identity;
};

/**
 * Read this app's registered `inbox_canister_id` straight from OpenChat's user_index — the SINGLE
 * SOURCE OF TRUTH for where confirmed-action deposits land (OpenChat routes them to exactly this
 * id). So the app never needs the inbox id configured by hand: it reads back what it registered.
 * Returns the inbox canister id (text), or null when the app isn't registered, declares no per-app
 * inbox (`inbox_canister_id == []` → OpenChat's global inbox), or can't be matched. When
 * `appCanisterId` is supplied it is preferred as a tie-break (anti-squatting: a different owner
 * can't shadow the "iou" name).
 */
export type RegisteredActionInboxRoute = {
  canisterId: string;
  appId: number;
  appRevision: bigint;
};

export async function getRegisteredActionInboxRoute(
  opts: QueryAiAppsOptions & { appName?: string; appCanisterId?: string },
): Promise<RegisteredActionInboxRoute | null> {
  const { service } = buildIdl();
  const agent = new HttpAgent({ host: opts.host, ...(opts.identity ? { identity: opts.identity } : {}) });
  if (shouldFetchLocalRootKey()) {
    await agent.fetchRootKey();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(() => service, { agent, canisterId: opts.userIndexCanisterId });
  const resp = await actor.ai_apps({});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const apps: any[] = resp?.Success?.apps ?? [];
  const name = opts.appName ?? "iou";
  const named = apps.filter((a) => a?.manifest?.name === name);
  const byCanister = opts.appCanisterId
    ? named.find((a) => {
        const c = a?.manifest?.app_canister_id as CandidOpt<Principal> | undefined;
        const p = c && c.length > 0 ? c[0] : undefined;
        return p !== undefined && p.toText() === opts.appCanisterId;
      })
    : undefined;
  const app = byCanister ?? named[0];
  if (!app) return null;
  const inbox = app.manifest.inbox_canister_id as CandidOpt<Principal>;
  const inboxPrincipal = inbox && inbox.length > 0 ? inbox[0] : undefined;
  if (inboxPrincipal === undefined) return null;
  const appId = Number(app.id);
  const appRevision = app.updated;
  if (
    !Number.isSafeInteger(appId) ||
    appId < 0 ||
    appId > 0xffff_ffff ||
    typeof appRevision !== "bigint" ||
    appRevision < 0n
  ) {
    throw new Error("OpenChat returned an invalid registered app route");
  }
  return { canisterId: inboxPrincipal.toText(), appId, appRevision };
}

/** Compatibility helper for callers that only need the registered inbox canister id. */
export async function getRegisteredInboxCanisterId(
  opts: QueryAiAppsOptions & { appName?: string; appCanisterId?: string },
): Promise<string | null> {
  return (await getRegisteredActionInboxRoute(opts))?.canisterId ?? null;
}

// ---------------------------------------------------------------------------------------------
// Browser-only token normalization. Pairing itself never uses this public registry
// client: ActionInboxSettings calls the signed-in IOU backend, which performs
// c2c_claim_ai_app_link_code as the registered app canister.
// ---------------------------------------------------------------------------------------------

export const OPENCHAT_CLAIM_TOKEN_HEX_LENGTH = 64;

/** Canonical copy/paste form used by both validation and the candid call. */
export function normalizeOpenChatClaimToken(value: string): string {
  return value.trim().toLowerCase();
}

/** OpenChat claim tokens are 32 random bytes encoded as lowercase hexadecimal. */
export function isValidOpenChatClaimToken(value: string): boolean {
  const token = normalizeOpenChatClaimToken(value);
  return token.length === OPENCHAT_CLAIM_TOKEN_HEX_LENGTH && /^[0-9a-f]+$/.test(token);
}
