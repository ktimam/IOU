// Standalone proof that the browser ECIES decrypt matches the Rust `ecies_payload` wire format.
// Pure Node WebCrypto — no vite/rollup/vitest. Run: node scripts/actioninbox-interop-check.mjs
// Mirrors src/features/openchat/actionInboxCrypto.ts exactly.
//
// v2 provenance preimage: the signature covers (ephemeral_public_key ‖ ciphertext ‖ created_at)
// with created_at as a u64 little-endian (8 bytes) — created_at used to travel UNSIGNED in v1. The
// fixed vector below was regenerated from the Rust `print_interop_vector` test AFTER the v2 change,
// so oc_signature_b64 is a real Rust-side `jwt::sign_bytes` signature over the v2 preimage and the
// provenance leg is a true cross-repo check again (Rust signs, WebCrypto verifies). The v1-rejection
// leg uses a runtime key (Rust can no longer produce a v1 signature).

const subtle = globalThis.crypto.subtle;
const INFO = "oc-action-inbox-v1";

const VEC = {
  recipient_sk_pem_b64:
    "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUdIQWdFQU1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhCRzB3YXdJQkFRUWdubWp0TktHU2lkRU96ZHhrDQpqRTI4bkh3TFd3QkRZVWxTbDZyYmo1OHIrV3FoUkFOQ0FBUnJESmo1VTJPQkF0bGdyNzJGSmNBSWFNYjVOT1BNDQp3T1FYMDVIMWdzeWthN3Nheitld1JJNWxyRWtudzlTaTBCMGV6OXl0TTlZZGpXZ2NJenR1OGlLSw0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQ0K",
  recipient_pk_pem_b64:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0NCk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRWF3eVkrVk5qZ1FMWllLKzloU1hBQ0dqRytUVGoNCnpNRGtGOU9SOVlMTXBHdTdHcy9uc0VTT1pheEpKOFBVb3RBZEhzL2NyVFBXSFkxb0hDTTdidklpaWc9PQ0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tDQo=",
  ephemeral_public_key_b64: "BM8/i9pzJUADvSgLGzaep8oPGY+6u8tG8rtiHKDWb4wtXzdtTSY/mCyvv25wuRcN6dg+mIKIPQSOlrLoqHsADik=",
  ciphertext_b64:
    "nvDw0tfQh5q51eoPJyWgKEr7htH9gsK+gaWbzKuslQoDC0uEQQ9KRP80GYIsbToRN2rkIcB699WHlw3dUQn5vSOnjj0qtSgPwg3WvWE+T2dLXsHOQvNLlg==",
  created_at: 1720000000000n,
  oc_public_key_pem_b64:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0NCk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRU9rTTVhejdJVGNyODVIQkJkSXluczZsclFjRDQNCnpIbUFwSHRxQUJOVzZzclRkZGkrZFFCYk03SlVXanZBcW1xUE5TYTJZQUIyNk5HazJVdllFR1Vzbmc9PQ0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tDQo=",
  oc_signature_b64: "9GBXeL/GGkMcirL3SfMRMjt3D8tgJfLsjJvuJO7riVgNPwY3+J3tEUdjx08TKdG618scFWX3/psZuY4uZn9nWQ==",
  expected_plaintext: '{"action_id":"example.action","rows":[{"label":"Amount","value":"$20"}]}',
  fingerprint_hex: "2d86d5f2f9c5204734f13f2a39f2f724848b775543ab847243c78d91cd126137",
};

const b64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
const pemToDer = (pem) =>
  b64(pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/[\r\n\s]/g, ""));
const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

async function decrypt(ephRaw, ciphertext, skPem) {
  const priv = await subtle.importKey("pkcs8", pemToDer(skPem), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const eph = await subtle.importKey("raw", ephRaw, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = await subtle.deriveBits({ name: "ECDH", public: eph }, priv, 256);
  const hk = await subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const okm = new Uint8Array(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode(INFO) },
      hk,
      44 * 8,
    ),
  );
  const key = await subtle.importKey("raw", okm.slice(0, 32), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: okm.slice(32, 44), tagLength: 128 }, key, ciphertext);
  return new TextDecoder().decode(new Uint8Array(pt));
}

let failures = 0;
const skPem = new TextDecoder().decode(b64(VEC.recipient_sk_pem_b64));
const pkPem = new TextDecoder().decode(b64(VEC.recipient_pk_pem_b64));

const pt = await decrypt(b64(VEC.ephemeral_public_key_b64), b64(VEC.ciphertext_b64), skPem);
if (pt === VEC.expected_plaintext) {
  console.log("PASS decrypt: ", pt);
} else {
  failures++;
  console.log("FAIL decrypt:\n  got     ", JSON.stringify(pt), "\n  expected", JSON.stringify(VEC.expected_plaintext));
}

const pub = await subtle.importKey("spki", pemToDer(pkPem), { name: "ECDH", namedCurve: "P-256" }, true, []);
const rawPoint = new Uint8Array(await subtle.exportKey("raw", pub));
const fp = hex(new Uint8Array(await subtle.digest("SHA-256", rawPoint)));
if (fp === VEC.fingerprint_hex) {
  console.log("PASS fingerprint:", fp);
} else {
  failures++;
  console.log("FAIL fingerprint: got", fp, "expected", VEC.fingerprint_hex);
}

// Provenance (v2 preimage): ephemeral_public_key || ciphertext || created_at (u64 LE). The signature is
// the FIXED VECTOR one Rust's `jwt::sign_bytes` produced over the v2 preimage — this proves the Rust
// signer and the WebCrypto verifier agree on the exact bytes (order, LE encoding, 8-byte width).
const eph = b64(VEC.ephemeral_public_key_b64);
const ct = b64(VEC.ciphertext_b64);
const CREATED_AT = VEC.created_at; // epoch ms, bound into the Rust-signed vector

function preimageV2(createdAt) {
  const out = new Uint8Array(eph.length + ct.length + 8);
  out.set(eph, 0);
  out.set(ct, eph.length);
  new DataView(out.buffer).setBigUint64(eph.length + ct.length, createdAt, true);
  return out;
}

const ocPub = await subtle.importKey(
  "spki",
  pemToDer(new TextDecoder().decode(b64(VEC.oc_public_key_pem_b64))),
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["verify"],
);
const sig = b64(VEC.oc_signature_b64);

const sigOk = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ocPub, sig, preimageV2(CREATED_AT));
if (sigOk) {
  console.log("PASS v2 provenance signature verify (Rust-signed vector; ECDSA P-256 raw r||s over eph||ct||created_at LE)");
} else {
  failures++;
  console.log("FAIL v2 provenance signature verify (Rust-signed vector)");
}

// created_at is BOUND: flipping the timestamp must break the signature (the v1 hole this closes).
const tamperOk = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ocPub, sig, preimageV2(CREATED_AT + 1n));
if (!tamperOk) {
  console.log("PASS tampered created_at rejected (timestamp is signed in v2)");
} else {
  failures++;
  console.log("FAIL tampered created_at accepted — created_at is not bound!");
}

// A v1 signature (eph||ct only) must NOT verify under v2 — old inbox entries are unverifiable by design.
// (Runtime key: Rust can no longer produce a v1 signature.)
const ocKp = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const v1Preimage = preimageV2(CREATED_AT).slice(0, eph.length + ct.length);
const v1Sig = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ocKp.privateKey, v1Preimage));
const v1Ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, ocKp.publicKey, v1Sig, preimageV2(CREATED_AT));
if (!v1Ok) {
  console.log("PASS v1 (unsigned created_at) signature rejected under the v2 preimage");
} else {
  failures++;
  console.log("FAIL v1 signature accepted under the v2 preimage");
}

console.log(failures === 0 ? "\nALL INTEROP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
