// Headless selftest for the connector's verifiable core: ES256 provenance
// (x-oc-signature + JWT) exactly as OpenChat produces it, and the rows→draft
// mapping. The /notify → relay forward is exercised by the live e2e + the relay
// selftests; this asserts the trust + translation logic in isolation.
// Run: ./node_modules/.bin/tsx scripts/iou-openchat-bot/selftest.ts
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyOcSignature, verifyOcJwt } from "./ocVerify";
import { rowsToDraft } from "./rowsToDraft";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const oc = generateKeyPairSync("ec", { namedCurve: "P-256" });
const evil = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PUB = oc.publicKey.export({ type: "spki", format: "pem" }).toString();
// ES256 = ECDSA P-256 + SHA-256 with raw IEEE-P1363 (r||s) signatures.
const es256 = (data: Buffer, key = oc.privateKey) => edSign("sha256", data, { key, dsaEncoding: "ieee-p1363" });

// 1) x-oc-signature over a raw /notify body
const body = Buffer.from(JSON.stringify({ kind: "action_card_response", x: 1 }));
ok(verifyOcSignature(body, b64url(es256(body)), PUB), "valid x-oc-signature verifies");
ok(!verifyOcSignature(Buffer.from(body.toString() + "x"), b64url(es256(body)), PUB), "tampered body rejected");
ok(!verifyOcSignature(body, b64url(es256(body, evil.privateKey)), PUB), "wrong-key signature rejected");

// 2) ES256 JWT (OpenChat libraries/jwt format: b64url(header).b64url(claims).b64url(sig))
const now = Date.now();
const mkJwt = (claims: object, key = oc.privateKey) => {
  const h = b64url(Buffer.from(JSON.stringify({ alg: "ES256" })));
  const c = b64url(Buffer.from(JSON.stringify(claims)));
  return `${h}.${c}.${b64url(es256(Buffer.from(`${h}.${c}`), key))}`;
};
const good = verifyOcJwt(mkJwt({ exp: Math.floor(now / 1000) + 300, claim_type: "AiAction", oc_user: "oc-alice" }), PUB, now);
ok(good?.oc_user === "oc-alice", "valid ES256 JWT verifies + decodes claims");
ok(verifyOcJwt(mkJwt({ exp: Math.floor(now / 1000) - 10, claim_type: "x" }), PUB, now) === null, "expired JWT rejected");
ok(verifyOcJwt(mkJwt({ exp: Math.floor(now / 1000) + 300 }, evil.privateKey), PUB, now) === null, "forged JWT rejected");

// 3) rows → IOU draft
const d = rowsToDraft([
  { label: "Amount", value: "42.50" },
  { label: "Currency", value: "usd" },
  { label: "Direction", value: "Owed to you" },
  { label: "Note", value: "dinner" },
]);
ok(d?.amount === 42.5 && d?.currency === "USD" && d?.direction === "credit" && d?.note === "dinner", "rows → draft (credit)");
ok(rowsToDraft([{ label: "Amount", value: "10" }, { label: "Currency", value: "EUR" }, { label: "Direction", value: "You owe" }])?.direction === "debt", "direction 'You owe' → debt");
ok(rowsToDraft([{ label: "Currency", value: "USD" }]) === null, "missing amount → null");

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass}/${pass + fail})`);
process.exit(fail ? 1 : 0);
