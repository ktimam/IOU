// Stub declarations for IOU backend.
// Run `dfx generate iou_backend` to overwrite this with the real
// auto-generated declarations. The hand-written version here mirrors
// the public Candid interface declared in src/iou_backend.did.
//
// Method names follow snake_case (the Candid convention; Rust-side
// `set_display_name` is the function that `set_display_name` in
// Candid calls). After `dfx generate` this file is overwritten with
// the canonical version.

import { Actor, HttpAgent, type Identity } from "@dfinity/agent";

// We don't import from src/features/auth/config.ts here because that
// file uses Vite's `import.meta.env` and isn't safe to import under
// plain Node. Pass the host + canister id explicitly instead.

const DEFAULT_HOST =
  typeof process !== "undefined" && process.env?.IOU_HOST
    ? process.env.IOU_HOST
    : "http://127.0.0.1:4943";

const DEFAULT_CANISTER_ID =
  typeof process !== "undefined" && process.env?.VITE_IOU_BACKEND_CANISTER_ID
    ? process.env.VITE_IOU_BACKEND_CANISTER_ID
    : "bkyz2-fmaaa-aaaaa-qaaaq-cai";

// `IDL` is normally the runtime value injected into idlFactory. We
// declare it as `any` here because the stub declarations file will
// be overwritten by `dfx generate` once the canister is built.
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
  return idl.Service({
    whoami: idl.Func([], [idl.Opt(idl.Text)], ["query"]),
    get_my_user: idl.Func([], [idl.Opt(UserRecord)], ["query"]),
    set_display_name: idl.Func(
      [idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [UserRecord],
      [],
    ),
    get_config: idl.Func([], [idl.Config], ["query"]),
    set_creator_principal: idl.Func([idl.Principal], [], []),
  });
};

/**
 * Create an actor.
 *
 * Two calling conventions:
 *  - createActor(identity, host?)                 — uses default canister id
 *  - createActor(agent, canisterIdOverride?)      — uses a caller-built agent
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
