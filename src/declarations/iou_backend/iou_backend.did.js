export const idlFactory = ({ IDL }) => {
  const AddEntryReq = IDL.Record({
    'iv' : IDL.Vec(IDL.Nat8),
    'ciphertext' : IDL.Vec(IDL.Nat8),
    'entry_key' : IDL.Vec(IDL.Nat8),
    'sheet_id' : IDL.Text,
  });
  const Entry = IDL.Record({
    'id' : IDL.Nat64,
    'iv' : IDL.Vec(IDL.Nat8),
    'ciphertext' : IDL.Vec(IDL.Nat8),
    'entry_key' : IDL.Vec(IDL.Nat8),
    'created_by' : IDL.Principal,
    'sheet_id' : IDL.Text,
    'pair_id' : IDL.Text,
    'created_at_server' : IDL.Nat64,
    'updated_at_server' : IDL.Opt(IDL.Nat64),
  });
  const Direction = IDL.Variant({ 'Debt' : IDL.Null, 'Credit' : IDL.Null });
  const ClosingBalance = IDL.Record({
    'amount_minor' : IDL.Nat64,
    'direction' : Direction,
    'currency' : IDL.Text,
  });
  const CreatePairResult = IDL.Record({
    'invite_code' : IDL.Text,
    'pair_id' : IDL.Text,
  });
  const CreateSheetReq = IDL.Record({
    'closing_window_days' : IDL.Nat32,
    'wrapped_key_a' : IDL.Vec(IDL.Nat8),
    'wrapped_key_b' : IDL.Vec(IDL.Nat8),
    'pair_id' : IDL.Text,
  });
  const SheetState = IDL.Variant({ 'Closed' : IDL.Null, 'Active' : IDL.Null });
  const Sheet = IDL.Record({
    'id' : IDL.Text,
    'member_a' : IDL.Principal,
    'member_b' : IDL.Principal,
    'closed_at' : IDL.Opt(IDL.Nat64),
    'last_entry_at' : IDL.Opt(IDL.Nat64),
    'created_at' : IDL.Nat64,
    'closing_window_days' : IDL.Nat32,
    'state' : SheetState,
    'closing_balances' : IDL.Opt(IDL.Vec(ClosingBalance)),
    'wrapped_key_a' : IDL.Vec(IDL.Nat8),
    'wrapped_key_b' : IDL.Vec(IDL.Nat8),
    'pair_id' : IDL.Text,
  });
  const EditEntryReq = IDL.Record({
    'iv' : IDL.Vec(IDL.Nat8),
    'ciphertext' : IDL.Vec(IDL.Nat8),
    'entry_key' : IDL.Vec(IDL.Nat8),
    'sheet_id' : IDL.Text,
    'entry_id' : IDL.Nat64,
  });
  const Config = IDL.Record({
    'deployed_at' : IDL.Nat64,
    'creator_principal' : IDL.Principal,
  });
  const PairSummary = IDL.Record({
    'id' : IDL.Text,
    'archived_sheet_count' : IDL.Nat32,
    'active_sheet_id' : IDL.Opt(IDL.Text),
    'created_at' : IDL.Nat64,
    'other_principal' : IDL.Principal,
  });
  const UserRecord = IDL.Record({
    'user_principal' : IDL.Principal,
    'created_at' : IDL.Nat64,
    'wrapped_display_name' : IDL.Vec(IDL.Nat8),
    'display_name_iv' : IDL.Vec(IDL.Nat8),
  });
  const Pair = IDL.Record({
    'id' : IDL.Text,
    'members' : IDL.Vec(IDL.Principal),
    'invite_code' : IDL.Text,
    'created_at' : IDL.Nat64,
    'archived_at' : IDL.Opt(IDL.Nat64),
  });
  const ListEntriesResult = IDL.Record({
    'entries' : IDL.Vec(Entry),
    'next_cursor' : IDL.Opt(IDL.Nat64),
  });
  const ReplaceRequest = IDL.Record({
    'ts_ms' : IDL.Nat64,
    'leaving_principal' : IDL.Principal,
    'new_principal' : IDL.Principal,
    'nonce' : IDL.Vec(IDL.Nat8),
    'pair_id' : IDL.Text,
  });
  const SignedReplaceRequest = IDL.Record({
    'signature' : IDL.Vec(IDL.Nat8),
    'request' : ReplaceRequest,
    'signer_pubkey' : IDL.Vec(IDL.Nat8),
  });
  return IDL.Service({
    'add_entry' : IDL.Func([AddEntryReq], [Entry], []),
    'close_sheet' : IDL.Func([IDL.Text, IDL.Vec(ClosingBalance)], [], []),
    'create_pair' : IDL.Func([], [CreatePairResult], []),
    'create_sheet' : IDL.Func([CreateSheetReq], [Sheet], []),
    'edit_entry' : IDL.Func([EditEntryReq], [Entry], []),
    'get_config' : IDL.Func([], [Config], ['query']),
    'get_entry' : IDL.Func([IDL.Text, IDL.Nat64], [IDL.Opt(Entry)], ['query']),
    'get_my_pairs' : IDL.Func([], [IDL.Vec(PairSummary)], ['query']),
    'get_my_user' : IDL.Func([], [IDL.Opt(UserRecord)], ['query']),
    'get_pair' : IDL.Func([IDL.Text], [IDL.Opt(Pair)], ['query']),
    'get_recovery_pubkey' : IDL.Func(
        [IDL.Principal],
        [IDL.Opt(IDL.Vec(IDL.Nat8))],
        ['query'],
      ),
    'get_sheet' : IDL.Func([IDL.Text], [IDL.Opt(Sheet)], ['query']),
    'get_sheet_wrapped_key' : IDL.Func(
        [IDL.Text],
        [IDL.Opt(IDL.Vec(IDL.Nat8))],
        ['query'],
      ),
    'get_vetkd_key_name' : IDL.Func([], [IDL.Text], ['query']),
    'join_pair' : IDL.Func([IDL.Text], [IDL.Text], []),
    'list_archived_sheets' : IDL.Func([IDL.Text], [IDL.Vec(Sheet)], ['query']),
    'list_entries' : IDL.Func(
        [IDL.Text, IDL.Opt(IDL.Nat64), IDL.Nat32],
        [ListEntriesResult],
        ['query'],
      ),
    'register_recovery_pubkey' : IDL.Func([IDL.Vec(IDL.Nat8)], [], []),
    'set_creator_principal' : IDL.Func([IDL.Principal], [], []),
    'set_display_name' : IDL.Func(
        [IDL.Vec(IDL.Nat8), IDL.Vec(IDL.Nat8)],
        [UserRecord],
        [],
      ),
    'start_new_sheet' : IDL.Func([CreateSheetReq], [Sheet], []),
    'submit_replace_member' : IDL.Func([SignedReplaceRequest], [Pair], []),
    'vetkd_public_key' : IDL.Func([], [IDL.Vec(IDL.Nat8)], []),
    'vetkd_wrap_sheet_key' : IDL.Func(
        [IDL.Text, IDL.Vec(IDL.Nat8)],
        [IDL.Vec(IDL.Nat8)],
        [],
      ),
    'whoami' : IDL.Func([], [IDL.Opt(IDL.Text)], ['query']),
  });
};
export const init = ({ IDL }) => { return []; };
