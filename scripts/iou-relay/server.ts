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
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.IOU_RELAY_PORT ?? 8788);
const TTL_MS = Number(process.env.IOU_RELAY_TTL_MS ?? 60 * 60 * 1000); // 1h
const MAX_PER_TOKEN = 50;
const MIN_TOKEN_LEN = 24;
const MAX_BODY = 64 * 1024;

type Pending = { id: string; draft: unknown; created_at: number };
const store = new Map<string, Pending[]>(); // link token -> pending drafts

function prune(): void {
  const now = Date.now();
  for (const [token, list] of store) {
    const kept = list.filter((p) => now - p.created_at < TTL_MS);
    if (kept.length) store.set(token, kept);
    else store.delete(token);
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
    const list = store.get(parsed.token) ?? [];
    if (list.length >= MAX_PER_TOKEN) list.shift(); // drop oldest
    const pending: Pending = { id: randomUUID(), draft: parsed.draft, created_at: Date.now() };
    list.push(pending);
    store.set(parsed.token, list);
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
