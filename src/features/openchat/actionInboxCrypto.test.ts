import { describe, it, expect } from "vitest";
import {
  decryptInboxEnvelope,
  importEcdhPrivateKeyFromPkcs8Pem,
  keyFingerprint,
  __testing,
} from "./actionInboxCrypto";

const { b64ToBytes } = __testing;

// Cross-language interop vector, produced by the Rust `ecies_payload` library that OpenChat itself uses to
// encrypt confirmed actions into the action_inbox (test `print_interop_vector`, StdRng seed 424242). If this
// passes, the browser decrypts the exact wire format OpenChat produces — the riskiest contract in the cycle.
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

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

describe("action_inbox ECIES interop with Rust ecies_payload", () => {
  it("decrypts an envelope produced by the Rust library (HKDF salt + AES-GCM match)", async () => {
    const skPem = new TextDecoder().decode(b64ToBytes(VEC.recipient_sk_pem_b64));
    const priv = await importEcdhPrivateKeyFromPkcs8Pem(skPem);
    const pt = await decryptInboxEnvelope(
      {
        ephemeralPublicKey: b64ToBytes(VEC.ephemeral_public_key_b64),
        ciphertext: b64ToBytes(VEC.ciphertext_b64),
      },
      priv,
    );
    expect(new TextDecoder().decode(pt)).toBe(VEC.expected_plaintext);
  });

  it("computes the same routing fingerprint as Rust (sha256 of SPKI DER)", async () => {
    const pkPem = new TextDecoder().decode(b64ToBytes(VEC.recipient_pk_pem_b64));
    const fp = await keyFingerprint(pkPem);
    expect(bytesToHex(fp)).toBe(VEC.fingerprint_hex);
  });
});
