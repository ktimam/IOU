// Headless self-test for the OpenChat → IOU consumer path on the relay:
// pairing (start/claim/list/revoke) + provenance-verified ingestion + routing
// to the paired link token, with real Ed25519 provenance tokens.
// Run: ./node_modules/.bin/tsx scripts/iou-relay/selftest-openchat.ts
import { spawn } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { signOpenChatToken } from "./openchatAuth";

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") {
    throw new Error("could not allocate relay test port");
  }
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

const PORT = await availablePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "tok_" + "z".repeat(28); // the IOU link token (>= 24 chars)
const DRAFT = { kind: "settlement", amount: 12.34, currency: "USD", direction: "credit", note: "from chat" };

const oc = generateKeyPairSync("ed25519"); // OpenChat's signing keypair
const evil = generateKeyPairSync("ed25519"); // a forging attacker's keypair
const PUBKEY_PEM = oc.publicKey.export({ type: "spki", format: "pem" }).toString();

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

function token(
  sub: string,
  purpose: "pairing" | "draft",
  key = oc.privateKey,
  ttlMs = 5 * 60 * 1000,
): string {
  const now = Date.now();
  return signOpenChatToken(
    {
      iss: "openchat",
      aud: "iou-relay",
      purpose,
      sub,
      jti: randomUUID(),
      iat: now,
      exp: now + ttlMs,
    },
    key,
  );
}

async function waitHealthy(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(BASE + "/health")).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
const post = (p: string, body: unknown) =>
  fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const auth = (value: string): HeadersInit => ({
  Authorization: `Bearer ${value}`,
});
const TSX_CLI = path.resolve("node_modules/tsx/dist/cli.mjs");

async function main() {
  const srv = spawn(process.execPath, [TSX_CLI, "scripts/iou-relay/server.ts"], {
    env: {
      ...process.env,
      IOU_RELAY_HOST: "127.0.0.1",
      IOU_RELAY_PORT: String(PORT),
      IOU_OPENCHAT_PUBKEY: PUBKEY_PEM,
      IOU_RELAY_MAX_PAIRINGS: "1",
      IOU_RELAY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    ok(await waitHealthy(), "relay started with OpenChat provenance key");

    // 1) IOU app starts a pairing (it holds the link token)
    const startedResponse = await fetch(BASE + "/v1/pairings/start", {
      method: "POST",
      headers: auth(TOKEN),
    });
    const started = await startedResponse.json();
    ok(typeof started.code === "string" && started.code.length >= 8, `pairing/start → code ${started.code}`);

    // 2) forged provenance token (signed by the wrong key) is rejected
    const forged = await post("/v1/pairings/claim", {
      code: started.code,
      oc_token: token("oc_alice", "pairing", evil.privateKey),
    });
    ok(forged.status === 401, "claim with FORGED provenance token → 401");

    // 3) OpenChat claims the pairing with a valid token
    const pairingToken = token("oc_alice", "pairing");
    const claim = await post("/v1/pairings/claim", {
      code: started.code,
      oc_token: pairingToken,
    });
    const claimBody = await claim.json();
    ok(claim.status === 200 && claimBody.openchat_user === "oc_alice", "claim binds oc_alice → link token");

    // 4) the code is single-use (already consumed)
    const reuse = await post("/v1/pairings/claim", {
      code: started.code,
      oc_token: token("oc_alice", "pairing"),
    });
    ok(reuse.status === 404, "pairing code is single-use (404 on reuse)");

    // 5) IOU Settings lists the pairing
    const list = await (
      await fetch(`${BASE}/v1/pairings`, { headers: auth(TOKEN) })
    ).json();
    ok(list.pairings.length === 1 && list.pairings[0].openchat_user === "oc_alice", "GET /v1/pairings lists oc_alice");

    // A full pairing table refuses a new user with 429 without consuming
    // either the pairing code or the signed one-use provenance token.
    const capacityStartResponse = await fetch(BASE + "/v1/pairings/start", {
      method: "POST",
      headers: auth(TOKEN),
    });
    const capacityStart = await capacityStartResponse.json();
    const capacityToken = token("oc_capacity", "pairing");
    const atCapacity = await post("/v1/pairings/claim", {
      code: capacityStart.code,
      oc_token: capacityToken,
    });
    ok(atCapacity.status === 429, "pairing-table cap refuses a new user with 429");

    // 6) OpenChat forwards a draft → routed to the paired link token
    const draftToken = token("oc_alice", "draft");
    const fwd = await post("/v1/openchat/drafts", {
      oc_token: draftToken,
      draft: DRAFT,
    });
    ok(fwd.status === 200, "openchat/drafts (paired) → 200");

    const replay = await post("/v1/openchat/drafts", {
      oc_token: draftToken,
      draft: DRAFT,
    });
    ok(replay.status === 401, "replayed draft provenance token → 401");

    const wrongPurpose = await post("/v1/openchat/drafts", {
      oc_token: token("oc_alice", "pairing"),
      draft: DRAFT,
    });
    ok(wrongPurpose.status === 401, "pairing-purpose token cannot submit a draft");

    // 7) the IOU app polls its link token and sees it, tagged with source + provenance
    const got = await (
      await fetch(`${BASE}/v1/drafts`, { headers: auth(TOKEN) })
    ).json();
    ok(got.drafts.length === 1, "app GET /v1/drafts sees the routed draft");
    ok(got.drafts[0].source === "openchat", "draft tagged source=openchat");
    ok(got.drafts[0].provenance?.openchat_user === "oc_alice", "draft carries provenance oc_alice");
    ok(got.drafts[0].draft.amount === 12.34, "draft content round-trips intact");

    // 8) a draft for an UNPAIRED but validly-signed user is refused (no route)
    const unpaired = await post("/v1/openchat/drafts", {
      oc_token: token("oc_bob", "draft"),
      draft: DRAFT,
    });
    ok(unpaired.status === 409, "openchat/drafts for unpaired user → 409 (no route)");

    // 9) an EXPIRED provenance token is rejected
    const expired = await post("/v1/openchat/drafts", {
      oc_token: token("oc_alice", "draft", oc.privateKey, -1000),
      draft: DRAFT,
    });
    ok(expired.status === 401, "expired provenance token → 401");

    // 10) revoke unbinds the user; further drafts no longer route
    const del = await fetch(`${BASE}/v1/pairings/oc_alice`, {
      method: "DELETE",
      headers: auth(TOKEN),
    });
    ok((await del.json()).removed === 1, "DELETE /v1/pairings/oc_alice → removed");
    const retryAfterCapacity = await post("/v1/pairings/claim", {
      code: capacityStart.code,
      oc_token: capacityToken,
    });
    ok(
      retryAfterCapacity.status === 200,
      "capacity rejection does not consume code/token; retry succeeds after space is freed",
    );
    await fetch(`${BASE}/v1/pairings/oc_capacity`, {
      method: "DELETE",
      headers: auth(TOKEN),
    });
    const afterRevoke = await post("/v1/openchat/drafts", {
      oc_token: token("oc_alice", "draft"),
      draft: DRAFT,
    });
    ok(afterRevoke.status === 409, "after revoke, oc_alice drafts no longer route (409)");

    console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"} (${pass}/${pass + fail})`);
  } finally {
    await new Promise<void>((resolve) => {
      if (srv.exitCode !== null) return resolve();
      srv.once("exit", () => resolve());
      srv.kill();
    });
  }
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
