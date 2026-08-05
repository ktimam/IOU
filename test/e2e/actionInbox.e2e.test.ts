// action_inbox replicated-update surface E2E against a LIVE inbox canister. This proves
// UserIndex exposes the dedicated v4 action-signing keyring and an exact-match
// actions(selector, since_id) update returns [] for an unaddressed opaque selector. It does not
// prove the complete confirmation/deposit/verify/decrypt/import/ack chain; that remains a
// Linux PocketIC and disposable live-upgrade release gate documented in test/README.md.

import { it, expect } from "vitest";
import { Actor } from "@dfinity/agent";
import { describeE2E, E2E, agentFor, freshIdentity } from "./env";
import {
  actionInboxIdlFactory,
  pollActionInbox,
  userIndexActionSigningKeysIdlFactory,
} from "../../src/features/openchat/actionInboxClient";
import { actionSigningKeyId } from "../../src/features/openchat/actionInboxCrypto";
import { bytesToHex, generateConsumerKeys } from "../../src/features/openchat/ecTestKit";

async function inboxActor() {
  const agent = await agentFor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(actionInboxIdlFactory, { agent, canisterId: E2E.actionInboxId }) as any;
}

async function userIndexActor() {
  const agent = await agentFor();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(userIndexActionSigningKeysIdlFactory, { agent, canisterId: E2E.userIndexId }) as any;
}

async function activeActionSigningKeyId(): Promise<string> {
  const response = await (await userIndexActor()).action_signing_keys({});
  expect(response?.Success?.signature_version).toBe(4);
  expect(response?.Success?.purpose).toBe("action_inbox_deposit");
  const active = response.Success.keys.find((key: { status: Record<string, unknown> }) => "Active" in key.status);
  expect(active).toBeTruthy();
  expect(bytesToHex(await actionSigningKeyId(active.public_key_pem))).toBe(bytesToHex(Uint8Array.from(active.key_id)));
  return bytesToHex(Uint8Array.from(active.key_id));
}

describeE2E("action_inbox — live query surface", () => {
  it("exposes a self-consistent dedicated v4 action-signing keyring from UserIndex", async () => {
    expect(await activeActionSigningKeyId()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns [] for a fresh, unaddressed fingerprint (exact-match keyed, no error on miss)", async () => {
    const actor = await inboxActor();
    const selector = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const resp = await actor.actions({
      max_results: 50,
      consumer_key_fingerprint: Array.from(selector),
      since_id: 0n,
    });
    expect("Success" in resp).toBe(true);
    expect(resp.Success.actions).toEqual([]);
  });

  it("pollActionInbox drives the full verify+decrypt path and yields no drafts for a fresh key", async () => {
    const kp = await generateConsumerKeys();
    const signingKeyId = await activeActionSigningKeyId();
    const drafts = await pollActionInbox({
      config: {
        canisterId: E2E.actionInboxId,
        appId: 0,
        consumerKeySelector: globalThis.crypto.getRandomValues(new Uint8Array(32)),
        userIndexCanisterId: E2E.userIndexId,
        host: E2E.host,
        signingKeyIds: [signingKeyId],
      },
      identity: freshIdentity(),
      keypair: { privateKey: kp.privateKey, fingerprint: kp.fingerprint } as never,
    });
    expect(drafts).toEqual([]);
  });

  it("two distinct fingerprints are isolated buckets (both empty for fresh keys)", async () => {
    const actor = await inboxActor();
    const a = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const b = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const [ra, rb] = await Promise.all([
      actor.actions({ max_results: 50, consumer_key_fingerprint: Array.from(a), since_id: 0n }),
      actor.actions({ max_results: 50, consumer_key_fingerprint: Array.from(b), since_id: 0n }),
    ]);
    expect(ra.Success.actions).toEqual([]);
    expect(rb.Success.actions).toEqual([]);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
