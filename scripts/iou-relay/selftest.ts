// Headless self-test for the key-blind draft relay: spawns the server and does
// real HTTP round-trips (push → poll → delete + token validation).
// Run: ./node_modules/.bin/tsx scripts/iou-relay/selftest.ts  (or `pnpm relay:selftest`)
import { spawn } from "node:child_process";

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "tok_" + "x".repeat(28); // >= 24 chars
const DRAFT = { kind: "settlement", amount: 42.5, currency: "USD", direction: "credit", draft_id: "d:abc12345" };

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
  const srv = spawn("./node_modules/.bin/tsx", ["scripts/iou-relay/server.ts"], {
    env: { ...process.env, IOU_RELAY_PORT: String(PORT) },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    ok(await waitHealthy(), "relay started and healthy");

    // push a draft
    const post = await fetch(BASE + "/v1/drafts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: TOKEN, draft: DRAFT }),
    });
    const { id } = await post.json();
    ok(post.status === 200 && typeof id === "string", `POST /v1/drafts → id ${id?.slice(0, 8)}…`);

    // poll
    const got = await (await fetch(`${BASE}/v1/drafts?token=${TOKEN}`)).json();
    ok(got.drafts.length === 1, "GET returns 1 pending draft");
    ok(got.drafts[0].draft.amount === 42.5 && got.drafts[0].draft.draft_id === "d:abc12345", "draft round-trips intact (amount + draft_id)");

    // a second token is isolated
    const other = await (await fetch(`${BASE}/v1/drafts?token=${"tok_" + "y".repeat(28)}`)).json();
    ok(other.drafts.length === 0, "a different token sees no drafts (isolation)");

    // delete clears it
    const del = await fetch(`${BASE}/v1/drafts/${id}?token=${TOKEN}`, { method: "DELETE" });
    ok((await del.json()).removed === 1, "DELETE removes the draft");
    const after = await (await fetch(`${BASE}/v1/drafts?token=${TOKEN}`)).json();
    ok(after.drafts.length === 0, "GET after delete → empty");

    // token validation
    const bad = await fetch(BASE + "/v1/drafts", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "short", draft: DRAFT }),
    });
    ok(bad.status === 400, "short token rejected (400)");

    console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}`);
  } finally {
    srv.kill();
  }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
