// Explicit synthetic/local-only test helper. Never reads identities or existing replica state.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Actor, HttpAgent } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";

const [command, gateway, argument, expectedHash] = process.argv.slice(2);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const url = new URL(gateway);
process.on("uncaughtException", (error) => {
  console.error(String(error?.message ?? error).slice(0, 1800));
  process.exitCode = 1;
});
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
  throw new Error("Only an explicit loopback test gateway is permitted");
}
if (command === "install") {
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? "")) throw new Error("Pin the newly built local Wasm SHA-256");
  const wasm = readFileSync(resolve(root, argument));
  const hash = createHash("sha256").update(wasm).digest("hex");
  if (hash !== expectedHash.toLowerCase()) throw new Error("Wasm changed after the reviewed local build");
  const identity = Secp256k1KeyIdentity.generate(); // Synthetic controller; never persisted or logged.
  const agent = new HttpAgent({ host: url.origin, identity });
  await agent.fetchRootKey();
  const management = Actor.createActor(({ IDL }) => IDL.Service({
    provisional_create_canister_with_cycles: IDL.Func([IDL.Record({
      amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({
        controllers: IDL.Opt(IDL.Vec(IDL.Principal)), compute_allocation: IDL.Opt(IDL.Nat),
        memory_allocation: IDL.Opt(IDL.Nat), freezing_threshold: IDL.Opt(IDL.Nat),
      })), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64),
    })], [IDL.Record({ canister_id: IDL.Principal })], []),
    install_code: IDL.Func([IDL.Record({
      mode: IDL.Variant({ install: IDL.Null }), canister_id: IDL.Principal,
      wasm_module: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64),
    })], [], []),
  }), { agent, canisterId: "aaaaa-aa",
    effectiveCanisterId: Principal.fromUint8Array(Buffer.from(process.env.IOU_TEST_EFFECTIVE_ID ?? "///////QAAABAQ==", "base64")),
    callTransform: (_method, args) => args[0]?.canister_id ? { effectiveCanisterId: args[0].canister_id } : {},
  });
  const { canister_id: canisterId } = await management.provisional_create_canister_with_cycles({
    amount: [1_000_000_000_000_000n], specified_id: [], sender_canister_version: [],
    settings: [{ controllers: [[identity.getPrincipal()]], compute_allocation: [], memory_allocation: [], freezing_threshold: [] }],
  });
  await management.install_code({ mode: { install: null }, canister_id: canisterId, wasm_module: wasm,
    arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [] });
  const probe = Actor.createActor(({ IDL }) => IDL.Service({
    get_vetkd_key_name: IDL.Func([], [IDL.Text], ["query"]),
    vetkd_public_key: IDL.Func([], [IDL.Vec(IDL.Nat8)], []),
  }), { agent, canisterId });
  const keyName = await probe.get_vetkd_key_name();
  if (keyName !== "dfx_test_key") throw new Error("Refusing a non-local VetKD key in synthetic tests");
  const publicKey = await probe.vetkd_public_key();
  console.log(JSON.stringify({ canisterId: canisterId.toText(), gateway: url.origin, wasmSha256: hash,
    keyName, publicKeyBytes: publicKey.length }));
} else if (command === "serve") {
  const canisterId = Principal.fromText(argument).toText();
  if (canisterId === "aaaaa-aa" || canisterId === "2vxsx-fae") throw new Error("An installed local backend is required");
  Object.assign(process.env, {
    IOU_MAINNET_BUILD: "0", VITE_DFX_NETWORK: "local", VITE_IOU_PROD_VETKD: "1",
    VITE_DFX_PORT: url.port, VITE_IC_URL: "", VITE_IOU_BACKEND_CANISTER_ID: canisterId,
    VITE_IOU_LAN_QC_II_ORIGIN: "", VITE_IOU_LAN_QC_OPENCHAT_ORIGIN: "", VITE_OPENCHAT_HOST: url.origin,
    IOU_LAN_QC_HTTPS_CERT_PATH: "", IOU_LAN_QC_HTTPS_KEY_PATH: "", IOU_LOCAL_APP_FRAME_ORIGINS: "",
    VITE_LOCAL_IMPORT_SENDER_ORIGIN: "http://127.0.0.1:4311",
  });
  const { createServer } = await import("vite");
  const server = await createServer({ root, configFile: resolve(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 4310, strictPort: true } });
  await server.listen();
  console.log(JSON.stringify({ frontend: "http://127.0.0.1:4310", gateway: url.origin, canisterId, productionCrypto: true, syntheticDevAuth: true }));
} else {
  throw new Error("Usage: account-vault-isolated.mjs install <loopback-gateway> <wasm> <sha256> | serve <loopback-gateway> <local-canister>");
}
