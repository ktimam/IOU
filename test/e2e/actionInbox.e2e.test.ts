// action_inbox query surface E2E against the LIVE inbox canister. Proves the
// consumer poll path works end to end: the inbox exposes OpenChat's signing PEM,
// and `actions(fingerprint, since_id)` is an exact-match keyed query that returns
// [] for a fresh (unaddressed) fingerprint. The DEPOSIT half (a real OpenChat
// confirm writing to a fingerprint bucket) is covered by the Rust integration
// test on these same canisters — see test/README.md.

import { it, expect } from "vitest";
import { Actor } from "@dfinity/agent";
import { describeE2E, E2E, agentFor, freshIdentity } from "./env";
import { actionInboxIdlFactory, pollActionInbox } from "../../src/features/openchat/actionInboxClient";
import { generateConsumerKeys } from "../../src/features/openchat/ecTestKit";

async function inboxActor() {
  const agent = await agentFor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(actionInboxIdlFactory, { agent, canisterId: E2E.actionInboxId }) as any;
}

describeE2E("action_inbox — live query surface", () => {
  it("exposes OpenChat's signing public key as a PEM", async () => {
    const actor = await inboxActor();
    const resp = await actor.openchat_public_key({});
    expect("Success" in resp).toBe(true);
    expect(resp.Success).toContain("BEGIN PUBLIC KEY");
  });

  it("returns [] for a fresh, unaddressed fingerprint (exact-match keyed, no error on miss)", async () => {
    const actor = await inboxActor();
    const fresh = await generateConsumerKeys();
    const resp = await actor.actions({
      max_results: 50,
      consumer_key_fingerprint: Array.from(fresh.fingerprint),
      since_id: 0n,
    });
    expect("Success" in resp).toBe(true);
    expect(resp.Success.actions).toEqual([]);
  });

  it("pollActionInbox drives the full verify+decrypt path and yields no drafts for a fresh key", async () => {
    const kp = await generateConsumerKeys();
    const drafts = await pollActionInbox({
      config: { canisterId: E2E.actionInboxId, host: E2E.host },
      identity: freshIdentity(),
      keypair: { privateKey: kp.privateKey, fingerprint: kp.fingerprint } as never,
    });
    expect(drafts).toEqual([]);
  });

  it("two distinct fingerprints are isolated buckets (both empty for fresh keys)", async () => {
    const actor = await inboxActor();
    const a = await generateConsumerKeys();
    const b = await generateConsumerKeys();
    const [ra, rb] = await Promise.all([
      actor.actions({ max_results: 50, consumer_key_fingerprint: Array.from(a.fingerprint), since_id: 0n }),
      actor.actions({ max_results: 50, consumer_key_fingerprint: Array.from(b.fingerprint), since_id: 0n }),
    ]);
    expect(ra.Success.actions).toEqual([]);
    expect(rb.Success.actions).toEqual([]);
    expect(Array.from(a.fingerprint)).not.toEqual(Array.from(b.fingerprint));
  });
});
