// Client for OpenChat's on-chain action_inbox canister. Replaces the off-chain relay pull: instead of
// GET /v1/drafts, we query the inbox `actions` (keyed by our key fingerprint), verify OpenChat's provenance
// signature, decrypt the envelope with our consumer private key, and yield the plaintext draft — which feeds
// the exact same parseDraft -> openAdd flow the relay path uses.

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

export type InboxDraft = {
  id: bigint; // inbox action id (monotonic) — also drives the since_id cursor
  draft: unknown; // decrypted plaintext (for IOU, the JSON draft parseDraft accepts)
  created_at: bigint;
};

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
    // Provenance first: only act on actions OpenChat actually signed.
    const signed = await verifyOpenChatSignature(env, asBytes(a.oc_signature), ocPublicKeyPem).catch(() => false);
    if (!signed) continue;
    try {
      const plaintext = await decryptInboxEnvelope(env, kp.privateKey);
      out.push({ id: a.id, draft: JSON.parse(new TextDecoder().decode(plaintext)), created_at: a.created_at });
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
