// Live standalone e2e for OpenChat's action_inbox canister.
//   node inbox-e2e.mjs principal           -> print the depositor principal (use in init authorized_depositors)
//   node inbox-e2e.mjs deposit <canisterId> -> deposit the proven vector (as the authorized depositor)
//   node inbox-e2e.mjs read    <canisterId> -> query + verify provenance + decrypt (the IOU consumer path)
// Host via HOST env (default http://127.0.0.1:4943).

import { HttpAgent, Actor } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";

const HOST = process.env.HOST || "http://127.0.0.1:4943";
const subtle = globalThis.crypto.subtle;
const INFO = "oc-action-inbox-v1";

// The deposit/keys come from the Rust ecies_payload `print_interop_vector` (StdRng seed 424242) — the same
// vector the crypto interop check uses, so this exercises real OpenChat-produced bytes end to end.
const VEC = {
  recipient_sk_pem_b64:
    "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUdIQWdFQU1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhCRzB3YXdJQkFRUWdubWp0TktHU2lkRU96ZHhrDQpqRTI4bkh3TFd3QkRZVWxTbDZyYmo1OHIrV3FoUkFOQ0FBUnJESmo1VTJPQkF0bGdyNzJGSmNBSWFNYjVOT1BNDQp3T1FYMDVIMWdzeWthN3Nheitld1JJNWxyRWtudzlTaTBCMGV6OXl0TTlZZGpXZ2NJenR1OGlLSw0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQ0K",
  ephemeral_public_key_b64: "BM8/i9pzJUADvSgLGzaep8oPGY+6u8tG8rtiHKDWb4wtXzdtTSY/mCyvv25wuRcN6dg+mIKIPQSOlrLoqHsADik=",
  ciphertext_b64:
    "nvDw0tfQh5q51eoPJyWsP164l9n8jo//h6OD0au67ANOEFnEHjgTXLEUFog1IXQRWiX9NcJ7sNufw0iDFE6m2nxeFFi2cPk9t9TE/AKdzlZj",
  oc_signature_b64: "aicN/G4qVL3FSQzc9rppGgjoeE47wXNQdjlq45WPh3gIH+2HtPpq9+kzUkab/picrOlv2PwkL9IW5QXju6UY4w==",
  fingerprint_hex: "2d86d5f2f9c5204734f13f2a39f2f724848b775543ab847243c78d91cd126137",
  expected_plaintext: '{"action_id":"iou.add","rows":[{"label":"Amount","value":"$20"}]}',
};

const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const pemToDer = (pem) =>
  b64(pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/[\r\n\s]/g, ""));

// Deterministic depositor identity (its principal goes into init authorized_depositors).
const DEPOSITOR = Ed25519KeyIdentity.generate(new Uint8Array(32).fill(7));

const idlFactory = ({ IDL }) => {
  const ActionDeposit = IDL.Record({
    idempotency_id: IDL.Nat64,
    consumer_key_fingerprint: IDL.Vec(IDL.Nat8),
    ephemeral_public_key: IDL.Vec(IDL.Nat8),
    ciphertext: IDL.Vec(IDL.Nat8),
    oc_signature: IDL.Vec(IDL.Nat8),
    created_at: IDL.Nat64,
  });
  const NotifyArgs = IDL.Record({ deposits: IDL.Vec(ActionDeposit) });
  const NotifyResp = IDL.Variant({ Success: IDL.Null, Error: IDL.Tuple(IDL.Nat16, IDL.Opt(IDL.Text)) });
  const QueryArgs = IDL.Record({
    max_results: IDL.Nat32,
    consumer_key_fingerprint: IDL.Vec(IDL.Nat8),
    since_id: IDL.Nat64,
  });
  const StoredAction = IDL.Record({
    id: IDL.Nat64,
    ciphertext: IDL.Vec(IDL.Nat8),
    ephemeral_public_key: IDL.Vec(IDL.Nat8),
    created_at: IDL.Nat64,
    oc_signature: IDL.Vec(IDL.Nat8),
  });
  const QueryResp = IDL.Variant({ Success: IDL.Record({ actions: IDL.Vec(StoredAction) }) });
  const PubResp = IDL.Variant({ Success: IDL.Text });
  return IDL.Service({
    actions: IDL.Func([QueryArgs], [QueryResp], ["query"]),
    c2c_notify_actions: IDL.Func([NotifyArgs], [NotifyResp], []),
    openchat_public_key: IDL.Func([IDL.Record({})], [PubResp], ["query"]),
  });
};

async function actorFor(canisterId, identity) {
  const agent = await HttpAgent.create({ host: HOST, identity, shouldFetchRootKey: true });
  return Actor.createActor(idlFactory, { agent, canisterId });
}

async function decrypt(ephRaw, ciphertext, skPem) {
  const priv = await subtle.importKey("pkcs8", pemToDer(skPem), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const eph = await subtle.importKey("raw", ephRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: eph }, priv, 256);
  const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(INFO) }, hk, 352),
  );
  const key = await subtle.importKey("raw", okm.slice(0, 32), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: okm.slice(32, 44), tagLength: 128 }, key, ciphertext);
  return new TextDecoder().decode(new Uint8Array(pt));
}

async function verify(ephRaw, ciphertext, sig, ocPubPem) {
  const pub = await subtle.importKey("spki", pemToDer(ocPubPem), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const preimage = new Uint8Array(ephRaw.length + ciphertext.length);
  preimage.set(ephRaw, 0);
  preimage.set(ciphertext, ephRaw.length);
  return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, preimage);
}

const mode = process.argv[2];
const canisterId = process.argv[3];

if (mode === "principal") {
  console.log(DEPOSITOR.getPrincipal().toText());
} else if (mode === "deposit") {
  const actor = await actorFor(canisterId, DEPOSITOR);
  const r = await actor.c2c_notify_actions({
    deposits: [
      {
        idempotency_id: 1n,
        consumer_key_fingerprint: Array.from(hexToBytes(VEC.fingerprint_hex)),
        ephemeral_public_key: Array.from(b64(VEC.ephemeral_public_key_b64)),
        ciphertext: Array.from(b64(VEC.ciphertext_b64)),
        oc_signature: Array.from(b64(VEC.oc_signature_b64)),
        created_at: BigInt(Date.now()),
      },
    ],
  });
  console.log("deposit result:", JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
} else if (mode === "read") {
  const actor = await actorFor(canisterId, DEPOSITOR);
  const ocPubPem = (await actor.openchat_public_key({})).Success;
  console.log("openchat_public_key (first line):", ocPubPem.split("\n")[0]);
  const resp = await actor.actions({
    max_results: 50,
    consumer_key_fingerprint: Array.from(hexToBytes(VEC.fingerprint_hex)),
    since_id: 0n,
  });
  const actions = resp.Success.actions;
  console.log(`inbox returned ${actions.length} action(s) for our fingerprint`);
  let ok = 0;
  for (const a of actions) {
    const eph = Uint8Array.from(a.ephemeral_public_key);
    const ct = Uint8Array.from(a.ciphertext);
    const signed = await verify(eph, ct, Uint8Array.from(a.oc_signature), ocPubPem);
    const pt = await decrypt(eph, ct, new TextDecoder().decode(b64(VEC.recipient_sk_pem_b64)));
    const match = pt === VEC.expected_plaintext;
    console.log(`  action id=${a.id}  provenance=${signed ? "VALID" : "INVALID"}  decrypt=${match ? "MATCH" : "MISMATCH"}`);
    console.log(`    plaintext: ${pt}`);
    if (signed && match) ok++;
  }
  console.log(ok > 0 ? `\nLIVE CYCLE OK (${ok} action(s) verified + decrypted from the canister)` : "\nNO VALID ACTIONS");
  process.exit(ok > 0 ? 0 : 1);
} else {
  console.error("usage: node inbox-e2e.mjs principal|deposit <id>|read <id>");
  process.exit(2);
}
