// Headless self-test for the key-blind draft relay: spawns the server and does
// real HTTP round-trips (push → poll → delete + token validation).
// Run: ./node_modules/.bin/tsx scripts/iou-relay/selftest.ts  (or `pnpm relay:selftest`)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("could not allocate relay test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
  return port;
}

const PORT = await availablePort();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "tok_" + "x".repeat(28); // >= 24 chars
const DRAFT = { kind: "settlement", amount: 42.5, currency: "USD", direction: "credit", draft_id: "d:abc12345" };
const auth = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}` });
const TSX_CLI = path.resolve("node_modules/tsx/dist/cli.mjs");
const TEST_MAX_BODY = 256;

function jsonBodyOfBytes(bytes: number): string {
  const empty = JSON.stringify({ draft: { pad: "" } });
  const padding = bytes - Buffer.byteLength(empty, "utf8");
  if (padding < 0) throw new Error("requested body is too small");
  return JSON.stringify({ draft: { pad: "x".repeat(padding) } });
}

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log("  ✅ " + m); } else { fail++; console.log("  ❌ " + m); } };

async function waitHealthy(timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + "/health");
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function main() {
  const srv = spawn(process.execPath, [TSX_CLI, "scripts/iou-relay/server.ts"], {
    env: {
      ...process.env,
      IOU_RELAY_HOST: "127.0.0.1",
      IOU_RELAY_PORT: String(PORT),
      IOU_RELAY_MAX_BODY_BYTES: String(TEST_MAX_BODY),
      IOU_RELAY_MAX_TOKEN_NAMESPACES: "2",
      IOU_RELAY_MAX_PENDING_DRAFTS: "3",
      IOU_RELAY_MAX_PAIRING_CODES: "2",
      IOU_RELAY_RATE_LIMIT_MAX: "100",
    },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    ok(await waitHealthy(), "relay started and healthy");

    // push a draft
    const post = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(TOKEN) },
      body: JSON.stringify({ draft: DRAFT }),
    });
    const { id } = await post.json();
    ok(post.status === 200 && typeof id === "string", `POST /v1/drafts → id ${id?.slice(0, 8)}…`);

    // poll
    const got = await (await fetch(`${BASE}/v1/drafts`, { headers: auth(TOKEN) })).json();
    ok(got.drafts.length === 1, "GET returns 1 pending draft");
    ok(got.drafts[0].draft.amount === 42.5 && got.drafts[0].draft.draft_id === "d:abc12345", "draft round-trips intact (amount + draft_id)");

    // a second token is isolated
    const other = await (await fetch(`${BASE}/v1/drafts`, { headers: auth("tok_" + "y".repeat(28)) })).json();
    ok(other.drafts.length === 0, "a different token sees no drafts (isolation)");

    // delete clears it
    const del = await fetch(`${BASE}/v1/drafts/${id}`, { method: "DELETE", headers: auth(TOKEN) });
    ok((await del.json()).removed === 1, "DELETE removes the draft");
    const after = await (await fetch(`${BASE}/v1/drafts`, { headers: auth(TOKEN) })).json();
    ok(after.drafts.length === 0, "GET after delete → empty");

    // token validation
    const bad = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth("short") },
      body: JSON.stringify({ draft: DRAFT }),
    });
    ok(bad.status === 401, "short bearer token rejected (401)");

    const bodyCredential = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, draft: DRAFT }),
    });
    ok(bodyCredential.status === 401, "body credential rejected (401)");

    const leaked = await fetch(`${BASE}/v1/drafts?token=${TOKEN}`);
    ok(leaked.status === 401, "query-string bearer token rejected (401)");

    // Body limits are exact UTF-8 byte limits. Oversize requests get a
    // bounded 413/connection-close response instead of continuing to buffer.
    const exactBody = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(TOKEN) },
      body: jsonBodyOfBytes(TEST_MAX_BODY),
    });
    const exactDraft = await exactBody.json();
    ok(exactBody.status === 200, "body exactly at byte cap is accepted");
    const overBody = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(TOKEN) },
      body: jsonBodyOfBytes(TEST_MAX_BODY + 1),
    });
    ok(overBody.status === 413, "body one byte over cap is rejected (413)");

    // Arbitrary bearer strings cannot create unbounded token namespaces or
    // pending records. Existing namespaces remain usable until the global
    // draft cap is reached.
    const token2 = "tok_" + "2".repeat(28);
    const secondNamespace = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(token2) },
      body: JSON.stringify({ draft: DRAFT }),
    });
    ok(secondNamespace.status === 200, "second token namespace is accepted at configured cap");
    const secondDraft = await secondNamespace.json();
    const thirdPending = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(TOKEN) },
      body: JSON.stringify({ draft: DRAFT }),
    });
    ok(thirdPending.status === 200, "existing namespace remains usable at namespace cap");
    const globalDraftCap = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth(TOKEN) },
      body: JSON.stringify({ draft: DRAFT }),
    });
    ok(globalDraftCap.status === 429, "global pending-draft cap returns 429");
    await fetch(`${BASE}/v1/drafts/${exactDraft.id}`, { method: "DELETE", headers: auth(TOKEN) });
    const namespaceCap = await fetch(BASE + "/v1/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth("tok_" + "3".repeat(28)) },
      body: JSON.stringify({ draft: DRAFT }),
    });
    ok(namespaceCap.status === 429, "third token namespace is refused with 429");
    await fetch(`${BASE}/v1/drafts/${secondDraft.id}`, { method: "DELETE", headers: auth(token2) });

    const code1 = await fetch(BASE + "/v1/pairings/start", { method: "POST", headers: auth(TOKEN) });
    const code2 = await fetch(BASE + "/v1/pairings/start", { method: "POST", headers: auth(TOKEN) });
    const code3 = await fetch(BASE + "/v1/pairings/start", { method: "POST", headers: auth(TOKEN) });
    ok(code1.status === 200 && code2.status === 200, "pairing codes fill the configured bounded table");
    ok(code3.status === 429, "pairing-code table cap returns 429");

    console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
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
