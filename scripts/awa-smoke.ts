// Manual integration test: signs in with the "tester" identity, calls
// the canister exactly the way the PWA does.
//
// Run with: pnpm smoke
//
// (Uses tsx so we can import the .ts declarations stub directly.)

import { HttpAgent, Actor } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { readFileSync } from "node:fs";

import { idlFactory } from "../src/backend/declarations";

const identityName = process.env.IOU_IDENTITY || "tester";
const network = process.env.IOU_NETWORK || "local";
const canisterId =
  process.env.VITE_IOU_BACKEND_CANISTER_ID ||
  "bkyz2-fmaaa-aaaaa-qaaaq-cai";

const host = network === "local" ? "http://127.0.0.1:4943" : "https://icp-api.io";

const pemPath = `${process.env.HOME}/.config/dfx/identity/${identityName}/identity.pem`;
const pem = readFileSync(pemPath, "utf8");
const identity = Secp256k1KeyIdentity.fromPem(pem);

const agent = new HttpAgent({ identity, host });
if (network === "local") {
  await agent.fetchRootKey();
}

const actor = Actor.createActor(idlFactory, { agent, canisterId });
console.log("=== connecting ===");
console.log("identity:", identity.getPrincipal().toText());
console.log("canister:", canisterId);

console.log("\n=== whoami ===");
const who = await actor.whoami();
console.log("who:", JSON.stringify(who));

// Use a unique value per run so we don't get tripped up by state from
// a prior test (BTreeMap dedup is by principal; same principal +
// different value just overwrites).
const runId = Date.now().toString(36);
const name = `alice-${runId}`;
const iv = `iv-${runId}`;

console.log("\n=== set_display_name ===");
const rec = await actor.set_display_name(
  Array.from(new TextEncoder().encode(name)),
  Array.from(new TextEncoder().encode(iv)),
);
console.log("rec keys:", Object.keys(rec));

console.log("\n=== get_my_user (after set) ===");
const after = await actor.get_my_user();
console.log("after type:", Array.isArray(after) ? "array" : typeof after);
if (Array.isArray(after)) {
  console.log("after[0] keys:", Object.keys(after[0] ?? {}));
}

console.log("\n=== assertions ===");
// In the hand-written stub, opt<T> decodes as either null or [T].
// (After `dfx generate` replaces the stub, the real generated binding
//  uses `T | null` directly.)
const afterRec = Array.isArray(after) ? after[0] : after;
const ok =
  who !== null &&
  who !== undefined &&
  afterRec !== null &&
  afterRec !== undefined &&
  afterRec.user_principal.toText() === identity.getPrincipal().toText() &&
  new TextDecoder().decode(new Uint8Array(afterRec.wrapped_display_name)) === name;
console.log(ok ? "✅ PASS" : "❌ FAIL");
process.exit(ok ? 0 : 1);
