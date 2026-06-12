// Phase 2 + 3 + 4 smoke test: exercises the pair + sheet lifecycle,
// the entry round-trip (encrypted add -> list -> decrypt), and the
// list_archived_sheets endpoint.
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
  decryptEntryPayload,
  deriveUserKeypair,
  encryptEntryPayload,
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
  "uxrrr-q7777-77774-qaaaq-cai";
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

// Is this opt<T> value empty (None)? Handles null, undefined, and
// Candid None shapes (empty array for opt<T>).
function isEmptyOpt(v: unknown): boolean {
  if (v == null) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (Array.isArray(v) && v.length === 1) return false; // Some
  return false;
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

  // ─── 7c. PHASE 3: entry round-trip ───
  // The partner posts an encrypted entry. The tester fetches the
  // list, decrypts, and confirms the plaintext matches.
  console.log("\n=== add_entry (partner) — encrypted round-trip ===");
  const entryPayload = new TextEncoder().encode(JSON.stringify({
    kind: "expense",
    currency: "USD",
    amount_minor: 1250,        // $12.50
    direction: "debt",         // partner owes tester
    note: "lunch",
    ts: 1718000000000,
  }));
  const enc = await encryptEntryPayload(entryPayload, K_sheet);
  const entry = await (partner as any).add_entry({
    sheet_id: sheetId,
    entry_key: Array.from(enc.entryKey),
    ciphertext: Array.from(enc.ciphertext),
    iv: Array.from(enc.iv),
  });
  console.log("entry id:", entry.id, "by", entry.created_by.toText());
  ok(typeof entry.id === "bigint" || typeof entry.id === "number",
    "entry has numeric id");
  ok(entry.created_by.toText() === partnerIdentity.getPrincipal().toText(),
    "entry created_by is the partner");
  ok(entry.sheet_id === sheetId, "entry.sheet_id matches");
  ok(entry.pair_id === pairId, "entry.pair_id matches");
  ok(isEmptyOpt(entry.updated_at_server), "updated_at_server is empty on creation");
  ok(entry.entry_key.length === 32, "entry_key is 32 bytes");
  ok(entry.iv.length === 12, "iv is 12 bytes");
  ok(entry.ciphertext.length > 0, "ciphertext is non-empty");

  // list_entries as tester (should see the partner's entry).
  console.log("\n=== list_entries (tester) ===");
  const listRes = await (tester as any).list_entries(sheetId, [], 50);
  console.log("page size:", listRes.entries.length, "cursor:", listRes.next_cursor);
  ok(listRes.entries.length === 1, "tester sees 1 entry");
  ok(isEmptyOpt(listRes.next_cursor), "no next cursor on single page");

  // Tester decrypts using K_sheet and the entry_key.
  const fetched = listRes.entries[0];
  const decBytes = await decryptEntryPayload(
    new Uint8Array(fetched.entry_key),
    new Uint8Array(fetched.iv),
    new Uint8Array(fetched.ciphertext),
    K_sheet,
  );
  const dec = JSON.parse(new TextDecoder().decode(decBytes));
  console.log("decrypted:", dec);
  ok(dec.kind === "expense" && dec.currency === "USD" && dec.amount_minor === 1250,
    "decrypted payload matches");
  ok(dec.note === "lunch", "decrypted note matches");

  // get_entry convenience.
  console.log("\n=== get_entry (tester) ===");
  const oneEntry = unwrap(await (tester as any).get_entry(sheetId, entry.id));
  ok(oneEntry !== null, "get_entry returns the entry");
  ok(oneEntry.id === entry.id, "get_entry id matches");

  // edit_entry as partner (replace ciphertext).
  console.log("\n=== edit_entry (partner) ===");
  const updated = new TextEncoder().encode(JSON.stringify({
    kind: "expense",
    currency: "USD",
    amount_minor: 2000,
    direction: "debt",
    note: "lunch + coffee",
    ts: 1718000000000,
  }));
  const enc2 = await encryptEntryPayload(updated, K_sheet);
  const edited = await (partner as any).edit_entry({
    sheet_id: sheetId,
    entry_id: entry.id,
    entry_key: Array.from(enc2.entryKey),
    ciphertext: Array.from(enc2.ciphertext),
    iv: Array.from(enc2.iv),
  });
  ok(!isEmptyOpt(edited.updated_at_server), "updated_at_server is set after edit");
  const dec2Bytes = await decryptEntryPayload(
    new Uint8Array(edited.entry_key),
    new Uint8Array(edited.iv),
    new Uint8Array(edited.ciphertext),
    K_sheet,
  );
  const dec2 = JSON.parse(new TextDecoder().decode(dec2Bytes));
  ok(dec2.amount_minor === 2000 && dec2.note === "lunch + coffee",
    "decrypted edit matches the new payload");

  // edit_entry as tester (should be denied — tester is not the creator).
  console.log("\n=== edit_entry (tester, should trap) ===");
  let editDenied = false;
  try {
    const encT = await encryptEntryPayload(
      new TextEncoder().encode("evil edit"),
      K_sheet,
    );
    await (tester as any).edit_entry({
      sheet_id: sheetId,
      entry_id: entry.id,
      entry_key: Array.from(encT.entryKey),
      ciphertext: Array.from(encT.ciphertext),
      iv: Array.from(encT.iv),
    });
  } catch (e) {
    editDenied = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(editDenied, "tester cannot edit partner's entry");

  // add_entry as tester (should succeed — tester is a member).
  console.log("\n=== add_entry (tester) ===");
  const tEnc = await encryptEntryPayload(
    new TextEncoder().encode(JSON.stringify({
      kind: "expense", currency: "EGP", amount_minor: 50000,
      direction: "credit", note: "taxi", ts: 1718000001000,
    })),
    K_sheet,
  );
  const testerEntry = await (tester as any).add_entry({
    sheet_id: sheetId,
    entry_key: Array.from(tEnc.entryKey),
    ciphertext: Array.from(tEnc.ciphertext),
    iv: Array.from(tEnc.iv),
  });
  ok(testerEntry.id !== entry.id, "tester's entry has a different id");

  // Final list: should be 2 entries.
  const finalList = await (tester as any).list_entries(sheetId, [], 50);
  ok(finalList.entries.length === 2, "tester now sees 2 entries");
  // Newest first.
  ok(finalList.entries[0].id === testerEntry.id,
    "newest entry first");

  // Non-member cannot list.
  console.log("\n=== list_entries (default identity, should trap) ===");
  const { actor: defaultActor } = await actorFor("default");
  let nonMemberTrapped = false;
  try {
    await (defaultActor as any).list_entries(sheetId, [], 10);
  } catch (e) {
    nonMemberTrapped = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(nonMemberTrapped, "non-member list_entries traps");

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
  ok(!isEmptyOpt(closedSheet.closed_at), "closed_at is set");

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

  // ─── 11b. list_archived_sheets ───
  console.log("\n=== list_archived_sheets (tester) ===");
  const archived = await (tester as any).list_archived_sheets(pairId);
  console.log("archived count:", archived.length, "ids:",
    archived.map((a: any) => a.id));
  ok(Array.isArray(archived) && archived.length === 1, "1 archived sheet");
  ok(archived[0].id === sheetId, "archived id is the original sheet");
  ok(archived[0].state && "Closed" in archived[0].state,
    "archived sheet is Closed");
  ok(archived[0].closed_at != null && archived[0].closed_at !== undefined
    && (!Array.isArray(archived[0].closed_at) || archived[0].closed_at.length > 0),
    "archived sheet has closed_at");
  ok(archived[0].closing_balances != null
    && (!Array.isArray(archived[0].closing_balances) || archived[0].closing_balances.length >= 0),
    "archived sheet has closing_balances array");

  // Non-member cannot list archived sheets.
  console.log("\n=== list_archived_sheets (default identity, should trap) ===");
  const { actor: defaultActorForArchive } = await actorFor("default");
  let archiveTrapped = false;
  try {
    await (defaultActorForArchive as any).list_archived_sheets(pairId);
  } catch (e) {
    archiveTrapped = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(archiveTrapped, "non-member list_archived_sheets traps");

  // ─── 11c. PHASE 1.1.2: replace-member ───
  // Partner (leaving) signs an Ed25519 ReplaceRequest; tester
  // (staying) submits it. The pair becomes [tester, carol] and
  // the active sheet is closed.
  console.log("\n=== replace_member (tester submits partner's signed request) ===");
  const { ed25519: ed } = await import("@noble/curves/ed25519");
  // The "leaving" member's Ed25519 keypair is generated from
  // random bytes (in real life this is the user's stored key;
  // the canister only verifies the signature, not the
  // principal-to-pubkey relationship).
  const leavingSeed = new Uint8Array(32);
  (globalThis as any).crypto.getRandomValues(leavingSeed);
  const leavingPub = ed.getPublicKey(leavingSeed);
  // Pick a "carol" principal — use the default identity (it's
  // not a member of any pair, so the canister accepts it as the
  // new member).
  const carolIdentity = Secp256k1KeyIdentity.fromPem(
    readFileSync(`${process.env.HOME}/.config/dfx/identity/default/identity.pem`, "utf8"),
  );
  const carolPrincipal = carolIdentity.getPrincipal();
  const replaceReq = {
    pair_id: pairId,
    leaving_principal: partnerIdentity.getPrincipal().toText(),
    new_principal: carolPrincipal.toText(),
    ts_ms: BigInt(Date.now()),
    nonce: Array.from((globalThis as any).crypto.getRandomValues(new Uint8Array(32))),
  };
  // Canonical bytes (matches canonical_replace_bytes in lib.rs).
  const _enc = new TextEncoder();
  const carolBytes = carolPrincipal.toUint8Array();
  const partnerBytes = partnerIdentity.getPrincipal().toUint8Array();
  const canon: number[] = [];
  for (const c of "iou-replace-member-v1:") canon.push(c.charCodeAt(0));
  for (const c of replaceReq.pair_id) canon.push(c.charCodeAt(0));
  canon.push(0xff);
  for (const b of partnerBytes) canon.push(b);
  canon.push(0xff);
  for (const b of carolBytes) canon.push(b);
  canon.push(0xff);
  const ts = replaceReq.ts_ms;
  for (let i = 7; i >= 0; i--) canon.push(Number((ts >> BigInt(i * 8)) & 0xffn));
  canon.push(0xff);
  for (const b of replaceReq.nonce) canon.push(b);
  const sig = ed.sign(new Uint8Array(canon), leavingSeed);
  const signedReplace = {
    request: replaceReq,
    signature: Array.from(sig),
    signer_pubkey: Array.from(leavingPub),
  };
  // Tester (staying) submits.
  // The Candid layer wants Principal instances, not strings.
  const signedForCanister = {
    request: {
      pair_id: signedReplace.request.pair_id,
      leaving_principal: partnerIdentity.getPrincipal(),
      new_principal: carolPrincipal,
      ts_ms: BigInt(signedReplace.request.ts_ms),
      nonce: signedReplace.request.nonce,
    },
    signature: signedReplace.signature,
    signer_pubkey: signedReplace.signer_pubkey,
  };
  const updatedPair: any = await (tester as any).submit_replace_member(signedForCanister);
  console.log("updated pair members:", updatedPair.members.map((m: any) => m.toText()));
  ok(
    updatedPair.members.some((m: any) => m.toText() === testerIdentity.getPrincipal().toText()),
    "tester is still in the pair",
  );
  ok(
    updatedPair.members.some((m: any) => m.toText() === carolPrincipal.toText()),
    "carol is now in the pair",
  );
  ok(
    !updatedPair.members.some((m: any) => m.toText() === partnerIdentity.getPrincipal().toText()),
    "partner is no longer in the pair",
  );
  // Active sheet should be Closed now.
  const replacedSheet = unwrap(await (tester as any).get_sheet(newSheetId));
  ok(isClosed(replacedSheet.state), "active sheet is Closed after replace");
  ok(replacedSheet.member_a.toText() === testerIdentity.getPrincipal().toText()
    || replacedSheet.member_b.toText() === testerIdentity.getPrincipal().toText(),
    "tester still on the (now-Closed) sheet");

  // Non-staying-member cannot submit (default identity is not a member).
  console.log("\n=== replace_member (default identity, should trap) ===");
  const { actor: defaultActorForReplace } = await actorFor("default");
  let replaceTrapped = false;
  try {
    await (defaultActorForReplace as any).submit_replace_member(signedReplace);
  } catch (e) {
    replaceTrapped = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(replaceTrapped, "non-member submit_replace_member traps");

  // Bad signature should also trap.
  console.log("\n=== replace_member (bad signature, should trap) ===");
  const badSig = { ...signedReplace, signature: Array.from(new Uint8Array(64)) };
  let badSigTrapped = false;
  try {
    await (tester as any).submit_replace_member(badSig);
  } catch (e) {
    badSigTrapped = true;
    console.log("  trapped as expected:", (e as Error).message);
  }
  ok(badSigTrapped, "bad signature traps");

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
      ? "\n❌ Phase 2+3+4+1.1.2 smoke FAILED"
      : "\n✅ Phase 2+3+4+1.1.2 smoke PASSED",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
