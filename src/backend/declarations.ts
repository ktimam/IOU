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
  });
  const Config = idl.Record({
    creator_principal: idl.Principal,
    deployed_at: idl.Nat64,
  });
  const SheetState = idl.Variant({
    Active: idl.Null,
    Closed: idl.Null,
  });
  const Direction = idl.Variant({
    Credit: idl.Null,
    Debt: idl.Null,
  });
  const ClosingBalance = idl.Record({
    currency: idl.Text,
    amount_minor: idl.Nat64,
    direction: Direction,
  });
  const Pair = idl.Record({
    id: idl.Text,
    members: idl.Vec(idl.Principal),
    invite_code: idl.Text,
    created_at: idl.Nat64,
    archived_at: idl.Opt(idl.Nat64),
  });
  const PairSummary = idl.Record({
    id: idl.Text,
    other_principal: idl.Principal,
    active_sheet_id: idl.Opt(idl.Text),
    archived_sheet_count: idl.Nat32,
    created_at: idl.Nat64,
  });
  const Sheet = idl.Record({
    id: idl.Text,
    pair_id: idl.Text,
    state: SheetState,
    enabled_currencies: idl.Vec(idl.Text),
    closing_window_days: idl.Nat32,
    last_entry_at: idl.Opt(idl.Nat64),
    wrapped_key_a: idl.Vec(idl.Nat8),
    wrapped_key_b: idl.Vec(idl.Nat8),
    member_a: idl.Principal,
    member_b: idl.Principal,
    created_at: idl.Nat64,
    closed_at: idl.Opt(idl.Nat64),
    closing_balances: idl.Opt(idl.Vec(ClosingBalance)),
  });
  const CreatePairResult = idl.Record({
    pair_id: idl.Text,
    invite_code: idl.Text,
  });
  const CreateSheetReq = idl.Record({
    pair_id: idl.Text,
    enabled_currencies: idl.Vec(idl.Text),
    closing_window_days: idl.Nat32,
    wrapped_key_a: idl.Vec(idl.Nat8),
    wrapped_key_b: idl.Vec(idl.Nat8),
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
  return idl.Service({
    // Phase 1
    whoami: idl.Func([], [idl.Opt(idl.Text)], ["query"]),
    get_my_user: idl.Func([], [idl.Opt(UserRecord)], ["query"]),
    set_display_name: idl.Func(
      [idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [UserRecord],
      [],
    ),
    get_config: idl.Func([], [Config], ["query"]),
    set_creator_principal: idl.Func([idl.Principal], [], []),
    // Phase 2
    create_pair: idl.Func([], [CreatePairResult], []),
    join_pair: idl.Func([idl.Text], [idl.Text], []),
    get_my_pairs: idl.Func([], [idl.Vec(PairSummary)], ["query"]),
    get_pair: idl.Func([idl.Text], [idl.Opt(Pair)], ["query"]),
    create_sheet: idl.Func([CreateSheetReq], [Sheet], []),
    get_sheet: idl.Func([idl.Text], [idl.Opt(Sheet)], ["query"]),
    get_sheet_wrapped_key: idl.Func(
      [idl.Text],
      [idl.Opt(idl.Vec(idl.Nat8))],
      ["query"],
    ),
    add_currency: idl.Func([idl.Text, idl.Text], [], []),
    close_sheet: idl.Func([idl.Text, idl.Vec(ClosingBalance)], [], []),
    start_new_sheet: idl.Func([CreateSheetReq], [Sheet], []),
    // Phase 3
    add_entry: idl.Func([AddEntryReq], [Entry], []),
    edit_entry: idl.Func([EditEntryReq], [Entry], []),
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
