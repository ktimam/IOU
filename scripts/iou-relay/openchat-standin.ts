// Local OpenChat STAND-IN for testing the IOU consumer cycle before OpenChat's
// real generic features exist. It holds an Ed25519 keypair (the relay verifies
// against its PUBLIC key) and can claim a pairing + forward a draft — exactly
// what the real OpenChat integration will do at /v1/pairings/claim and
// /v1/openchat/drafts. NOT for production; the key files are gitignored.
//
//   tsx scripts/iou-relay/openchat-standin.ts pubkey                 # write+print public key; point the relay at it
//   tsx scripts/iou-relay/openchat-standin.ts claim <CODE> [user]    # claim a pairing code from the IOU app
//   tsx scripts/iou-relay/openchat-standin.ts send [user] [amount] [currency] [credit|debt] [note...]
//
// Env: IOU_RELAY_URL (default http://127.0.0.1:8788)

import { generateKeyPairSync, createPrivateKey, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { signOpenChatToken } from "./openchatAuth";

const DIR = dirname(fileURLToPath(import.meta.url));
const PRIV = join(DIR, ".standin-key.pem");
const PUB = join(DIR, ".standin-pub.pem");
const RELAY = (process.env.IOU_RELAY_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");

function ensureKeys(): void {
  if (existsSync(PRIV) && existsSync(PUB)) return;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(PRIV, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  writeFileSync(PUB, publicKey.export({ type: "spki", format: "pem" }).toString());
}
const token = (sub: string, purpose: "pairing" | "draft"): string => {
  const now = Date.now();
  return signOpenChatToken(
    {
      iss: "openchat",
      aud: "iou-relay",
      purpose,
      sub,
      jti: randomUUID(),
      iat: now,
      exp: now + 5 * 60 * 1000,
    },
    createPrivateKey(readFileSync(PRIV, "utf8")),
  );
};
const post = (p: string, body: unknown) =>
  fetch(RELAY + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  ensureKeys();

  if (cmd === "pubkey") {
    process.stdout.write(readFileSync(PUB, "utf8"));
    console.error(`\n[standin] public key at ${PUB}`);
    console.error(`[standin] start the relay with:  IOU_OPENCHAT_PUBKEY_FILE=${PUB}`);
    return;
  }
  if (cmd === "claim") {
    const code = args[0];
    const user = args[1] ?? "oc-tester";
    if (!code) { console.error("usage: claim <CODE> [user]"); process.exit(2); }
    const r = await post("/v1/pairings/claim", {
      code,
      oc_token: token(user, "pairing"),
    });
    console.error(`[standin] claim ${r.status}: ${await r.text()}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === "send") {
    const user = args[0] ?? "oc-tester";
    const draft = {
      kind: "settlement",
      amount: args[1] ? Number(args[1]) : 42.5,
      currency: (args[2] ?? "USD").toUpperCase(),
      direction: args[3] === "debt" ? "debt" : "credit",
      note: args.slice(4).join(" ") || "from openchat stand-in",
    };
    const r = await post("/v1/openchat/drafts", {
      oc_token: token(user, "draft"),
      draft,
    });
    console.error(`[standin] send ${r.status}: ${await r.text()}`);
    process.exit(r.ok ? 0 : 1);
  }
  console.error("commands: pubkey | claim <CODE> [user] | send [user] [amount] [currency] [credit|debt] [note]");
  process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
