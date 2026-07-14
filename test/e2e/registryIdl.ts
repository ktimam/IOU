// Self-contained candid IDL for the OpenChat user_index AI-app registry methods
// the E2E exercises directly (register / ai_apps / explore_ai_apps / delete_ai_app).
// The manifest/action types mirror registerAiApp.ts's buildIdl (which is unit-tested
// to candid-encode correctly); this adds explore + delete, which that module omits.
// claim / revoke are called via the registerAiApp.ts helpers, not this factory.

import { IDL } from "@dfinity/candid";

export function registryService() {
  const AiActionRuleMode = IDL.Variant({ hint: IDL.Null, override: IDL.Null });
  const AiActionNormalizeOp = IDL.Variant({
    k_m_suffix: IDL.Null,
    strip_symbols: IDL.Null,
    uppercase: IDL.Null,
    lowercase: IDL.Null,
    trim: IDL.Null,
  });
  const AiActionContextItem = IDL.Variant({ today: IDL.Null });
  const AiActionKeywordMapEntry = IDL.Record({ value: IDL.Text, keywords: IDL.Vec(IDL.Text) });
  const AiActionRuleIdl = IDL.Variant({
    keyword_map: IDL.Record({ field: IDL.Text, mode: AiActionRuleMode, map: IDL.Vec(AiActionKeywordMapEntry) }),
    from_message: IDL.Record({ field: IDL.Text, max_length: IDL.Opt(IDL.Nat32) }),
    normalize: IDL.Record({ field: IDL.Text, ops: IDL.Vec(AiActionNormalizeOp) }),
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
    accepts_image: IDL.Bool,
  });
  const SurfaceDisplay = IDL.Variant({ sheet: IDL.Null, external: IDL.Null });
  const AiAppSurface = IDL.Record({ kind: IDL.Text, url: IDL.Text, display: SurfaceDisplay });
  const AiAppManifest = IDL.Record({
    name: IDL.Text,
    description: IDL.Text,
    icon_url: IDL.Opt(IDL.Text),
    app_canister_id: IDL.Opt(IDL.Principal),
    inbox_canister_id: IDL.Opt(IDL.Principal),
    consumer_public_key: IDL.Text,
    per_user_keys: IDL.Bool,
    actions: IDL.Vec(AiActionDefinition),
    surfaces: IDL.Vec(AiAppSurface),
  });
  const UserId = IDL.Principal;
  const AiAppRegistration = IDL.Record({
    id: IDL.Nat32,
    owner: UserId,
    manifest: AiAppManifest,
    created: IDL.Nat64,
    updated: IDL.Nat64,
    published: IDL.Bool,
  });
  const OCError = IDL.Tuple(IDL.Nat16, IDL.Opt(IDL.Text));

  const RegisterAiAppArgs = IDL.Record({ manifest: AiAppManifest });
  const RegisterAiAppResponse = IDL.Variant({
    Success: AiAppRegistration,
    InvalidRequest: IDL.Text,
    Error: OCError,
  });
  const AiAppsResponse = IDL.Variant({ Success: IDL.Record({ apps: IDL.Vec(AiAppRegistration) }) });
  const ExploreArgs = IDL.Record({ search_term: IDL.Opt(IDL.Text), page_index: IDL.Nat32, page_size: IDL.Nat8 });
  const ExploreResponse = IDL.Variant({
    Success: IDL.Record({ matches: IDL.Vec(AiAppRegistration), total: IDL.Nat32 }),
    TermTooShort: IDL.Nat8,
    TermTooLong: IDL.Nat8,
    Error: OCError,
  });
  const DeleteArgs = IDL.Record({ name: IDL.Text });
  const DeleteResponse = IDL.Variant({ Success: IDL.Null, NotFound: IDL.Null, Error: OCError });

  return IDL.Service({
    register_ai_app: IDL.Func([RegisterAiAppArgs], [RegisterAiAppResponse], []),
    ai_apps: IDL.Func([IDL.Record({})], [AiAppsResponse], ["query"]),
    explore_ai_apps: IDL.Func([ExploreArgs], [ExploreResponse], ["query"]),
    delete_ai_app: IDL.Func([DeleteArgs], [DeleteResponse], []),
  });
}
