// Standalone proof that the browser ECIES decrypt matches the Rust `ecies_payload` wire format.
// Pure Node WebCrypto — no vite/rollup/vitest. Run: node scripts/actioninbox-interop-check.mjs
// Mirrors src/features/openchat/actionInboxCrypto.ts exactly.

const subtle = globalThis.crypto.subtle;
const INFO = "oc-action-inbox-v1";

const VEC = {
  recipient_sk_pem_b64:
    "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tDQpNSUdIQWdFQU1CTUdCeXFHU000OUFnRUdDQ3FHU000OUF3RUhCRzB3YXdJQkFRUWdubWp0TktHU2lkRU96ZHhrDQpqRTI4bkh3TFd3QkRZVWxTbDZyYmo1OHIrV3FoUkFOQ0FBUnJESmo1VTJPQkF0bGdyNzJGSmNBSWFNYjVOT1BNDQp3T1FYMDVIMWdzeWthN3Nheitld1JJNWxyRWtudzlTaTBCMGV6OXl0TTlZZGpXZ2NJenR1OGlLSw0KLS0tLS1FTkQgUFJJVkFURSBLRVktLS0tLQ0K",
  recipient_pk_pem_b64:
    "LS0tLS1CRUdJTiBQVUJMSUMgS0VZLS0tLS0NCk1Ga3dFd1lIS29aSXpqMENBUVlJS29aSXpqMERBUWNEUWdBRWF3eVkrVk5qZ1FMWllLKzloU1hBQ0dqRytUVGoNCnpNRGtGOU9SOVlMTXBHdTdHcy9uc0VTT1pheEpKOFBVb3RBZEhzL2NyVFBXSFkxb0hDTTdidklpaWc9PQ0KLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tDQo=",
  ephemeral_public_key_b64: "BM8/i9pzJUADvSgLGzaep8oPGY+6u8tG8rtiHKDWb4wtXzdtTSY/mCyvv25wuRcN6dg+mIKIPQSOlrLoqHsADik=",
  ciphertext_b64:
    "nvDw0tfQh5q51eoPJyWsP164l9n8jo//h6OD0au67ANOEFnEHjgTXLEUFog1IXQRWiX9NcJ7sNufw0iDFE6m2nxeFFi2cPk9t9TE/AKdzlZj",
  expected_plaintext: '{"action_id":"iou.add","rows":[{"label":"Amount","value":"$20"}]}',
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

console.log(failures === 0 ? "\nALL INTEROP CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
