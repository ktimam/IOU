// IOU ↔ OpenChat connector bot (off-chain).
//
// THE BRIDGE. OpenChat's ActionCard (PR-B) confirm flow forwards to a bot
// endpoint: POST {endpoint}/notify, raw body, header `x-oc-signature` = ES256
// over the body (notification_pusher/pusher.rs). This bot:
//   1. verifies `x-oc-signature` against OpenChat's PUBLIC key (ocVerify.ts),
//   2. parses the confirmed ActionCard event (rows + responded_by + action_id),
//   3. maps the rows → an IOU draft (rowsToDraft.ts),
//   4. forwards it to the IOU relay (/v1/openchat/drafts), routed by pairing.
//
// Trust boundary: OpenChat → bot is authenticated by OpenChat's ES256 key; the
// bot → relay hop reuses the relay's own provenance (the bot holds the relay
// signing key). The bot never holds K_sheet or an IOU identity. The encrypted
// write still happens in the IOU app on Accept.
//
// Run:  IOU_OPENCHAT_PUBKEY_FILE=… IOU_RELAY_SIGNING_KEY_FILE=… \
//       IOU_RELAY_URL=http://127.0.0.1:8788 pnpm exec tsx scripts/iou-openchat-bot/server.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createPrivateKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyOcSignature } from "./ocVerify";
import { rowsToDraft, type ActionCardRow } from "./rowsToDraft";
import { signOpenChatToken } from "../iou-relay/openchatAuth";

const PORT = Number(process.env.IOU_OC_BOT_PORT ?? 8790);
const RELAY = (process.env.IOU_RELAY_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "");
const ACTION_ID = process.env.IOU_OC_ACTION_ID ?? "iou.entry.import";
const MAX_BODY = 256 * 1024;

function readEnvKey(inline?: string, file?: string): string {
  if (inline) return inline;
  if (file) { try { return readFileSync(file, "utf8"); } catch { /* fall through */ } }
  return "";
}
const OC_PUBKEY = readEnvKey(process.env.IOU_OPENCHAT_PUBKEY, process.env.IOU_OPENCHAT_PUBKEY_FILE);
const RELAY_SIGNING_PEM = readEnvKey(process.env.IOU_RELAY_SIGNING_KEY, process.env.IOU_RELAY_SIGNING_KEY_FILE);

// Expected (JSON) shape of a confirmed ActionCard notification. SEAM: the real
// notification body is OpenChat's msgpack/candid `BotEventPayload` for the
// `MessageActionCardResponse` event; in production decode it with the
// open-chat-bots SDK against PR-B's finalized schema. The fields below are the
// stable contract (design doc §5/§8): action_id, response, responder, rows.
type ConfirmedActionCard = {
  kind: "action_card_response";
  action_id: string;
  response: "Confirm" | "Cancel";
  responded_by: string; // the OpenChat user id who confirmed (provenance subject)
  rows: ActionCardRow[];
};

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};

/** Forward a confirmed draft to the IOU relay, routed by the OpenChat user. */
async function forwardToRelay(responded_by: string, draft: unknown): Promise<number> {
  const now = Date.now();
  const ocToken = signOpenChatToken(
    { sub: responded_by, iat: now, exp: now + 60_000 },
    createPrivateKey(RELAY_SIGNING_PEM),
  );
  const r = await fetch(`${RELAY}/v1/openchat/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oc_token: ocToken, draft }),
  });
  return r.status;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });

  // OpenChat forwards confirmed ActionCards here.
  if (req.method === "POST" && (req.url === "/notify" || req.url === "/")) {
    const body = await readBody(req);

    // 1. authenticate the forward against OpenChat's public key
    const sig = String(req.headers["x-oc-signature"] ?? "");
    if (!OC_PUBKEY) return json(res, 503, { error: "OpenChat public key not configured" });
    if (!sig || !verifyOcSignature(body, sig, OC_PUBKEY)) {
      return json(res, 401, { error: "invalid x-oc-signature" });
    }

    // 2. parse the confirmed ActionCard event (JSON seam; see type note above)
    let evt: ConfirmedActionCard;
    try {
      evt = JSON.parse(body.toString("utf8"));
    } catch {
      return json(res, 400, { error: "unparsable event body" });
    }
    if (evt.kind !== "action_card_response" || evt.action_id !== ACTION_ID) {
      return json(res, 202, { ignored: "not our action" });
    }
    if (evt.response !== "Confirm") return json(res, 200, { ok: true, ignored: evt.response });

    // 3. rows → IOU draft
    const draft = rowsToDraft(evt.rows ?? []);
    if (!draft) return json(res, 422, { error: "could not build a draft from rows" });

    // 4. forward to the IOU relay (routed by pairing for evt.responded_by)
    if (!RELAY_SIGNING_PEM) return json(res, 503, { error: "relay signing key not configured" });
    const status = await forwardToRelay(evt.responded_by, draft);
    return json(res, status === 200 ? 200 : 502, { forwarded: status });
  }

  json(res, 404, { error: "not found" });
}

createServer((req, res) => {
  handle(req, res).catch((e) => json(res, 500, { error: String((e as Error)?.message ?? e) }));
}).listen(PORT, () => {
  console.error(
    `iou-openchat-bot on :${PORT} → relay ${RELAY} (action ${ACTION_ID}); ` +
      `oc-pubkey ${OC_PUBKEY ? "set" : "MISSING"}, relay-key ${RELAY_SIGNING_PEM ? "set" : "MISSING"}`,
  );
});
