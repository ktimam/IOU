// Stub declarations for IOU backend.
// Run `dfx deploy iou_backend` first, then `dfx generate iou_backend`
// to overwrite this file with the real generated declarations.
//
// Until that has been done at least once, this file gives the PWA a
// typed handle on the backend that returns safe defaults (caller does
// the right thing without a real round-trip).

import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { canisterId as defaultCanisterId, host } from "../features/auth/config";

// `IDL` is normally the runtime value injected into idlFactory. We
// declare it as `any` here because the stub declarations file will
// be overwritten by `dfx generate` once the canister is built.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IDL = any;

export const idlFactory = ({ IDL: idl }: { IDL: IDL }) => {
  const UserRecord = idl.Record({
    principal: idl.Principal,
    wrappedDisplayName: idl.Vec(idl.Nat8),
    displayNameIv: idl.Vec(idl.Nat8),
    createdAt: idl.Int,
  });
  const Config = idl.Record({
    creatorPrincipal: idl.Principal,
    deployedAt: idl.Int,
  });
  return idl.Service({
    whoami: idl.Func([], [idl.Opt(idl.Text)], ["query"]),
    getMyUser: idl.Func([], [idl.Opt(UserRecord)], ["query"]),
    setDisplayName: idl.Func(
      [idl.Vec(idl.Nat8), idl.Vec(idl.Nat8)],
      [UserRecord],
      [],
    ),
    getConfig: idl.Func([], [Config], ["query"]),
    setCreatorPrincipal: idl.Func([idl.Principal], [], []),
  });
};

export function createActor(identity: Identity, canisterIdOverride?: string) {
  const agent = new HttpAgent({ identity, host });
  if (host.includes("127.0.0.1") || host.includes("localhost")) {
    agent.fetchRootKey();
  }
  return Actor.createActor(idlFactory, {
    agent,
    canisterId: canisterIdOverride ?? defaultCanisterId,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type _SERVICE = any;
