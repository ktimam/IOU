// Client for OpenChat's on-chain action_inbox canister. Replaces the off-chain relay pull: instead of
// GET /v1/drafts, we query the inbox `actions` (keyed by our key fingerprint), verify OpenChat's provenance
// signature (v2 preimage: eph ‖ ct ‖ created_at LE u64), decrypt the envelope with our consumer private key,
// and split the v2 plaintext wrapper into { context, payload } — the payload feeds the exact same
// parseDraft -> openAdd flow the relay path uses; the context carries chat/message provenance.

import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { decryptInboxEnvelope, verifyOpenChatSignature } from "./actionInboxCrypto";
import { loadOrCreateConsumerKeypair, type ConsumerKeypair } from "./consumerKeypair";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IDL = any;

export const actionInboxIdlFactory = ({ IDL: idl }: { IDL: IDL }) => {
  const Args = idl.Record({
    max_results: idl.Nat32,
    consumer_key_fingerprint: idl.Vec(idl.Nat8),
    since_id: idl.Nat64,
  });
  const StoredAction = idl.Record({
    id: idl.Nat64,
    ciphertext: idl.Vec(idl.Nat8),
    ephemeral_public_key: idl.Vec(idl.Nat8),
    created_at: idl.Nat64,
    oc_signature: idl.Vec(idl.Nat8),
  });
  const SuccessResult = idl.Record({ actions: idl.Vec(StoredAction) });
  const Response = idl.Variant({ Success: SuccessResult });
  const Response_1 = idl.Variant({ Success: idl.Text });
  return idl.Service({
    actions: idl.Func([Args], [Response], ["query"]),
    openchat_public_key: idl.Func([idl.Record({})], [Response_1], ["query"]),
  });
};

type RawStoredAction = {
  id: bigint;
  ciphertext: number[] | Uint8Array;
  ephemeral_public_key: number[] | Uint8Array;
  oc_signature: number[] | Uint8Array;
  created_at: bigint;
};

/**
 * Delivery provenance carried by the v2 envelope plaintext wrapper:
 *   { "context": { chat, messageId, confirmedBy, confirmedAt }, "payload": <draft> }
 * chat is OpenChat's canonical chat key ("group:<principal>" or
 * "channel:<community principal>:<channel id>"), messageId a decimal string,
 * confirmedBy the confirming user's principal text, confirmedAt epoch ms.
 */
export type InboxDraftContext = {
  chat: string;
  messageId: string;
  confirmedBy: string;
  confirmedAt: number;
};

export type InboxDraft = {
  id: bigint; // inbox action id (monotonic) — also drives the since_id cursor
  draft: unknown; // decrypted payload (for IOU, the JSON draft parseDraft accepts)
  created_at: bigint;
  context?: InboxDraftContext; // absent for wrapper-less (pre-v2) plaintexts
};

/**
 * Split a decrypted plaintext into { payload, context }. The v2 wrapper is
 * { context: {...}, payload: <draft> }; anything else — including a JSON
 * document without the context/payload shape — is treated as the payload
 * itself (wrapper-less tolerance, so pre-v2 deposits and non-OpenChat
 * producers keep working).
 */
export function parseInboxPlaintext(text: string): { payload: unknown; context?: InboxDraftContext } {
  const doc: unknown = JSON.parse(text);
  if (typeof doc === "object" && doc !== null && !Array.isArray(doc)) {
    const rec = doc as Record<string, unknown>;
    if ("payload" in rec && typeof rec.context === "object" && rec.context !== null && !Array.isArray(rec.context)) {
      const c = rec.context as Record<string, unknown>;
      if (typeof c.chat === "string" && typeof c.messageId === "string") {
        return {
          payload: rec.payload,
          context: {
            chat: c.chat,
            messageId: c.messageId,
            confirmedBy: typeof c.confirmedBy === "string" ? c.confirmedBy : "",
            confirmedAt: typeof c.confirmedAt === "number" ? c.confirmedAt : 0,
          },
        };
      }
      // Malformed context: still honour the wrapper's payload, drop the context.
      return { payload: rec.payload };
    }
  }
  return { payload: doc };
}

export type ActionInboxConfig = {
  canisterId: string;
  host: string; // the IC host serving the inbox (OpenChat's replica / mainnet)
};

async function buildInboxAgent(host: string, identity?: Identity): Promise<HttpAgent> {
  const agent = new HttpAgent({ host, ...(identity ? { identity } : {}) });
  if (host.includes("127.0.0.1") || host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  return agent;
}

function asBytes(v: number[] | Uint8Array): Uint8Array {
  return v instanceof Uint8Array ? v : Uint8Array.from(v);
}

/**
 * Poll the inbox once. Returns decrypted, provenance-verified drafts with `id > sinceId`. Envelopes that fail
 * signature verification or decryption (e.g. not addressed to us) are dropped silently.
 */
export async function pollActionInbox(opts: {
  config: ActionInboxConfig;
  identity?: Identity;
  sinceId?: bigint;
  maxResults?: number;
  keypair?: ConsumerKeypair;
}): Promise<InboxDraft[]> {
  const kp = opts.keypair ?? (await loadOrCreateConsumerKeypair());
  const agent = await buildInboxAgent(opts.config.host, opts.identity);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const actor: any = Actor.createActor(actionInboxIdlFactory, { agent, canisterId: opts.config.canisterId });

  const pubResp = await actor.openchat_public_key({});
  const ocPublicKeyPem: string | undefined = pubResp?.Success;
  if (!ocPublicKeyPem) throw new Error("action_inbox did not return an openchat_public_key");

  const resp = await actor.actions({
    max_results: opts.maxResults ?? 50,
    consumer_key_fingerprint: Array.from(kp.fingerprint),
    since_id: opts.sinceId ?? 0n,
  });
  const stored: RawStoredAction[] = resp?.Success?.actions ?? [];

  const out: InboxDraft[] = [];
  for (const a of stored) {
    const env = {
      ephemeralPublicKey: asBytes(a.ephemeral_public_key),
      ciphertext: asBytes(a.ciphertext),
    };
    // Provenance first: only act on actions OpenChat actually signed. The v2
    // preimage binds created_at (u64 LE), so a tampered timestamp fails here.
    const signed = await verifyOpenChatSignature(env, a.created_at, asBytes(a.oc_signature), ocPublicKeyPem).catch(
      () => false,
    );
    if (!signed) continue;
    try {
      const plaintext = await decryptInboxEnvelope(env, kp.privateKey);
      const { payload, context } = parseInboxPlaintext(new TextDecoder().decode(plaintext));
      out.push({ id: a.id, draft: payload, created_at: a.created_at, ...(context ? { context } : {}) });
    } catch {
      // Not addressed to us (wrong key) or corrupt — skip.
    }
  }
  return out;
}

function readEnv(name: string): string | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proc = (globalThis as any).process;
  if (proc?.env && name in proc.env) return proc.env[name];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (import.meta as any).env;
  if (meta && name in meta) return meta[name];
  return undefined;
}

/** Inbox config from env/localStorage, or null if OpenChat inbox integration isn't configured. */
export function getActionInboxConfig(): ActionInboxConfig | null {
  let canisterId = readEnv("VITE_ACTION_INBOX_CANISTER_ID");
  let host = readEnv("VITE_OPENCHAT_HOST");
  try {
    const raw = globalThis.localStorage?.getItem("iou.openchat.actionInbox.v1");
    if (raw) {
      const cfg = JSON.parse(raw);
      canisterId = cfg.canisterId ?? canisterId;
      host = cfg.host ?? host;
    }
  } catch {
    /* ignore */
  }
  if (!canisterId) return null;
  return { canisterId, host: host ?? "http://127.0.0.1:4943" };
}
