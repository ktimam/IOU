// Stub declarations for IOU backend.
// Run `dfx generate iou_backend` to overwrite this with the real
// auto-generated declarations. The hand-written version here mirrors
// the public Candid interface declared in src/iou_backend.did.

import { Actor, HttpAgent, type Identity } from "@dfinity/agent";

// Read an env var in a way that's safe under both Vite (browser-like
// globals, no `process`) and Node (where we run the smoke test).
function readEnv(name: string): string | undefined {
  // Vite exposes import.meta.env at build time. `process` is undefined
  // in the browser bundle, so we check it safely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  if (proc && proc.env && name in proc.env) return proc.env[name];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (import.meta as any).env;
  if (meta && name in meta) return meta[name];
  return undefined;
}

const DEFAULT_HOST = readEnv("IOU_HOST") ?? "http://127.0.0.1:4943";
const DEFAULT_CANISTER_ID =
  readEnv("VITE_IOU_BACKEND_CANISTER_ID") ?? "uxrrr-q7777-77774-qaaaq-cai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IDL = any;

export const idlFactory = ({ IDL: idl }: { IDL: IDL }) => {
  const UserRecord = idl.Record({
    user_principal: idl.Principal,
    wrapped_display_name: idl.Vec(idl.Nat8),
    display_name_iv: idl.Vec(idl.Nat8),
    created_at: idl.Nat64,
    templates_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_iv: idl.Opt(idl.Vec(idl.Nat8)),
    // v1.12.0: the user's ONE default currency (ISO 4217). Caller-scoped: only
    // get_my_user returns it.
    default_currency: idl.Opt(idl.Text),
  });
  const AiAppVerificationBinding = idl.Record({
    user_index_canister_id: idl.Principal,
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    owner: idl.Principal,
    canonical_name: idl.Text,
    app_canister_id: idl.Principal,
    inbox_canister_id: idl.Opt(idl.Principal),
    manifest_hash: idl.Vec(idl.Nat8),
  });
  const Config = idl.Record({
    creator_principal: idl.Principal,
    deployed_at: idl.Nat64,
    // v1.12.0: deployment-wide currency the app-rendered card pre-selects (anonymously readable).
    card_currency: idl.Opt(idl.Text),
    ai_app_owner: idl.Opt(idl.Principal),
    openchat_user_index_canister_id: idl.Opt(idl.Principal),
    ai_app_verification_binding: idl.Opt(AiAppVerificationBinding),
  });
  const VerifyAiAppArgs = idl.Record({ name: idl.Text, owner: idl.Principal });
  const VerifyAiAppResponse = idl.Record({
    vouched: idl.Bool,
    name: idl.Opt(idl.Text),
    owner: idl.Opt(idl.Principal),
  });
  const VerifyAiAppV2Args = idl.Record({ binding: AiAppVerificationBinding });
  const VerifyAiAppV2Response = idl.Record({
    vouched: idl.Bool,
    binding: AiAppVerificationBinding,
  });
  const AttestedActionCardRow = idl.Record({
    label: idl.Text,
    value: idl.Text,
  });
  const AiAppCardContentV1 = idl.Record({
    title: idl.Text,
    rows: idl.Vec(AttestedActionCardRow),
    confirm_label: idl.Text,
    cancel_label: idl.Text,
    action_id: idl.Text,
    disclosure: idl.Opt(idl.Text),
    expires_at: idl.Opt(idl.Nat64),
    confirm_payload: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const AppScopedCardContextV1 = idl.Record({
    context_version: idl.Nat16,
    app_subject: idl.Vec(idl.Nat8),
    chat_handle: idl.Vec(idl.Nat8),
    message_handle: idl.Vec(idl.Nat8),
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    action_id: idl.Text,
  });
  const AppScopedCardContentCommitmentV1 = idl.Record({
    context: AppScopedCardContextV1,
    content: AiAppCardContentV1,
  });
  const CardAttestationBindingV1 = idl.Record({
    user_index_canister_id: idl.Principal,
    app_canister_id: idl.Principal,
    commitment: AppScopedCardContentCommitmentV1,
    authority_content_hash: idl.Vec(idl.Nat8),
  });
  const AttestAiAppCardV1Args = idl.Record({
    binding: CardAttestationBindingV1,
  });
  const AttestAiAppCardV1Response = idl.Record({
    vouched: idl.Bool,
    binding: CardAttestationBindingV1,
  });
  const CardConfirmationAttestationBindingV1 = idl.Record({
    user_index_canister_id: idl.Principal,
    app_canister_id: idl.Principal,
    context: AppScopedCardContextV1,
    content_hash: idl.Vec(idl.Nat8),
    confirm_payload: idl.Vec(idl.Nat8),
    app_user_key_version: idl.Opt(idl.Nat64),
  });
  const AttestAiAppCardConfirmationV1Args = idl.Record({
    binding: CardConfirmationAttestationBindingV1,
  });
  const AttestAiAppCardConfirmationV1Response = idl.Record({
    vouched: idl.Bool,
    binding: CardConfirmationAttestationBindingV1,
  });
  const SheetState = idl.Variant({
    Active: idl.Null,
    Closed: idl.Null,
  });
  const Pair = idl.Record({
    id: idl.Text,
    members: idl.Vec(idl.Principal),
    invite_code: idl.Text,
    created_at: idl.Nat64,
    archived_at: idl.Opt(idl.Nat64),
    name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    name_iv: idl.Opt(idl.Vec(idl.Nat8)),
    member_a_name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    member_a_name_iv: idl.Opt(idl.Vec(idl.Nat8)),
    member_b_name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    member_b_name_iv: idl.Opt(idl.Vec(idl.Nat8)),
    // v1.12.0: per-member SHARED transaction-template slots (a = members[0],
    // b = members[1]), AES-GCM under the active sheet's K_sheet.
    templates_a_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_a_iv: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const PairSummary = idl.Record({
    id: idl.Text,
    other_principal: idl.Principal,
    active_sheet_id: idl.Opt(idl.Text),
    archived_sheet_count: idl.Nat32,
    created_at: idl.Nat64,
    archived_at: idl.Opt(idl.Nat64),
    name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    name_iv: idl.Opt(idl.Vec(idl.Nat8)),
    other_name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    other_name_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const Sheet = idl.Record({
    id: idl.Text,
    pair_id: idl.Text,
    state: SheetState,
    closing_window_days: idl.Nat32,
    last_entry_at: idl.Opt(idl.Nat64),
    wrapped_key_a: idl.Vec(idl.Nat8),
    wrapped_key_b: idl.Vec(idl.Nat8),
    member_a: idl.Principal,
    member_b: idl.Principal,
    created_at: idl.Nat64,
    closed_at: idl.Opt(idl.Nat64),
    closing_balances_key: idl.Opt(idl.Vec(idl.Nat8)),
    closing_balances_enc: idl.Opt(idl.Vec(idl.Nat8)),
    closing_balances_iv: idl.Opt(idl.Vec(idl.Nat8)),
    name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    name_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const CreatePairResult = idl.Record({
    pair_id: idl.Text,
    invite_code: idl.Text,
  });
  const CreateSheetReq = idl.Record({
    pair_id: idl.Text,
    closing_window_days: idl.Nat32,
    wrapped_key_a: idl.Vec(idl.Nat8),
    wrapped_key_b: idl.Vec(idl.Nat8),
    name_enc: idl.Opt(idl.Vec(idl.Nat8)),
    name_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const EncryptedClosingBalances = idl.Record({
    entry_key: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    iv: idl.Vec(idl.Nat8),
  });
  const EntryVersion = idl.Record({
    entry_key: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    iv: idl.Vec(idl.Nat8),
    replaced_at: idl.Nat64,
  });
  const Entry = idl.Record({
    id: idl.Nat64,
    pair_id: idl.Text,
    sheet_id: idl.Text,
    created_by: idl.Principal,
    created_at_server: idl.Nat64,
    updated_at_server: idl.Opt(idl.Nat64),
    entry_key: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    iv: idl.Vec(idl.Nat8),
    history: idl.Opt(idl.Vec(EntryVersion)),
    deleted_at: idl.Opt(idl.Nat64),
  });
  const AddEntryReq = idl.Record({
    sheet_id: idl.Text,
    entry_key: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    iv: idl.Vec(idl.Nat8),
  });
  const EditEntryReq = idl.Record({
    sheet_id: idl.Text,
    entry_id: idl.Nat64,
    entry_key: idl.Vec(idl.Nat8),
    ciphertext: idl.Vec(idl.Nat8),
    iv: idl.Vec(idl.Nat8),
  });
  const ListEntriesResult = idl.Record({
    entries: idl.Vec(Entry),
    next_cursor: idl.Opt(idl.Nat64),
  });
  const ReplaceRequest = idl.Record({
    pair_id: idl.Text,
    leaving_principal: idl.Principal,
    new_principal: idl.Principal,
    ts_ms: idl.Nat64,
    nonce: idl.Vec(idl.Nat8),
  });
  const SignedReplaceRequest = idl.Record({
    request: ReplaceRequest,
    signature: idl.Vec(idl.Nat8),
    signer_pubkey: idl.Vec(idl.Nat8),
  });
  const SheetRewrap = idl.Record({
    sheet_id: idl.Text,
    wrapped_key_for_partner: idl.Vec(idl.Nat8),
  });
  const ConsumerKeypair = idl.Record({
    wrapped_private_key: idl.Vec(idl.Nat8),
    public_key_pem: idl.Text,
  });
  const ConsumerKeypairState = idl.Record({
    mutation_epoch: idl.Nat64,
    keypair: idl.Opt(ConsumerKeypair),
  });
  const ConsumerKeyEpochConflict = idl.Record({
    expected_epoch: idl.Nat64,
    current_epoch: idl.Nat64,
  });
  const ConsumerKeyMutationError = idl.Variant({
    StaleEpoch: ConsumerKeyEpochConflict,
    EpochExhausted: idl.Null,
    OpenChatBindingKeyMismatch: idl.Null,
  });
  const ConsumerKeyMutationResult = idl.Variant({
    Ok: idl.Nat64,
    Err: ConsumerKeyMutationError,
  });
  const ChatSheetLink = idl.Record({
    chat_key: idl.Text,
    sheet_id: idl.Nat64,
  });
  const PendingChatRoute = idl.Record({
    pending_id: idl.Text,
    last_seen: idl.Nat64,
    has_current_link: idl.Bool,
    current_sheet_id: idl.Opt(idl.Nat64),
  });
  const OpenChatBinding = idl.Record({
    iou_principal: idl.Principal,
    user_index_canister_id: idl.Principal,
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    app_canister_id: idl.Principal,
    key_version: idl.Nat64,
    app_subject: idl.Vec(idl.Nat8),
    subject_version: idl.Nat16,
    consumer_queue_selector: idl.Vec(idl.Nat8),
    consumer_queue_selector_version: idl.Nat16,
    linked_at: idl.Nat64,
  });
  const ConnectOpenChatResult = idl.Variant({
    Success: OpenChatBinding,
    NotConfigured: idl.Null,
    CodeNotFound: idl.Null,
    CodeExpired: idl.Null,
    InvalidRequest: idl.Text,
    WrongApp: idl.Null,
    RemoteError: idl.Text,
  });
  const DisconnectOpenChatResult = idl.Variant({
    Success: idl.Null,
    KeyNotFound: idl.Null,
    NotConfigured: idl.Null,
    NotLinked: idl.Null,
    InvalidBinding: idl.Null,
    InvalidRequest: idl.Text,
    BindingChanged: idl.Null,
    RemoteError: idl.Text,
  });
  const OpenChatCardContext = idl.Record({
    sheet_id: idl.Text,
    context_version: idl.Nat16,
    app_subject: idl.Vec(idl.Nat8),
    chat_handle: idl.Vec(idl.Nat8),
    message_handle: idl.Vec(idl.Nat8),
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    action_id: idl.Text,
    vetkd_public_key: idl.Vec(idl.Nat8),
    encrypted_vet_key: idl.Vec(idl.Nat8),
    templates_a_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_a_iv: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const OpenChatCardContextResult = idl.Variant({
    Success: OpenChatCardContext,
    NotConfigured: idl.Null,
    InvalidCapability: idl.Null,
    NotLinked: idl.Null,
    ChatNotLinked: idl.Null,
    NotAuthorized: idl.Null,
    KeyUnavailable: idl.Null,
  });
  return idl.Service({
    // Phase 1
    whoami: idl.Func([], [idl.Opt(idl.Text)], ["query"]),
    get_my_user: idl.Func([], [idl.Opt(UserRecord)], ["query"]),
    set_display_name: idl.Func(
      [idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [UserRecord],
      [],
    ),
    set_user_templates: idl.Func(
      [idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [UserRecord],
      [],
    ),
    set_default_currency: idl.Func([idl.Text], [UserRecord], []),
    get_config: idl.Func([], [Config], ["query"]),
    set_creator_principal: idl.Func([idl.Principal], [], []),
    set_ai_app_owner: idl.Func([idl.Principal], [], []),
    set_openchat_user_index_canister_id: idl.Func([idl.Principal], [], []),
    set_ai_app_verification_binding: idl.Func([idl.Opt(AiAppVerificationBinding)], [], []),
    set_card_currency: idl.Func([idl.Text], [], []),
    c2c_verify_ai_app: idl.Func([VerifyAiAppArgs], [VerifyAiAppResponse], ["query"]),
    c2c_verify_ai_app_v2: idl.Func([VerifyAiAppV2Args], [VerifyAiAppV2Response], ["query"]),
    c2c_attest_ai_app_card_v1: idl.Func(
      [AttestAiAppCardV1Args],
      [AttestAiAppCardV1Response],
      [],
    ),
    c2c_attest_ai_app_card_confirmation_v1: idl.Func(
      [AttestAiAppCardConfirmationV1Args],
      [AttestAiAppCardConfirmationV1Response],
      [],
    ),
    // Phase 2
    create_pair: idl.Func([], [CreatePairResult], []),
    join_pair: idl.Func([idl.Text], [idl.Text], []),
    // v1.10.0: invite-link auto-join + account lifecycle
    issue_invite: idl.Func([idl.Text], [idl.Text], []),
    accept_invite: idl.Func([idl.Text, idl.Vec(SheetRewrap), idl.Vec(idl.Nat8)], [Pair], []),
    leave_pair: idl.Func([idl.Text], [Pair], []),
    archive_pair: idl.Func([idl.Text], [Pair], []),
    unarchive_pair: idl.Func([idl.Text], [Pair], []),
    delete_pair: idl.Func([idl.Text], [], []),
    get_my_pairs: idl.Func([], [idl.Vec(PairSummary)], ["query"]),
    get_pair: idl.Func([idl.Text], [idl.Opt(Pair)], ["query"]),
    create_sheet: idl.Func([CreateSheetReq], [Sheet], []),
    get_sheet: idl.Func([idl.Text], [idl.Opt(Sheet)], ["query"]),
    get_sheet_wrapped_key: idl.Func(
      [idl.Text],
      [idl.Opt(idl.Vec(idl.Nat8))],
      ["query"],
    ),
    close_sheet_encrypted: idl.Func([idl.Text, EncryptedClosingBalances], [], []),
    start_new_sheet: idl.Func([CreateSheetReq], [Sheet], []),
    // v1.5.0: E2E-encrypted names
    set_pair_name: idl.Func(
      [idl.Text, idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [],
      [],
    ),
    set_sheet_name: idl.Func(
      [idl.Text, idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [],
      [],
    ),
    set_member_name: idl.Func(
      [idl.Text, idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [],
      [],
    ),
    // v1.12.0: shared transaction types per account
    set_pair_templates: idl.Func(
      [idl.Text, idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [],
      [],
    ),
    // Phase 3
    add_entry: idl.Func([AddEntryReq], [Entry], []),
    edit_entry: idl.Func([EditEntryReq], [Entry], []),
    delete_entry: idl.Func([idl.Text, idl.Nat64], [], []),
    restore_entry: idl.Func([idl.Text, idl.Nat64], [], []),
    get_entry: idl.Func([idl.Text, idl.Nat64], [idl.Opt(Entry)], ["query"]),
    list_entries: idl.Func(
      [idl.Text, idl.Opt(idl.Nat64), idl.Nat32],
      [ListEntriesResult],
      ["query"],
    ),
    // Phase 4
    list_archived_sheets: idl.Func([idl.Text], [idl.Vec(Sheet)], ["query"]),
    // v1.1.1: real vetkd
    get_vetkd_key_name: idl.Func([], [idl.Text], ["query"]),
    vetkd_public_key: idl.Func([], [idl.Vec(idl.Nat8)], []),
    vetkd_wrap_sheet_key: idl.Func(
      [idl.Text, idl.Vec(idl.Nat8)],
      [idl.Vec(idl.Nat8)],
      [],
    ),
    // v1.1.2: replace member
    submit_replace_member: idl.Func([SignedReplaceRequest], [Pair], []),
    // v1.3.0: recovery key (V1 fix)
    register_recovery_pubkey: idl.Func([idl.Vec(idl.Nat8)], [], []),
    get_recovery_pubkey: idl.Func(
      [idl.Principal],
      [idl.Opt(idl.Vec(idl.Nat8))],
      ["query"],
    ),
    // v1.4.0: solo sheets
    register_sheet_pubkey: idl.Func([idl.Vec(idl.Nat8)], [], []),
    get_sheet_pubkey: idl.Func(
      [idl.Principal],
      [idl.Opt(idl.Vec(idl.Nat8))],
      ["query"],
    ),
    grant_partner_access: idl.Func(
      [idl.Text, idl.Principal, idl.Vec(SheetRewrap)],
      [idl.Nat32],
      [],
    ),
    // v1.8.0: OpenChat per-user consumer keypair
    set_consumer_keypair: idl.Func(
      [idl.Nat64, idl.Vec(idl.Nat8), idl.Text],
      [ConsumerKeyMutationResult],
      [],
    ),
    get_consumer_keypair: idl.Func([], [ConsumerKeypairState], ["query"]),
    delete_consumer_keypair: idl.Func(
      [idl.Nat64],
      [ConsumerKeyMutationResult],
      [],
    ),
    vetkd_wrap_consumer_key: idl.Func(
      [idl.Vec(idl.Nat8)],
      [idl.Vec(idl.Nat8)],
      [],
    ),
    // v1.9.0: OpenChat chat → sheet mapping
    set_chat_sheet_link: idl.Func([idl.Text, idl.Nat64], [], []),
    remove_chat_sheet_link: idl.Func([idl.Text], [], []),
    chat_sheet_links: idl.Func([], [idl.Vec(ChatSheetLink)], ["query"]),
    chat_routable_sheet_ids: idl.Func([], [idl.Vec(idl.Nat64)], ["query"]),
    pending_chat_routes: idl.Func([], [idl.Vec(PendingChatRoute)], ["query"]),
    assign_pending_chat_route: idl.Func([idl.Text, idl.Nat64], [], []),
    dismiss_pending_chat_route: idl.Func([idl.Text], [], []),
    remove_pending_chat_route_link: idl.Func([idl.Text], [], []),
    connect_openchat: idl.Func([idl.Text, idl.Text], [ConnectOpenChatResult], []),
    get_openchat_binding: idl.Func([], [idl.Opt(OpenChatBinding)], ["query"]),
    disconnect_openchat: idl.Func(
      [idl.Text, idl.Vec(idl.Nat8), idl.Nat64],
      [DisconnectOpenChatResult],
      [],
    ),
    openchat_card_context: idl.Func(
      [idl.Vec(idl.Nat8), idl.Text, idl.Vec(idl.Nat8)],
      [OpenChatCardContextResult],
      [],
    ),
  });
};

/**
 * Create an actor.
 *  - createActor(identity, host?)                 — default canister id
 *  - createActor(agent, canisterIdOverride?)      — caller-built agent
 */
export function createActor(
  identityOrAgent: Identity | HttpAgent,
  hostOrCanisterId?: string,
  canisterIdOverride?: string,
) {
  let agent: HttpAgent;
  let canisterId: string;
  if (identityOrAgent instanceof HttpAgent) {
    agent = identityOrAgent;
    canisterId = hostOrCanisterId ?? DEFAULT_CANISTER_ID;
  } else {
    const host = hostOrCanisterId ?? DEFAULT_HOST;
    agent = new HttpAgent({ identity: identityOrAgent, host });
    if (host.includes("127.0.0.1") || host.includes("localhost")) {
      agent.fetchRootKey();
    }
    canisterId = canisterIdOverride ?? DEFAULT_CANISTER_ID;
  }
  return Actor.createActor(idlFactory, { agent, canisterId });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type _SERVICE = any;
