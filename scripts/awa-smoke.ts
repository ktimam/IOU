// Phase 2 smoke test: exercises the pair + sheet lifecycle end-to-end.
// Run with: pnpm smoke
//
// IMPORTANT: This test expects a clean canister. If state from a
// previous run is still there (tester already has a pair), the
// test will trap on create_pair. To reset:
//   dfx canister uninstall-code iou_backend
//   dfx deploy iou_backend

import { HttpAgent, Actor } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { idlFactory } from "../src/backend/declarations";
import {
  deriveUserKeypair,
  newSheetKey,
  unwrapSheetKey,
  wrapSheetKey,
} from "../src/features/crypto/devVetkd";

// Node polyfill for WebCrypto (and the localStorage shim is implicit:
// devVetkd's localStorage access is guarded with try/catch so it
// just no-ops in Node, and we pass the keypair directly via the
// exported API).
if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const network = process.env.IOU_NETWORK || "local";
const canisterId =
  process.env.VITE_IOU_BACKEND_CANISTER_ID ||
  "bkyz2-fmaaa-aaaaa-qaaaq-cai";
const host = network === "local" ? "http://127.0.0.1:4943" : "https://icp-api.io";

function loadIdentity(name: string) {
  const pemPath = `${process.env.HOME}/.config/dfx/identity/${name}/identity.pem`;
  const pem = readFileSync(pemPath, "utf8");
  return Secp256k1KeyIdentity.fromPem(pem);
}

async function actorFor(name: string) {
  const identity = loadIdentity(name);
  const agent = new HttpAgent({ identity, host });
  if (network === "local") await agent.fetchRootKey();
  return { identity, actor: Actor.createActor(idlFactory, { agent, canisterId }) };
}

// In the hand-written stub, opt<T> decodes as T | null sometimes and
// [T] other times (Candid variant). We treat both shapes uniformly.
function unwrap<T>(opt: T | T[] | null | undefined): T | null {
  if (opt == null) return null;
  if (Array.isArray(opt)) return (opt as T[])[0] ?? null;
  return opt;
}

// Variants come back as objects { VariantName: null | payload }
function isActive(state: any): boolean {
  return state && typeof state === "object" && "Active" in state;
}
function isClosed(state: any): boolean {
  return state && typeof state === "object" && "Closed" in state;
}

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

function ok(cond: boolean, msg: string) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
  } else {
    console.log(`  ❌ ${msg}`);
    process.exitCode = 1;
  }
}

async function main() {
  console.log("=== connecting ===");
  const { identity: testerIdentity, actor: tester } = await actorFor("tester");
  const { identity: partnerIdentity, actor: partner } = await actorFor("partner");
  console.log("tester: ", testerIdentity.getPrincipal().toText());
  console.log("partner:", partnerIdentity.getPrincipal().toText());

  // ─── 1. create_pair as tester ───
  console.log("\n=== create_pair (tester) ===");
  // The canister traps if the caller is already in an active pair.
  // To make the test idempotent, run scripts/build-backend.sh or
  // `dfx canister uninstall-code iou_backend && dfx deploy iou_backend`
  // before this test.
  const created = await (tester as any).create_pair();
  console.log(created);
  const pairId = created.pair_id;
  const inviteCode = created.invite_code;
  ok(typeof pairId === "string" && pairId.length > 0, "create_pair returns pair_id");
  ok(typeof inviteCode === "string" && inviteCode.length > 0, "create_pair returns invite_code");

  // ─── 2. get_my_pairs as tester (1 pair) ───
  console.log("\n=== get_my_pairs (tester) ===");
  const testerPairsBefore = await (tester as any).get_my_pairs();
  console.log(testerPairsBefore);
  ok(Array.isArray(testerPairsBefore) && testerPairsBefore.length === 1, "tester has 1 pair");

  // ─── 3. join_pair as partner ───
  console.log("\n=== join_pair (partner) ===");
  const joinedPairId = await (partner as any).join_pair(inviteCode);
  console.log("joined pair:", joinedPairId);
  ok(joinedPairId === pairId, "join_pair returns the same pair_id");

  // ─── 4. get_my_pairs as partner (1 pair, other is tester) ───
  console.log("\n=== get_my_pairs (partner) ===");
  const partnerPairs = await (partner as any).get_my_pairs();
  console.log(partnerPairs);
  ok(partnerPairs.length === 1, "partner has 1 pair");
  ok(
    partnerPairs[0].other_principal.toText() ===
      testerIdentity.getPrincipal().toText(),
    "partner sees tester as the other",
  );

  // ─── 5. get_pair as partner ───
  console.log("\n=== get_pair (partner) ===");
  const pair = unwrap(await (partner as any).get_pair(pairId));
  console.log(pair);
  ok(pair !== null, "get_pair returns the pair");
  ok(pair.members.length === 2, "pair has 2 members");
  ok(
    pair.members[1].toText() === partnerIdentity.getPrincipal().toText(),
    "partner is member[1]",
  );

  // ─── 6. create_sheet as partner (with real crypto wrap) ───
  console.log("\n=== create_sheet (partner) — with devVetkd wrap ===");
  // In v1 dev: each principal has a P-256 keypair persisted in
  // localStorage. The partner (sheet creator) generates K_sheet
  // and wraps it for each member using the member's public key.
  // The store as a side effect: devVetkd uses localStorage in the
  // browser; in Node, that no-ops, so we pass the keypair directly
  // by reading the dev secret deterministically.
  const partnerKp = await deriveUserKeypair(partnerIdentity.getPrincipal().toText());
  const testerKp = await deriveUserKeypair(testerIdentity.getPrincipal().toText());
  const K_sheet = newSheetKey();
  const K_sheet_hex = bytesToHex(K_sheet);
  // Partner wraps for both members using its own private key.
  const wrappedKeyA = await wrapSheetKey(K_sheet, testerKp.publicKey, partnerKp.privateKey);
  const wrappedKeyB = await wrapSheetKey(K_sheet, partnerKp.publicKey, partnerKp.privateKey);
  const sheetReq = {
    pair_id: pairId,
    enabled_currencies: ["USD", "EGP"],
    closing_window_days: 365,
    wrapped_key_a: Array.from(wrappedKeyA),
    wrapped_key_b: Array.from(wrappedKeyB),
  };
  const sheet = await (partner as any).create_sheet(sheetReq);
  console.log("sheet id:", sheet.id);
  const sheetId = sheet.id;
  ok(sheet.pair_id === pairId, "sheet belongs to the pair");
  ok(isActive(sheet.state), "sheet is Active");

  // ─── 7. get_sheet_wrapped_key as tester (should return wrapA) ───
  console.log("\n=== get_sheet_wrapped_key (tester) ===");
  const wrappedA = unwrap(await (tester as any).get_sheet_wrapped_key(sheetId));
  if (!wrappedA) {
    ok(false, "tester receives a wrapped blob");
  } else {
    // Tester unwraps using the partner's PUBLIC KEY (because partner
    // was the wrap-sender) and its own private key.
    const unwrappedTester = await unwrapSheetKey(
      new Uint8Array(wrappedA),
      testerKp.privateKey,
      partnerKp.publicKey,
    );
    ok(
      bytesToHex(unwrappedTester) === K_sheet_hex,
      "tester unwraps to the original K_sheet",
    );
  }

  // ─── 7b. partner also unwraps its own copy ───
  console.log("\n=== get_sheet_wrapped_key (partner) ===");
  const wrappedB = unwrap(await (partner as any).get_sheet_wrapped_key(sheetId));
  if (!wrappedB) {
    ok(false, "partner receives a wrapped blob");
  } else {
    const unwrappedPartner = await unwrapSheetKey(
      new Uint8Array(wrappedB),
      partnerKp.privateKey,
      partnerKp.publicKey,
    );
    ok(
      bytesToHex(unwrappedPartner) === K_sheet_hex,
      "partner unwraps to the same K_sheet",
    );
  }

  // ─── 8. add_currency as tester ───
  console.log("\n=== add_currency (tester) ===");
  await (tester as any).add_currency(sheetId, "EUR");
  const sheetAfter = unwrap(await (tester as any).get_sheet(sheetId));
  console.log("currencies:", sheetAfter.enabled_currencies);
  ok(sheetAfter.enabled_currencies.includes("EUR"), "EUR is enabled");

  // ─── 9. close_sheet as partner ───
  console.log("\n=== close_sheet (partner) ===");
  await (partner as any).close_sheet(sheetId, []);
  const closedSheet = unwrap(await (tester as any).get_sheet(sheetId));
  console.log("state:", closedSheet.state);
  ok(isClosed(closedSheet.state), "sheet is Closed");
  ok(closedSheet.closed_at !== null && closedSheet.closed_at !== undefined,
    "closed_at is set");

  // ─── 10. start_new_sheet ───
  console.log("\n=== start_new_sheet (tester) ===");
  const newSheet = await (tester as any).start_new_sheet({
    pair_id: pairId,
    enabled_currencies: ["USD"],
    closing_window_days: 365,
    wrapped_key_a: Array.from(new TextEncoder().encode("wrapA-fake-002")),
    wrapped_key_b: Array.from(new TextEncoder().encode("wrapB-fake-002")),
  });
  console.log("new sheet id:", newSheet.id);
  ok(isActive(newSheet.state), "new sheet is Active");

  // ─── 11. final get_my_pairs ───
  console.log("\n=== final get_my_pairs (tester) ===");
  const finalPairs = await (tester as any).get_my_pairs();
  console.log(finalPairs);
  ok(finalPairs.length === 1, "tester still has 1 pair");
  const newSheetId = unwrap(finalPairs[0].active_sheet_id);
  ok(newSheetId === newSheet.id, "active sheet is the new one");
  ok(finalPairs[0].archived_sheet_count === 1, "1 archived sheet");

  // ─── 12. invalid invite code ───
  console.log("\n=== invalid invite code (should trap) ===");
  let trapped = false;
  try {
    await (tester as any).join_pair("XXXX-XXXX");
  } catch (e) {
    trapped = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(trapped, "invalid invite traps");

  // ─── 13. anonymous is rejected ───
  console.log("\n=== anonymous is rejected ===");
  const agent = new HttpAgent({ host });
  if (network === "local") await agent.fetchRootKey();
  const anonActor = Actor.createActor(idlFactory, { agent, canisterId });
  let anonTrapped = false;
  try {
    await (anonActor as any).create_pair();
  } catch (e) {
    anonTrapped = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(anonTrapped, "anonymous create_pair traps");

  console.log(
    process.exitCode === 1
      ? "\n❌ Phase 2 smoke FAILED"
      : "\n✅ Phase 2 smoke PASSED",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
