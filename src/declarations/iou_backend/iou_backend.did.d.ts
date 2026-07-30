import type { Principal } from '@dfinity/principal';
import type { ActorMethod } from '@dfinity/agent';
import type { IDL } from '@dfinity/candid';

export interface AddEntryReq {
  'iv' : Uint8Array | number[],
  'ciphertext' : Uint8Array | number[],
  'entry_key' : Uint8Array | number[],
  'sheet_id' : string,
}
export interface ClosingBalance {
  'amount_minor' : bigint,
  'direction' : Direction,
  'currency' : string,
}
export interface Config {
  'deployed_at' : bigint,
  'creator_principal' : Principal,
}
export interface ConsumedNonce {
  'consumed_at' : bigint,
  'nonce' : Uint8Array | number[],
  'pair_id' : string,
}
export interface CreatePairResult { 'invite_code' : string, 'pair_id' : string }
export interface CreateSheetReq {
  'closing_window_days' : number,
  'wrapped_key_a' : Uint8Array | number[],
  'wrapped_key_b' : Uint8Array | number[],
  'pair_id' : string,
}
export type Direction = { 'Debt' : null } |
  { 'Credit' : null };
export interface EditEntryReq {
  'iv' : Uint8Array | number[],
  'ciphertext' : Uint8Array | number[],
  'entry_key' : Uint8Array | number[],
  'sheet_id' : string,
  'entry_id' : bigint,
}
export interface Entry {
  'id' : bigint,
  'iv' : Uint8Array | number[],
  'ciphertext' : Uint8Array | number[],
  'entry_key' : Uint8Array | number[],
  'created_by' : Principal,
  'sheet_id' : string,
  'pair_id' : string,
  'created_at_server' : bigint,
  'updated_at_server' : [] | [bigint],
}
export interface ListEntriesResult {
  'entries' : Array<Entry>,
  'next_cursor' : [] | [bigint],
}
export interface Pair {
  'id' : string,
  'members' : Array<Principal>,
  'invite_code' : string,
  'created_at' : bigint,
  'archived_at' : [] | [bigint],
}
export interface PairSummary {
  'id' : string,
  'archived_sheet_count' : number,
  'active_sheet_id' : [] | [string],
  'created_at' : bigint,
  'other_principal' : Principal,
}
export interface RecoveryKey {
  'owner' : Principal,
  'ed25519_pubkey' : Uint8Array | number[],
  'registered_at' : bigint,
}
export interface ReplaceRequest {
  'ts_ms' : bigint,
  'leaving_principal' : Principal,
  'new_principal' : Principal,
  'nonce' : Uint8Array | number[],
  'pair_id' : string,
}
export interface Sheet {
  'id' : string,
  'member_a' : Principal,
  'member_b' : Principal,
  'closed_at' : [] | [bigint],
  'last_entry_at' : [] | [bigint],
  'created_at' : bigint,
  'closing_window_days' : number,
  'state' : SheetState,
  'closing_balances' : [] | [Array<ClosingBalance>],
  'wrapped_key_a' : Uint8Array | number[],
  'wrapped_key_b' : Uint8Array | number[],
  'pair_id' : string,
}
export type SheetState = { 'Closed' : null } |
  { 'Active' : null };
export interface SignedReplaceRequest {
  'signature' : Uint8Array | number[],
  'request' : ReplaceRequest,
  'signer_pubkey' : Uint8Array | number[],
}
export interface UserRecord {
  'user_principal' : Principal,
  'created_at' : bigint,
  'wrapped_display_name' : Uint8Array | number[],
  'display_name_iv' : Uint8Array | number[],
}
export interface _SERVICE {
  'add_entry' : ActorMethod<[AddEntryReq], Entry>,
  'close_sheet' : ActorMethod<[string, Array<ClosingBalance>], undefined>,
  'create_pair' : ActorMethod<[], CreatePairResult>,
  'create_sheet' : ActorMethod<[CreateSheetReq], Sheet>,
  'edit_entry' : ActorMethod<[EditEntryReq], Entry>,
  'get_config' : ActorMethod<[], Config>,
  'get_entry' : ActorMethod<[string, bigint], [] | [Entry]>,
  'get_my_pairs' : ActorMethod<[], Array<PairSummary>>,
  'get_my_user' : ActorMethod<[], [] | [UserRecord]>,
  'get_pair' : ActorMethod<[string], [] | [Pair]>,
  'get_recovery_pubkey' : ActorMethod<
    [Principal],
    [] | [Uint8Array | number[]]
  >,
  'get_sheet' : ActorMethod<[string], [] | [Sheet]>,
  'get_sheet_wrapped_key' : ActorMethod<[string], [] | [Uint8Array | number[]]>,
  'get_vetkd_key_name' : ActorMethod<[], string>,
  'join_pair' : ActorMethod<[string], string>,
  'list_archived_sheets' : ActorMethod<[string], Array<Sheet>>,
  'list_entries' : ActorMethod<
    [string, [] | [bigint], number],
    ListEntriesResult
  >,
  'register_recovery_pubkey' : ActorMethod<[Uint8Array | number[]], undefined>,
  'set_creator_principal' : ActorMethod<[Principal], undefined>,
  'set_display_name' : ActorMethod<
    [Uint8Array | number[], Uint8Array | number[]],
    UserRecord
  >,
  'start_new_sheet' : ActorMethod<[CreateSheetReq], Sheet>,
  'submit_replace_member' : ActorMethod<[SignedReplaceRequest], Pair>,
  'vetkd_public_key' : ActorMethod<[], Uint8Array | number[]>,
  'vetkd_wrap_sheet_key' : ActorMethod<
    [string, Uint8Array | number[]],
    Uint8Array | number[]
  >,
  'whoami' : ActorMethod<[], [] | [string]>,
}
export declare const idlFactory: IDL.InterfaceFactory;
export declare const init: (args: { IDL: typeof IDL }) => IDL.Type[];
