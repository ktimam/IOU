/** Local-only compatibility test. Always creates its own fresh canister; never loads credentials. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { Actor, HttpAgent } from "@dfinity/agent";
import { Secp256k1KeyIdentity } from "@dfinity/identity-secp256k1";
import { IDL } from "@dfinity/candid";
import { Principal } from "@dfinity/principal";
import { idlFactory } from "../../src/backend/declarations";
import { newTransportKey, unwrapSheetKeyProd, deriveConsumerWrapKeyProd } from "../../src/features/crypto/prodVetkd";
import { encryptEntryPayload, decryptEntryPayload, encryptWithSheetKey, decryptWithSheetKey } from "../../src/features/crypto/devVetkd";
import {
  createAccountVaultPayload, encodeAccountVault, decodeAccountVault, openAccountVaultKeypair,
  createSheetKeyEnvelope, openSheetKeyEnvelope, vaultUnb64, createSheetKeyId,
  createAccountRecoveryCode, createRecoveryBackup, openRecoveryBackup,
} from "../../src/features/crypto/accountVaultCrypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const [gateway, oldPath, oldHash, newPath, newHash] = process.argv.slice(2);
if (!gateway || !oldPath || !oldHash || !newPath || !newHash) {
  throw new Error("Usage: tsx scripts/live/account-vault-upgrade.ts <http://127.0.0.1:port> <old.wasm> <old-sha256> <new.wasm> <new-sha256>");
}
const url = new URL(gateway);
if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
  throw new Error("Only an explicit isolated loopback gateway is permitted");
}
function pinnedWasm(path: string, expected: string): Uint8Array {
  assert.match(expected, /^[a-f0-9]{64}$/i, "Both artifact hashes must be explicit");
  const wasm = readFileSync(path);
  assert.equal(createHash("sha256").update(wasm).digest("hex"), expected.toLowerCase(), "Artifact changed after review");
  return wasm;
}
const oldWasm = pinnedWasm(oldPath, oldHash);
const newWasm = pinnedWasm(newPath, newHash);
const identity = Secp256k1KeyIdentity.generate(); // Synthetic; kept in memory, never serialized.
const principal = identity.getPrincipal();
const agent = new HttpAgent({ host: url.origin, identity });
await agent.fetchRootKey();
const management: any = Actor.createActor(({ IDL }) => IDL.Service({
  provisional_create_canister_with_cycles: IDL.Func([IDL.Record({
    amount: IDL.Opt(IDL.Nat), settings: IDL.Opt(IDL.Record({
      controllers: IDL.Opt(IDL.Vec(IDL.Principal)), compute_allocation: IDL.Opt(IDL.Nat),
      memory_allocation: IDL.Opt(IDL.Nat), freezing_threshold: IDL.Opt(IDL.Nat),
    })), specified_id: IDL.Opt(IDL.Principal), sender_canister_version: IDL.Opt(IDL.Nat64),
  })], [IDL.Record({ canister_id: IDL.Principal })], []),
  install_code: IDL.Func([IDL.Record({
    mode: IDL.Variant({ install: IDL.Null, upgrade: IDL.Opt(IDL.Record({
      skip_pre_upgrade: IDL.Opt(IDL.Bool),
      wasm_memory_persistence: IDL.Opt(IDL.Variant({ keep: IDL.Null, replace: IDL.Null })),
    })) }), canister_id: IDL.Principal, wasm_module: IDL.Vec(IDL.Nat8),
    arg: IDL.Vec(IDL.Nat8), sender_canister_version: IDL.Opt(IDL.Nat64),
  })], [], []),
}), {
  agent, canisterId: "aaaaa-aa",
  effectiveCanisterId: Principal.fromUint8Array(Buffer.from("///////QAAABAQ==", "base64")),
  callTransform: (_method, args: any[]) => args[0]?.canister_id ? { effectiveCanisterId: args[0].canister_id } : {},
});
const { canister_id: canisterId } = await management.provisional_create_canister_with_cycles({
  amount: [1_000_000_000_000_000n], specified_id: [], sender_canister_version: [],
  settings: [{ controllers: [[principal]], compute_allocation: [], memory_allocation: [], freezing_threshold: [] }],
});
const install = (wasm: Uint8Array, upgrade = false) => management.install_code({
  mode: upgrade ? { upgrade: [] } : { install: null }, canister_id: canisterId,
  wasm_module: wasm, arg: new Uint8Array(IDL.encode([], [])), sender_canister_version: [],
});
const actor: any = Actor.createActor(idlFactory, { agent, canisterId });
const utf8 = new TextEncoder();
const text = new TextDecoder();
const bytes = (value: ArrayLike<number>) => new Uint8Array(value);
const ok = (result: any) => { assert.ok("Ok" in result, "Expected successful result: " + (result.Err ?? "")); return result.Ok; };
const progress = (stage: string) => console.log(JSON.stringify({ stage, canisterId: canisterId.toText() }));
let derivationRequests = 0;
await install(oldWasm);
assert.equal(await actor.get_vetkd_key_name(), "dfx_test_key");
const publicKey = bytes(await actor.vetkd_public_key());
assert.equal(publicKey.length, 96);
progress("old-wasm-installed");

// Seed actual legacy production-crypto formats, not the unrelated DEV random-key simulation.
const transport = newTransportKey();
derivationRequests++;
const oldRoot = await deriveConsumerWrapKeyProd(principal.toText(), transport, publicKey,
  bytes(await actor.vetkd_wrap_consumer_key(transport.publicKey)));
const pair = await actor.create_pair();
const oldSheet = await actor.create_sheet({ pair_id: pair.pair_id, closing_window_days: 30,
  wrapped_key_a: transport.publicKey, wrapped_key_b: [], name_enc: [], name_iv: [] });
derivationRequests++;
const oldSheetKey = await unwrapSheetKeyProd(oldSheet.id, transport, publicKey,
  bytes(await actor.vetkd_wrap_sheet_key(oldSheet.id, transport.publicKey)), canisterId.toUint8Array());
const profilePlaintext = "Upgrade test profile";
const profile = await encryptWithSheetKey(oldRoot, utf8.encode(profilePlaintext));
await actor.set_display_name(profile.ciphertext, profile.iv);
const sheetNamePlaintext = "Preserved legacy sheet";
const sheetName = await encryptWithSheetKey(oldSheetKey, utf8.encode(sheetNamePlaintext));
await actor.set_sheet_name(oldSheet.id, sheetName.ciphertext, sheetName.iv);
const firstPlaintext = JSON.stringify({ amount: 17, currency: "USD", note: "legacy initial version" });
const first = await encryptEntryPayload(utf8.encode(firstPlaintext), oldSheetKey);
const entry = await actor.add_entry({ sheet_id: oldSheet.id, entry_key: first.entryKey, iv: first.iv, ciphertext: first.ciphertext });
const currentPlaintext = JSON.stringify({ amount: 23, currency: "USD", note: "legacy edited version" });
const current = await encryptEntryPayload(utf8.encode(currentPlaintext), oldSheetKey);
await actor.edit_entry({ sheet_id: oldSheet.id, entry_id: entry.id,
  entry_key: current.entryKey, iv: current.iv, ciphertext: current.ciphertext });
const consumerPair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const consumerStored = { privateKeyJwk: await crypto.subtle.exportKey("jwk", consumerPair.privateKey),
  publicKeySpkiB64: Buffer.from(await crypto.subtle.exportKey("spki", consumerPair.publicKey)).toString("base64") };
const consumerPem = "-----BEGIN PUBLIC KEY-----\n" + consumerStored.publicKeySpkiB64 + "\n-----END PUBLIC KEY-----";
async function consumerAes(root: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bytes(root), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: utf8.encode("iou-consumer-wrap-v1"),
    info: utf8.encode("iou-consumer-keypair-v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
const consumerIv = crypto.getRandomValues(new Uint8Array(12));
const consumerCiphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: consumerIv, tagLength: 128 },
  await consumerAes(oldRoot), utf8.encode(JSON.stringify(consumerStored))));
const consumerWrapped = new Uint8Array(12 + consumerCiphertext.length);
consumerWrapped.set(consumerIv); consumerWrapped.set(consumerCiphertext, 12);
assert.equal(ok(await actor.set_consumer_keypair(0n, consumerWrapped, consumerPem)), 1n);
const before = { user: await actor.get_my_user(), sheet: await actor.get_sheet(oldSheet.id),
  entry: await actor.get_entry(oldSheet.id, entry.id), consumer: await actor.get_consumer_keypair(), pair: await actor.get_pair(pair.pair_id) };
progress("legacy-vetkd-data-seeded");

await install(newWasm, true);
assert.equal(await actor.get_vetkd_key_name(), "dfx_test_key", "Upgrade must retain stored key name");
assert.deepEqual(bytes(await actor.vetkd_public_key()), publicKey);
assert.deepEqual(await actor.get_my_user(), before.user);
assert.deepEqual(await actor.get_sheet(oldSheet.id), before.sheet);
assert.deepEqual(await actor.get_entry(oldSheet.id, entry.id), before.entry);
assert.deepEqual(await actor.get_consumer_keypair(), before.consumer);
assert.deepEqual(await actor.get_pair(pair.pair_id), before.pair);
assert.deepEqual(ok(await actor.get_sheet_key_info(oldSheet.id)), { scheme: "vetkd-v1", key_id: oldSheet.id });
assert.deepEqual(await actor.get_account_vault(), []);
progress("schema19-to20-stable-records-preserved");

// Explicit paid bootstrap is allowed for an existing legacy consumer; its material must be identical.
const newTransport = newTransportKey();
const requestId = `${Date.now()}_${randomUUID()}`;
derivationRequests++;
const rootReply = bytes(ok(await actor.acquire_account_root(requestId, newTransport.publicKey, false)));
const newRoot = await deriveConsumerWrapKeyProd(principal.toText(), newTransport, publicKey, rootReply);
assert.deepEqual(newRoot, oldRoot, "Vault root must preserve profile/inbox compatibility");
assert.deepEqual(bytes(ok(await actor.acquire_account_root(requestId, newTransport.publicKey, false))), rootReply);
assert.ok("Err" in await actor.acquire_account_root(requestId, newTransportKey().publicKey, false), "Transport pin must survive replay");
assert.ok("Err" in await actor.acquire_account_root(`${Date.now() + 1}_${randomUUID()}`, newTransport.publicKey, true), "No second paid dispatch inside 24 hours");
await assert.rejects(() => actor.vetkd_wrap_consumer_key(newTransport.publicKey), /explicit|vault|root|acquir/i);
derivationRequests++;
const recoveredSheetKey = await unwrapSheetKeyProd(oldSheet.id, newTransport, publicKey,
  bytes(await actor.vetkd_wrap_sheet_key(oldSheet.id, newTransport.publicKey)), canisterId.toUint8Array());
assert.deepEqual(recoveredSheetKey, oldSheetKey, "Legacy sheet derivation domain must not change");
const scope = { principal: principal.toText(), canisterId: canisterId.toText(), host: url.origin };
const payload = await createAccountVaultPayload(newRoot, scope);
const recoveryCode = createAccountRecoveryCode();
payload.recovery = await createRecoveryBackup(newRoot, scope, recoveryCode);
assert.equal(ok(await actor.set_account_vault(0n, encodeAccountVault(payload))), 1n);
ok(await actor.register_account_wrapping_key(1n, payload.sheetKey.keyId, vaultUnb64(payload.sheetKey.publicKeyB64)));
const context = { version: 1 as const, pairId: pair.pair_id, keyId: oldSheet.id,
  recipientPrincipal: principal.toText(), recipientKeyId: payload.sheetKey.keyId };
const envelope = await createSheetKeyEnvelope(recoveredSheetKey, payload.sheetKey.publicKeyB64, context);
ok(await actor.set_sheet_wrapped_key(oldSheet.id, oldSheet.id, utf8.encode(envelope)));
assert.deepEqual(ok(await actor.get_sheet_key_info(oldSheet.id)), { scheme: "vetkd-v1", key_id: oldSheet.id });
assert.deepEqual(await actor.get_entry(oldSheet.id, entry.id), before.entry, "Migration must not rewrite entries/history");
assert.deepEqual(await actor.get_my_user(), before.user, "Migration must not rewrite profile");
assert.deepEqual(await actor.get_consumer_keypair(), before.consumer, "Migration must not rotate the delivery key");
progress("explicit-root-and-sheet-migration-preserved-keys");

// A second real upgrade verifies new stable regions and idempotent receipts too.
await install(newWasm, true);
assert.deepEqual(bytes(ok(await actor.acquire_account_root(requestId, newTransport.publicKey, false))), rootReply);
const storedVault = (await actor.get_account_vault())[0];
assert.equal(storedVault.revision, 1n);
assert.ok("Err" in await actor.set_account_vault(0n, encodeAccountVault(payload)), "CAS rejects a stale writer after upgrade");
const reopenedPayload = decodeAccountVault(storedVault.payload, scope);
const restoredRoot = await openRecoveryBackup(reopenedPayload.recovery!, scope, recoveryCode);
assert.deepEqual(restoredRoot, oldRoot);
const wrapping = await openAccountVaultKeypair(reopenedPayload, restoredRoot, scope);
assert.equal((await actor.get_account_wrapping_key(principal))[0].key_id, wrapping.keyId);
const storedEnvelope = text.decode(bytes((await actor.get_sheet_wrapped_key(oldSheet.id))[0]));
const localSheetKey = await openSheetKeyEnvelope(storedEnvelope, wrapping.privateKey, context);
assert.deepEqual(localSheetKey, oldSheetKey);
const user = (await actor.get_my_user())[0];
assert.equal(text.decode(await decryptWithSheetKey(restoredRoot, bytes(user.display_name_iv), bytes(user.wrapped_display_name))), profilePlaintext);
const sheet = (await actor.get_sheet(oldSheet.id))[0];
assert.equal(text.decode(await decryptWithSheetKey(localSheetKey, bytes(sheet.name_iv[0]), bytes(sheet.name_enc[0]))), sheetNamePlaintext);
const storedEntry = (await actor.get_entry(oldSheet.id, entry.id))[0];
assert.equal(text.decode(await decryptEntryPayload(bytes(storedEntry.entry_key), bytes(storedEntry.iv), bytes(storedEntry.ciphertext), localSheetKey)), currentPlaintext);
assert.equal(storedEntry.history[0].length, 1);
const prior = storedEntry.history[0][0];
assert.equal(text.decode(await decryptEntryPayload(bytes(prior.entry_key), bytes(prior.iv), bytes(prior.ciphertext), localSheetKey)), firstPlaintext);
const consumer = await actor.get_consumer_keypair();
assert.equal(consumer.mutation_epoch, 1n);
assert.equal(consumer.keypair[0].public_key_pem, consumerPem);
const persistedConsumer = bytes(consumer.keypair[0].wrapped_private_key);
const openedConsumer = JSON.parse(text.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: persistedConsumer.slice(0, 12), tagLength: 128 },
  await consumerAes(restoredRoot), persistedConsumer.slice(12))));
assert.deepEqual(openedConsumer, consumerStored, "Old OpenChat private and public delivery key must remain identical");
progress("new-stable-state-and-offline-recovery-preserved");

// Newly generated sheets have explicit metadata and cannot fall back to a different VetKD key.
const newPair = await actor.create_pair();
const randomKeyId = createSheetKeyId();
const randomKey = crypto.getRandomValues(new Uint8Array(32));
const randomContext = { ...context, pairId: newPair.pair_id, keyId: randomKeyId };
const randomEnvelope = await createSheetKeyEnvelope(randomKey, wrapping.publicKeyB64, randomContext);
const createRequest = { pair_id: newPair.pair_id, closing_window_days: 30, key_id: randomKeyId,
  wrapped_key_a: utf8.encode(randomEnvelope), wrapped_key_b: [], name_enc: [], name_iv: [] };
const randomSheet = ok(await actor.create_sheet_v2(createRequest));
assert.equal(ok(await actor.create_sheet_v2(createRequest)).id, randomSheet.id);
assert.deepEqual(ok(await actor.get_sheet_key_info(randomSheet.id)), { scheme: "random-v2", key_id: randomKeyId });
await assert.rejects(() => actor.vetkd_wrap_sheet_key(randomSheet.id, newTransport.publicKey), /random|deriv/i);
const randomStored = text.decode(bytes((await actor.get_sheet_wrapped_key(randomSheet.id))[0]));
assert.deepEqual(await openSheetKeyEnvelope(randomStored, wrapping.privateKey, randomContext), randomKey);
assert.deepEqual(await actor.get_consumer_keypair(), before.consumer);
for (const secret of [oldRoot, oldSheetKey, newRoot, recoveredSheetKey, restoredRoot, localSheetKey, randomKey, transport.secretKey, newTransport.secretKey]) secret.fill(0);
console.log(JSON.stringify({ status: "passed", gateway: url.origin, canisterId: canisterId.toText(),
  oldWasmSha256: oldHash.toLowerCase(), newWasmSha256: newHash.toLowerCase(),
  actualUpgrades: 2, explicitlyDispatchedDerivations: derivationRequests,
  checks: ["old stable records byte-identical", "profile and consumer root identical", "legacy sheet key identical",
    "entry/history/name decrypt", "delivery key and mutation epoch preserved", "explicit migration leaves ciphertext intact",
    "new stable vault/registry/receipt survives upgrade", "recovery-code unlock without derivation",
    "CAS and pinned-request replay", "24-hour emergency admission", "random creation idempotent", "random VetKD fallback denied"] }));
