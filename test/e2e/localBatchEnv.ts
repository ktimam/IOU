// Explicit local-only environment for IOU batch acceptance. No OpenChat actor,
// retired ActionInbox, browser credential, implicit .env target or skip fallback.
import { Actor, HttpAgent, type Identity } from "@dfinity/agent";
import { Ed25519KeyIdentity } from "@dfinity/identity";
import { describe } from "vitest";
import { idlFactory } from "../../src/backend/declarations";
import { createLocalBatchFetch, resolveLocalBatchE2eTarget } from "../../src/security/localBatchE2ePolicy";

const target = resolveLocalBatchE2eTarget(process.env);
const localFetch = createLocalBatchFetch(target.host);
const response = await localFetch(`${target.host}/api/v2/status`, { signal: AbortSignal.timeout(5_000) });
if (response.status !== 200) throw new Error("Required local IOU replica is unavailable; batch test not skipped.");

export const describeE2E = describe;
export const freshIdentity = () => Ed25519KeyIdentity.generate();
export async function iouActor(identity: Identity) {
  const agent = new HttpAgent({ host: target.host, identity, fetch: localFetch });
  await agent.fetchRootKey(); // Only the explicitly constrained loopback replica.
  return Actor.createActor(idlFactory, { agent, canisterId: target.canisterId });
}
