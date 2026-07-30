// Solo-sheets regression smoke test (v1.4.0). Exercises the security
// guarantees the adversarial review required. Fresh in-process identities
// each run, so it's idempotent. Run with: pnpm smoke:solo
//
// Targets IOU's isolated local replica (port 40436 by default). Override
// with IOU_HOST / VITE_IOU_BACKEND_CANISTER_ID.

import { HttpAgent, Actor, AnonymousIdentity } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { webcrypto } from "node:crypto";
import { idlFactory } from "../src/backend/declarations";

if (!(globalThis as any).crypto) (globalThis as any).crypto = webcrypto;

const host = process.env.IOU_HOST || "http://127.0.0.1:40436";
const canisterId =
  process.env.VITE_IOU_BACKEND_CANISTER_ID || "uzt4z-lp777-77774-qaabq-cai";
const ANON = "2vxsx-fae";

async function actorFor(identity: any) {
  const agent = new HttpAgent({ identity, host });
  await agent.fetchRootKey();
  return Actor.createActor(idlFactory, { agent, canisterId }) as any;
}

function unwrap<T>(opt: T | T[] | null | undefined): T | null {
  if (opt == null) return null;
  if (Array.isArray(opt)) return (opt[0] as T) ?? null;
  return opt;
}

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.log(`  ❌ ${msg}`);
  }
}
async function expectTrap(msg: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    failed++;
    console.log(`  ❌ ${msg} (expected rejection, got success)`);
  } catch {
    passed++;
    console.log(`  ✅ ${msg}`);
  }
}

async function main() {
  const creatorId = Ed25519KeyIdentity.generate();
  const partnerId = Ed25519KeyIdentity.generate();
  const strangerId = Ed25519KeyIdentity.generate();
  const creator = await actorFor(creatorId);
  const partner = await actorFor(partnerId);
  const stranger = await actorFor(strangerId);
  const anon = await actorFor(new AnonymousIdentity());

  console.log("=== solo create ===");
  const cp = await creator.create_pair();
  const pairId = cp.pair_id;
  const sheet = await creator.create_sheet({
    pair_id: pairId,
    closing_window_days: 365,
    wrapped_key_a: [1, 2, 3, 4],
    wrapped_key_b: [],
    name_enc: [],
    name_iv: [],
  });
  const sheetId = sheet.id;
  ok(typeof sheetId === "string" && sheetId.length > 0, "create_sheet on a solo pair succeeds");
  ok(sheet.member_b.toText() === ANON, "solo sheet member_b is anonymous");

  console.log("\n=== (1) anonymous reads rejected ===");
  await expectTrap("anon get_sheet rejected", () => anon.get_sheet(sheetId));
  await expectTrap("anon get_pair rejected", () => anon.get_pair(pairId));
  await expectTrap("anon get_my_pairs rejected", () => anon.get_my_pairs());
  await expectTrap("anon list_entries rejected", () => anon.list_entries(sheetId, [], 50));

  console.log("\n=== (2) non-member reads rejected ===");
  ok(unwrap(await stranger.get_sheet(sheetId)) === null, "non-member get_sheet -> none");
  await expectTrap("non-member list_entries rejected", () => stranger.list_entries(sheetId, [], 50));

  console.log("\n=== (3) consent gate: joined partner has NO key access before grant ===");
  await partner.join_pair(cp.invite_code);
  await partner.register_sheet_pubkey([9, 9, 9, 9]);
  ok(
    unwrap(await partner.get_sheet_wrapped_key(sheetId)) === null,
    "partner get_sheet_wrapped_key -> none before grant",
  );
  await expectTrap(
    "partner vetkd_wrap_sheet_key rejected before grant",
    () => partner.vetkd_wrap_sheet_key(sheetId, new Array(48).fill(1)),
  );
  // v1.4.0: the read path is gated per-sheet too — a joined-but-ungranted
  // partner must not get the entries' ciphertext/metadata for a solo sheet.
  await expectTrap(
    "partner list_entries rejected before grant (solo consent gate)",
    () => partner.list_entries(sheetId, [], 50),
  );
  ok(
    unwrap(await partner.get_entry(sheetId, 0n)) === null,
    "partner get_entry -> none before grant",
  );
  // The write path is gated per-sheet too. Use valid-shaped fields (32-byte
  // key, non-empty ciphertext/iv) so the trap comes from the consent gate,
  // not the field validations that run before it.
  await expectTrap(
    "partner add_entry rejected before grant (solo consent gate)",
    () =>
      partner.add_entry({
        sheet_id: sheetId,
        entry_key: new Array(32).fill(1),
        ciphertext: [1, 2, 3],
        iv: [1, 2, 3],
      }),
  );

  console.log("\n=== (4) grant guards ===");
  await expectTrap("non-owner (partner) grant rejected", () =>
    partner.grant_partner_access(pairId, partnerId.getPrincipal(), [
      { sheet_id: sheetId, wrapped_key_for_partner: [] },
    ]),
  );
  await expectTrap("grant with wrong expected_partner rejected", () =>
    creator.grant_partner_access(pairId, strangerId.getPrincipal(), [
      { sheet_id: sheetId, wrapped_key_for_partner: [] },
    ]),
  );

  console.log("\n=== (5) valid grant + access ===");
  const n = await creator.grant_partner_access(pairId, partnerId.getPrincipal(), [
    { sheet_id: sheetId, wrapped_key_for_partner: [7, 7, 7] },
  ]);
  ok(Number(n) === 1, "grant_partner_access grants 1 sheet");
  const got = unwrap(await partner.get_sheet_wrapped_key(sheetId)) as number[] | null;
  ok(!!got && got.length === 3 && got[0] === 7, "partner can fetch wrapped_key_b after grant");
  const afterGrant = await partner.list_entries(sheetId, [], 50);
  ok(Array.isArray(afterGrant.entries), "partner can list_entries after grant");
  const written = await partner.add_entry({
    sheet_id: sheetId,
    entry_key: new Array(32).fill(1),
    ciphertext: [1, 2, 3],
    iv: [1, 2, 3],
  });
  ok(written && typeof written.id !== "undefined", "partner can add_entry after grant");
  await expectTrap("re-grant rejected (member_b already set)", () =>
    creator.grant_partner_access(pairId, partnerId.getPrincipal(), [
      { sheet_id: sheetId, wrapped_key_for_partner: [] },
    ]),
  );

  console.log("\n=== (5b) encrypted names (set_pair/sheet/member_name) ===");
  // The canister only stores/serves the blobs; use fake ciphertext bytes.
  const nameEnc = (b: number) => new Array(16).fill(b);
  const nameIv = new Array(12).fill(9);
  await creator.set_pair_name(pairId, nameEnc(1), nameIv);
  await creator.set_sheet_name(sheetId, nameEnc(2), nameIv);
  await creator.set_member_name(pairId, nameEnc(3), nameIv);
  await partner.set_member_name(pairId, nameEnc(4), nameIv);
  const pairAfter = unwrap(await creator.get_pair(pairId)) as any;
  ok((unwrap(pairAfter.name_enc) as any)?.[0] === 1, "set_pair_name stored on pair");
  ok((unwrap(pairAfter.member_a_name_enc) as any)?.[0] === 3, "creator name in member_a slot");
  ok((unwrap(pairAfter.member_b_name_enc) as any)?.[0] === 4, "partner name in member_b slot");
  const sheetAfter = unwrap(await creator.get_sheet(sheetId)) as any;
  ok((unwrap(sheetAfter.name_enc) as any)?.[0] === 2, "set_sheet_name stored on sheet");
  const sums = (await partner.get_my_pairs()) as any[];
  const sum = sums.find((s) => s.id === pairId);
  ok((unwrap(sum?.other_name_enc) as any)?.[0] === 3, "partner sees creator's name (other_name_enc)");
  await expectTrap("non-member set_pair_name rejected", () =>
    stranger.set_pair_name(pairId, nameEnc(5), nameIv),
  );

  console.log("\n=== (5c) edit history + soft delete ===");
  const eid = written.id; // entry created by partner above
  const findEntry = async (a: any) =>
    (await a.list_entries(sheetId, [], 50)).entries.find((e: any) => e.id === eid);
  await partner.edit_entry({
    sheet_id: sheetId,
    entry_id: eid,
    entry_key: new Array(32).fill(2),
    ciphertext: [4, 5, 6],
    iv: [7, 8, 9],
  });
  const afterEdit = await findEntry(partner);
  ok((unwrap(afterEdit.history) as any[])?.length === 1, "edit pushes one history version");
  ok(unwrap(afterEdit.updated_at_server) != null, "updated_at_server set after edit");
  ok(
    ((unwrap(afterEdit.history) as any[])?.[0]?.ciphertext as number[])?.[0] === 1,
    "history version keeps the prior ciphertext",
  );
  await partner.delete_entry(sheetId, eid);
  ok(unwrap((await findEntry(partner)).deleted_at) != null, "delete sets deleted_at");
  await expectTrap("cannot edit a deleted entry", () =>
    partner.edit_entry({
      sheet_id: sheetId,
      entry_id: eid,
      entry_key: new Array(32).fill(3),
      ciphertext: [9],
      iv: [9],
    }),
  );
  await expectTrap("non-creator member cannot delete entry", () =>
    creator.delete_entry(sheetId, eid),
  );
  await partner.restore_entry(sheetId, eid);
  ok(unwrap((await findEntry(partner)).deleted_at) == null, "restore clears deleted_at");

  console.log("\n=== (6) replace-member rejects solo / anonymous ===");
  const cp2 = await stranger.create_pair(); // stranger isn't paired yet
  await expectTrap("replace on a solo pair rejected", () =>
    stranger.submit_replace_member({
      request: {
        pair_id: cp2.pair_id,
        leaving_principal: strangerId.getPrincipal(),
        new_principal: creatorId.getPrincipal(),
        ts_ms: BigInt(Date.now()),
        nonce: new Array(32).fill(1),
      },
      signature: new Array(64).fill(0),
      signer_pubkey: new Array(32).fill(0),
    }),
  );

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
