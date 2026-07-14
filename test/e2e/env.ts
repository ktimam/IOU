// E2E environment resolution + gating.
//
// Reads the LIVE canister ids from .env.local (IOU + OpenChat) and the OpenChat
// dfx canister_ids.json (local_user_index), checks the replica is reachable, and
// exposes a `describeE2E` that SKIPS the whole suite with a clear message when the
// local environment isn't up — so `pnpm test:e2e` is safe to run anywhere.
//
// Never hardcodes ids: everything comes from .env.local / canister_ids.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe } from "vitest";
import { HttpAgent, Actor, type Identity } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { webcrypto } from "node:crypto";
import { idlFactory as iouIdlFactory } from "../../src/backend/declarations";

// Node < 20 has no global WebCrypto; the crypto helpers need it.
if (!(globalThis as unknown as { crypto?: Crypto }).crypto) {
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

function parseDotEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].trim();
    }
  } catch {
    /* file missing — leave empty, resolve() reports it */
  }
  return out;
}

function readOpenChatCanisterIds(): Record<string, string> {
  // Override via OC_CANISTER_IDS_JSON; default to the sibling open-chat-cycle worktree.
  const p =
    process.env.OC_CANISTER_IDS_JSON ??
    path.resolve(REPO_ROOT, "..", "Blockchain", "ICP", "open-chat-cycle", ".dfx", "local", "canister_ids.json");
  try {
    const json = JSON.parse(readFileSync(p, "utf8")) as Record<string, { local?: string }>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(json)) if (v?.local) out[k] = v.local;
    return out;
  } catch {
    return {};
  }
}

export type E2EConfig = {
  up: boolean;
  reason: string;
  host: string;
  iouBackendId: string;
  userIndexId: string;
  actionInboxId: string;
  localUserIndexId?: string;
};

async function reachable(host: string): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(`${host}/api/v2/status`, { signal: ctl.signal });
    clearTimeout(t);
    return res.ok || res.status === 200;
  } catch {
    return false;
  }
}

async function resolve(): Promise<E2EConfig> {
  const env = parseDotEnv(path.join(REPO_ROOT, ".env.local"));
  const oc = readOpenChatCanisterIds();
  const host = env.VITE_OPENCHAT_HOST || "http://127.0.0.1:8080";
  const iouBackendId = env.VITE_IOU_BACKEND_CANISTER_ID || "";
  const userIndexId = env.VITE_OC_USER_INDEX_CANISTER_ID || oc.user_index || "";
  const actionInboxId = env.VITE_ACTION_INBOX_CANISTER_ID || "";
  const localUserIndexId = oc.local_user_index;

  const missing: string[] = [];
  if (!iouBackendId) missing.push("VITE_IOU_BACKEND_CANISTER_ID");
  if (!userIndexId) missing.push("VITE_OC_USER_INDEX_CANISTER_ID");
  if (!actionInboxId) missing.push("VITE_ACTION_INBOX_CANISTER_ID");
  if (missing.length) {
    return { up: false, reason: `.env.local missing ${missing.join(", ")}`, host, iouBackendId, userIndexId, actionInboxId, localUserIndexId };
  }
  if (!(await reachable(host))) {
    return { up: false, reason: `replica not reachable at ${host}`, host, iouBackendId, userIndexId, actionInboxId, localUserIndexId };
  }
  return { up: true, reason: "ok", host, iouBackendId, userIndexId, actionInboxId, localUserIndexId };
}

export const E2E: E2EConfig = await resolve();

if (!E2E.up) {
  // eslint-disable-next-line no-console
  console.warn(`\n[e2e] SKIPPING E2E suite: ${E2E.reason}\n[e2e] Bring the local env up (see test/README.md) and re-run \`pnpm test:e2e\`.\n`);
}

/** describe that runs only when the local env is up; otherwise the whole block skips cleanly. */
export const describeE2E = E2E.up ? describe : describe.skip;

export function freshIdentity(): Ed25519KeyIdentity {
  return Ed25519KeyIdentity.generate();
}

export async function agentFor(identity?: Identity): Promise<HttpAgent> {
  const agent = new HttpAgent({ host: E2E.host, ...(identity ? { identity } : {}) });
  await agent.fetchRootKey();
  return agent;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function iouActor(identity: Identity): Promise<any> {
  const agent = await agentFor(identity);
  return Actor.createActor(iouIdlFactory, { agent, canisterId: E2E.iouBackendId });
}

/** Candid opt helper: [] | [T]. */
export function optVal<T>(o: [] | [T]): T | null {
  return o.length ? o[0] : null;
}
