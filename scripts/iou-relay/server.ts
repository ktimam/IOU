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
// The safe prototype default binds to loopback only. Setting IOU_RELAY_HOST to
// a non-loopback address is an explicit operator choice and still requires TLS,
// real edge authentication, and reverse-proxy request/rate limits. The bounded
// in-process maps and limiter below are defense in depth, not a public-service
// authentication layer.
//
// Run:  IOU_RELAY_PORT=8788 pnpm relay:serve

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { OpenChatReplayGuard, verifyOpenChatToken } from "./openchatAuth";
import {
  BodyTooLargeError,
  FixedWindowRateLimiter,
  canInsertMapKey,
  pruneInactivePairings,
  readBoundedBody,
} from "./limits";

function positiveEnv(name: string, fallback: number, upperBound: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > upperBound) {
    throw new Error(`${name} must be an integer in 1..${upperBound}`);
  }
  return value;
}

const PORT = Number(process.env.IOU_RELAY_PORT ?? 8788);
const HOST = process.env.IOU_RELAY_HOST ?? "127.0.0.1";
const ALLOWED_ORIGIN = process.env.IOU_RELAY_ALLOWED_ORIGIN ?? "http://127.0.0.1:3000";
const TTL_MS = positiveEnv("IOU_RELAY_TTL_MS", 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const PAIRING_TTL_MS = positiveEnv("IOU_PAIRING_TTL_MS", 10 * 60 * 1000, 24 * 60 * 60 * 1000);
const PAIRING_MAX_AGE_MS = positiveEnv(
  "IOU_PAIRING_MAX_AGE_MS",
  30 * 24 * 60 * 60 * 1000,
  365 * 24 * 60 * 60 * 1000,
);
const MAX_PER_TOKEN = 50;
const MIN_TOKEN_LEN = 24;
const MAX_BODY = positiveEnv("IOU_RELAY_MAX_BODY_BYTES", 64 * 1024, 1024 * 1024);
const MAX_TOKEN_NAMESPACES = positiveEnv("IOU_RELAY_MAX_TOKEN_NAMESPACES", 256, 100_000);
const MAX_PENDING_DRAFTS = positiveEnv("IOU_RELAY_MAX_PENDING_DRAFTS", 1_000, 1_000_000);
const MAX_PAIRING_CODES = positiveEnv("IOU_RELAY_MAX_PAIRING_CODES", 1_000, 100_000);
const MAX_PAIRINGS = positiveEnv("IOU_RELAY_MAX_PAIRINGS", 10_000, 100_000);
const RATE_LIMIT_MAX = positiveEnv("IOU_RELAY_RATE_LIMIT_MAX", 120, 100_000);
const RATE_LIMIT_WINDOW_MS = positiveEnv("IOU_RELAY_RATE_LIMIT_WINDOW_MS", 60_000, 60 * 60 * 1000);
const MAX_RATE_CLIENTS = positiveEnv("IOU_RELAY_MAX_RATE_CLIENTS", 10_000, 100_000);
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
let pendingDraftCount = 0;

// OpenChat pairing — KEY-BLIND routing metadata only (OpenChat-user → which IOU
// link token a draft routes to). Never K_sheet, never an IC identity.
//   pairingCodes: short-lived code  → IOU link token (the IOU app starts this)
//   pairings:     OpenChat user id  → IOU link token (claimed by OpenChat)
type Coded = { token: string; created_at: number };
type Pairing = Coded & { last_seen_at: number };
const pairingCodes = new Map<string, Coded>();
const pairings = new Map<string, Pairing>();
const provenanceReplay = new OpenChatReplayGuard();
const mutationRate = new FixedWindowRateLimiter(
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
  MAX_RATE_CLIENTS,
);

function pushDraft(token: string, pending: Pending): boolean {
  if (!canInsertMapKey(store, token, MAX_TOKEN_NAMESPACES)) return false;
  const list = store.get(token) ?? [];
  if (list.length >= MAX_PER_TOKEN) {
    list.shift(); // replace the oldest without growing the global count
  } else {
    if (pendingDraftCount >= MAX_PENDING_DRAFTS) return false;
    pendingDraftCount++;
  }
  list.push(pending);
  store.set(token, list);
  return true;
}

function prune(): void {
  const now = Date.now();
  let retainedDrafts = 0;
  for (const [token, list] of store) {
    const kept = list.filter((p) => now - p.created_at < TTL_MS);
    if (kept.length) {
      store.set(token, kept);
      retainedDrafts += kept.length;
    }
    else store.delete(token);
  }
  pendingDraftCount = retainedDrafts;
  for (const [code, v] of pairingCodes) {
    if (now - v.created_at >= PAIRING_TTL_MS) pairingCodes.delete(code);
  }
  pruneInactivePairings(pairings, now, PAIRING_MAX_AGE_MS);
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function send(res: ServerResponse, code: number, body: unknown): void {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.statusCode = code;
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return readBoundedBody(req, MAX_BODY);
}

function invalidBody(res: ServerResponse, error: unknown): void {
  if (error instanceof BodyTooLargeError) {
    // The reader has paused the request. Close after the bounded 413 response
    // so Node never resumes buffering the unread attacker-controlled tail.
    res.shouldKeepAlive = false;
    res.setHeader("Connection", "close");
    send(res, 413, { error: "request body too large" });
    return;
  }
  send(res, 400, { error: "invalid JSON body" });
}

const validToken = (t: unknown): t is string =>
  typeof t === "string" && t.length >= MIN_TOKEN_LEN && t.length <= 256;

function bearerToken(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== "string" || !value.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length);
  return validToken(token) ? token : null;
}

function allowMutation(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== "POST" && req.method !== "DELETE") return true;
  const client = req.socket.remoteAddress ?? "unknown";
  const outcome = mutationRate.consume(client, Date.now());
  if (outcome.allowed) return true;
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil(outcome.retryAfterMs / 1000))));
  send(res, 429, { error: "mutation rate limit exceeded" });
  return false;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "OPTIONS") return void send(res, 204, {});
  prune();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;
  if (!allowMutation(req, res)) return;

  // POST /v1/drafts  { token, draft }  → store, return { id }
  if (req.method === "POST" && path === "/v1/drafts") {
    let parsed: any;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      invalidBody(res, error);
      return;
    }
    const token = bearerToken(req);
    if (!token) return void send(res, 401, { error: "bearer token required" });
    if (parsed?.draft == null || typeof parsed.draft !== "object")
      return void send(res, 400, { error: "draft must be an object" });
    const pending: Pending = {
      id: randomUUID(), draft: parsed.draft, created_at: Date.now(), source: "connector",
    };
    if (!pushDraft(token, pending)) {
      return void send(res, 429, { error: "relay draft capacity reached" });
    }
    return void send(res, 200, { id: pending.id });
  }

  // GET /v1/drafts?token=...  → { drafts: [{ id, draft, created_at }] }
  if (req.method === "GET" && path === "/v1/drafts") {
    const token = bearerToken(req);
    if (!token) return void send(res, 401, { error: "bearer token required" });
    return void send(res, 200, { drafts: store.get(token) ?? [] });
  }

  // DELETE /v1/drafts/:id?token=...  → clear after the app has written it
  if (req.method === "DELETE" && path.startsWith("/v1/drafts/")) {
    const token = bearerToken(req);
    const id = decodeURIComponent(path.slice("/v1/drafts/".length));
    if (!token) return void send(res, 401, { error: "bearer token required" });
    const list = store.get(token) ?? [];
    const next = list.filter((p) => p.id !== id);
    const removed = list.length - next.length;
    if (next.length) store.set(token, next);
    else store.delete(token);
    pendingDraftCount = Math.max(0, pendingDraftCount - removed);
    return void send(res, 200, { ok: true, removed });
  }

  // --- OpenChat pairing + ingestion (confirmed-draft consumer side) ---

  // POST /v1/pairings/start { token }  → { code, expires_in_ms }
  // The IOU app (which holds the link token) starts a pairing and shows `code`
  // as a short string / QR for the user to give the OpenChat integration.
  if (req.method === "POST" && path === "/v1/pairings/start") {
    const token = bearerToken(req);
    if (!token) return void send(res, 401, { error: "bearer token required" });
    if (pairingCodes.size >= MAX_PAIRING_CODES) {
      return void send(res, 429, { error: "pairing-code capacity reached" });
    }
    const code = randomBytes(16).toString("hex").toUpperCase(); // 128-bit, single-use
    pairingCodes.set(code, { token, created_at: Date.now() });
    return void send(res, 200, { code, expires_in_ms: PAIRING_TTL_MS });
  }

  // POST /v1/pairings/claim { code, oc_token }  → { ok, openchat_user }
  // The OpenChat integration submits the user's pairing code + a provenance
  // token; the relay binds that OpenChat user to the link token.
  if (req.method === "POST" && path === "/v1/pairings/claim") {
    if (!OPENCHAT_PUBKEY) return void send(res, 503, { error: "OpenChat provenance key not configured" });
    let parsed: any;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      invalidBody(res, error);
      return;
    }
    const coded = typeof parsed?.code === "string" ? pairingCodes.get(parsed.code) : undefined;
    if (!coded) return void send(res, 404, { error: "unknown or expired pairing code" });
    const now = Date.now();
    const claims = verifyOpenChatToken(
      String(parsed?.oc_token ?? ""),
      OPENCHAT_PUBKEY,
      now,
      "pairing",
    );
    if (!claims) return void send(res, 401, { error: "invalid OpenChat provenance token" });
    // Check capacity before consuming the one-use provenance token or pairing
    // code, so a legitimate client can retry after an old pairing is pruned.
    if (!canInsertMapKey(pairings, claims.sub, MAX_PAIRINGS)) {
      return void send(res, 429, { error: "pairing capacity reached" });
    }
    if (!provenanceReplay.consume(claims, now)) {
      return void send(res, 401, { error: "replayed OpenChat provenance token" });
    }
    pairings.set(claims.sub, {
      token: coded.token,
      created_at: now,
      last_seen_at: now,
    });
    pairingCodes.delete(parsed.code);
    return void send(res, 200, { ok: true, openchat_user: claims.sub });
  }

  // GET /v1/pairings?token=...  → { pairings: [{ openchat_user, created_at }] }
  if (req.method === "GET" && path === "/v1/pairings") {
    const token = bearerToken(req);
    if (!token) return void send(res, 401, { error: "bearer token required" });
    const list = [...pairings.entries()]
      .filter(([, v]) => v.token === token)
      .map(([sub, v]) => ({ openchat_user: sub, created_at: v.created_at }));
    return void send(res, 200, { pairings: list });
  }

  // DELETE /v1/pairings/:openchat_user?token=...  → revoke a link
  if (req.method === "DELETE" && path.startsWith("/v1/pairings/")) {
    const token = bearerToken(req);
    const sub = decodeURIComponent(path.slice("/v1/pairings/".length));
    if (!token) return void send(res, 401, { error: "bearer token required" });
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
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      invalidBody(res, error);
      return;
    }
    const now = Date.now();
    const claims = verifyOpenChatToken(
      String(parsed?.oc_token ?? ""),
      OPENCHAT_PUBKEY,
      now,
      "draft",
    );
    if (!claims) return void send(res, 401, { error: "invalid OpenChat provenance token" });
    if (!provenanceReplay.consume(claims, now)) {
      return void send(res, 401, { error: "replayed OpenChat provenance token" });
    }
    if (parsed?.draft == null || typeof parsed.draft !== "object")
      return void send(res, 400, { error: "draft must be an object" });
    const coded = pairings.get(claims.sub);
    if (!coded) return void send(res, 409, { error: "OpenChat user not paired to any IOU account" });
    const pending: Pending = {
      id: randomUUID(), draft: parsed.draft, created_at: Date.now(),
      source: "openchat", provenance: { openchat_user: claims.sub },
    };
    if (!pushDraft(coded.token, pending)) {
      return void send(res, 429, { error: "relay draft capacity reached" });
    }
    coded.last_seen_at = now;
    return void send(res, 200, { id: pending.id });
  }

  if (req.method === "GET" && path === "/health") return void send(res, 200, { ok: true });

  send(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: String((e as Error)?.message ?? e) }));
});

server.listen(PORT, HOST, () => {
  // stderr so it never pollutes anything piping stdout
  console.error(`iou-relay listening on http://${HOST}:${PORT} (key-blind; TTL ${TTL_MS}ms)`);
});
