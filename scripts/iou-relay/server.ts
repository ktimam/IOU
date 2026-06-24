// Key-blind draft relay (no-paste path) — Milestone 1.
//
// The chat connector POSTs a prepared IOU "draft" here; the IOU app polls and
// shows it in a "Pending from chat" inbox → the user confirms → the app encrypts
// on-device and writes add_entry. This removes the copy-paste step.
//
// SECURITY — KEY-BLIND BY CONSTRUCTION. This relay only ever holds the plaintext
// DRAFT (amount/currency/counterparty/date/direction/note — the same fields the
// user already handed to their AI). It NEVER holds K_sheet, an IC identity, or
// any ciphertext/key. The encrypted write happens entirely on the user's device
// in the IOU app. So the relay's trust surface is exactly "it can see the draft
// content" — no worse than the AI provider that already saw the screenshot — and
// it can NOT read or forge the encrypted ledger.
//
// Routing (prototype): drafts are keyed by an opaque LINK TOKEN — a shared secret
// the user copies once from the IOU app into their connector config. Anyone with
// the token can read/clear that token's pending drafts, so treat it like a
// password (>= 24 chars, random). Production mobile would replace the token with
// OAuth (Claude-user → IOU-principal) + a signed-IC-identity challenge; the
// store/serve/delete-by-key core below is unchanged.
//
// Run:  IOU_RELAY_PORT=8788 pnpm relay:serve

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyOpenChatToken } from "./openchatAuth";

const PORT = Number(process.env.IOU_RELAY_PORT ?? 8788);
const TTL_MS = Number(process.env.IOU_RELAY_TTL_MS ?? 60 * 60 * 1000); // 1h
const PAIRING_TTL_MS = Number(process.env.IOU_PAIRING_TTL_MS ?? 10 * 60 * 1000); // 10m
const MAX_PER_TOKEN = 50;
const MIN_TOKEN_LEN = 24;
const MAX_BODY = 64 * 1024;
// OpenChat provenance public key (PEM), inline (IOU_OPENCHAT_PUBKEY) or from a
// file (IOU_OPENCHAT_PUBKEY_FILE). Unset → the OpenChat ingestion + claim paths
// return 503; the link-token path is unaffected. The relay only ever holds
// OpenChat's PUBLIC key, so it verifies provenance but can't forge it.
function loadOpenChatPubkey(): string {
  if (process.env.IOU_OPENCHAT_PUBKEY) return process.env.IOU_OPENCHAT_PUBKEY;
  const f = process.env.IOU_OPENCHAT_PUBKEY_FILE;
  if (f) {
    try {
      return readFileSync(f, "utf8");
    } catch {
      console.error(`iou-relay: could not read IOU_OPENCHAT_PUBKEY_FILE=${f}`);
    }
  }
  return "";
}
const OPENCHAT_PUBKEY = loadOpenChatPubkey();

type Pending = {
  id: string;
  draft: unknown;
  created_at: number;
  source?: "connector" | "openchat";
  provenance?: { openchat_user: string };
};
const store = new Map<string, Pending[]>(); // link token -> pending drafts

// OpenChat pairing — KEY-BLIND routing metadata only (OpenChat-user → which IOU
// link token a draft routes to). Never K_sheet, never an IC identity.
//   pairingCodes: short-lived code  → IOU link token (the IOU app starts this)
//   pairings:     OpenChat user id  → IOU link token (claimed by OpenChat)
type Coded = { token: string; created_at: number };
const pairingCodes = new Map<string, Coded>();
const pairings = new Map<string, Coded>();

function pushDraft(token: string, pending: Pending): void {
  const list = store.get(token) ?? [];
  if (list.length >= MAX_PER_TOKEN) list.shift(); // drop oldest
  list.push(pending);
  store.set(token, list);
}

function prune(): void {
  const now = Date.now();
  for (const [token, list] of store) {
    const kept = list.filter((p) => now - p.created_at < TTL_MS);
    if (kept.length) store.set(token, kept);
    else store.delete(token);
  }
  for (const [code, v] of pairingCodes) {
    if (now - v.created_at >= PAIRING_TTL_MS) pairingCodes.delete(code);
  }
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.statusCode = code;
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > MAX_BODY) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const validToken = (t: unknown): t is string =>
  typeof t === "string" && t.length >= MIN_TOKEN_LEN && t.length <= 256;

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return void send(res, 204, {});
  prune();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // POST /v1/drafts  { token, draft }  → store, return { id }
  if (req.method === "POST" && path === "/v1/drafts") {
    let parsed: any;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch {
      return void send(res, 400, { error: "invalid JSON body" });
    }
    if (!validToken(parsed?.token)) return void send(res, 400, { error: "token must be >= 24 chars" });
    if (parsed?.draft == null || typeof parsed.draft !== "object")
      return void send(res, 400, { error: "draft must be an object" });
    const pending: Pending = {
      id: randomUUID(), draft: parsed.draft, created_at: Date.now(), source: "connector",
    };
    pushDraft(parsed.token, pending);
    return void send(res, 200, { id: pending.id });
  }

  // GET /v1/drafts?token=...  → { drafts: [{ id, draft, created_at }] }
  if (req.method === "GET" && path === "/v1/drafts") {
    const token = url.searchParams.get("token");
    if (!validToken(token)) return void send(res, 400, { error: "token required" });
    return void send(res, 200, { drafts: store.get(token) ?? [] });
  }

  // DELETE /v1/drafts/:id?token=...  → clear after the app has written it
  if (req.method === "DELETE" && path.startsWith("/v1/drafts/")) {
    const token = url.searchParams.get("token");
    const id = decodeURIComponent(path.slice("/v1/drafts/".length));
    if (!validToken(token)) return void send(res, 400, { error: "token required" });
    const list = store.get(token) ?? [];
    const next = list.filter((p) => p.id !== id);
    if (next.length) store.set(token, next);
    else store.delete(token);
    return void send(res, 200, { ok: true, removed: list.length - next.length });
  }

  // --- OpenChat pairing + ingestion (confirmed-draft consumer side) ---

  // POST /v1/pairings/start { token }  → { code, expires_in_ms }
  // The IOU app (which holds the link token) starts a pairing and shows `code`
  // as a short string / QR for the user to give the OpenChat integration.
  if (req.method === "POST" && path === "/v1/pairings/start") {
    let parsed: any;
    try { parsed = JSON.parse(await readBody(req)); } catch { return void send(res, 400, { error: "invalid JSON body" }); }
    if (!validToken(parsed?.token)) return void send(res, 400, { error: "token must be >= 24 chars" });
    const code = randomBytes(5).toString("hex").toUpperCase(); // 10 hex chars
    pairingCodes.set(code, { token: parsed.token, created_at: Date.now() });
    return void send(res, 200, { code, expires_in_ms: PAIRING_TTL_MS });
  }

  // POST /v1/pairings/claim { code, oc_token }  → { ok, openchat_user }
  // The OpenChat integration submits the user's pairing code + a provenance
  // token; the relay binds that OpenChat user to the link token.
  if (req.method === "POST" && path === "/v1/pairings/claim") {
    if (!OPENCHAT_PUBKEY) return void send(res, 503, { error: "OpenChat provenance key not configured" });
    let parsed: any;
    try { parsed = JSON.parse(await readBody(req)); } catch { return void send(res, 400, { error: "invalid JSON body" }); }
    const coded = typeof parsed?.code === "string" ? pairingCodes.get(parsed.code) : undefined;
    if (!coded) return void send(res, 404, { error: "unknown or expired pairing code" });
    const claims = verifyOpenChatToken(String(parsed?.oc_token ?? ""), OPENCHAT_PUBKEY, Date.now());
    if (!claims) return void send(res, 401, { error: "invalid OpenChat provenance token" });
    pairings.set(claims.sub, { token: coded.token, created_at: Date.now() });
    pairingCodes.delete(parsed.code);
    return void send(res, 200, { ok: true, openchat_user: claims.sub });
  }

  // GET /v1/pairings?token=...  → { pairings: [{ openchat_user, created_at }] }
  if (req.method === "GET" && path === "/v1/pairings") {
    const token = url.searchParams.get("token");
    if (!validToken(token)) return void send(res, 400, { error: "token required" });
    const list = [...pairings.entries()]
      .filter(([, v]) => v.token === token)
      .map(([sub, v]) => ({ openchat_user: sub, created_at: v.created_at }));
    return void send(res, 200, { pairings: list });
  }

  // DELETE /v1/pairings/:openchat_user?token=...  → revoke a link
  if (req.method === "DELETE" && path.startsWith("/v1/pairings/")) {
    const token = url.searchParams.get("token");
    const sub = decodeURIComponent(path.slice("/v1/pairings/".length));
    if (!validToken(token)) return void send(res, 400, { error: "token required" });
    const cur = pairings.get(sub);
    let removed = 0;
    if (cur && cur.token === token) { pairings.delete(sub); removed = 1; }
    return void send(res, 200, { ok: true, removed });
  }

  // POST /v1/openchat/drafts { oc_token, draft }  → route to the paired token.
  // OpenChat forwards a confirmed draft + provenance; verify, look up pairing,
  // store under the IOU link token (source "openchat").
  if (req.method === "POST" && path === "/v1/openchat/drafts") {
    if (!OPENCHAT_PUBKEY) return void send(res, 503, { error: "OpenChat provenance key not configured" });
    let parsed: any;
    try { parsed = JSON.parse(await readBody(req)); } catch { return void send(res, 400, { error: "invalid JSON body" }); }
    const claims = verifyOpenChatToken(String(parsed?.oc_token ?? ""), OPENCHAT_PUBKEY, Date.now());
    if (!claims) return void send(res, 401, { error: "invalid OpenChat provenance token" });
    if (parsed?.draft == null || typeof parsed.draft !== "object")
      return void send(res, 400, { error: "draft must be an object" });
    const coded = pairings.get(claims.sub);
    if (!coded) return void send(res, 409, { error: "OpenChat user not paired to any IOU account" });
    const pending: Pending = {
      id: randomUUID(), draft: parsed.draft, created_at: Date.now(),
      source: "openchat", provenance: { openchat_user: claims.sub },
    };
    pushDraft(coded.token, pending);
    return void send(res, 200, { id: pending.id });
  }

  if (req.method === "GET" && path === "/health") return void send(res, 200, { ok: true });

  send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: String((e as Error)?.message ?? e) }));
});

server.listen(PORT, () => {
  // stderr so it never pollutes anything piping stdout
  console.error(`iou-relay listening on http://127.0.0.1:${PORT} (key-blind; TTL ${TTL_MS}ms)`);
});
