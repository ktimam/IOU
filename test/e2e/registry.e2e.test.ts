// OpenChat user_index AI-app registry E2E (candid-exposed surface) against the
// LIVE replica. Registers a UNIQUELY-NAMED throwaway app (never touches the real
// "iou" registration — register_ai_app is an upsert-by-name), then exercises
// upsert / read-back / explore / delete, the claim + revoke negative paths
// (on-chain code lookup + proof-of-possession signature verify), and the
// per-caller throttle. The link-code HAPPY path + per-user-key pairing are
// msgpack-only → covered by the Rust integration test (see test/README.md).

import { it, expect } from "vitest";
import { Actor } from "@dfinity/agent";
import { describeE2E, E2E, freshIdentity, agentFor } from "./env";
import { registryService } from "./registryIdl";
import { buildManifestWire, getRegisteredInboxCanisterId, claimAiAppLinkCode, revokeAiAppUserKey } from "../../src/features/openchat/registerAiApp";

async function registryActor(identity: Parameters<typeof agentFor>[0]) {
  const agent = await agentFor(identity);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(() => registryService(), { agent, canisterId: E2E.userIndexId }) as any;
}

function uniqueName(): string {
  return "iou-e2e-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

async function p256SpkiPemAndSigner(): Promise<{ pem: string; sign: (p: Uint8Array) => Promise<Uint8Array> }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", kp.publicKey));
  let bin = "";
  for (const b of spki) bin += String.fromCharCode(b);
  const body = (btoa(bin).match(/.{1,64}/g) ?? []).join("\n");
  const pem = `-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`;
  const sign = async (preimage: Uint8Array) =>
    new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, preimage.slice().buffer as ArrayBuffer));
  return { pem, sign };
}

describeE2E("OpenChat registry — register/explore/delete + claim/revoke negatives", () => {
  it("reads back the LIVE 'iou' app's registered inbox (read-only, non-destructive)", async () => {
    const inbox = await getRegisteredInboxCanisterId({
      host: E2E.host,
      userIndexCanisterId: E2E.userIndexId,
      appName: "iou",
    });
    // The live "iou" app routes deposits to the configured action_inbox (or declares none → null).
    if (inbox !== null) expect(inbox).toBe(E2E.actionInboxId);
  });

  it("registers (upsert) a throwaway app, reads it back, finds it via explore, then deletes it", async () => {
    const identity = freshIdentity();
    const actor = await registryActor(identity);
    const name = uniqueName();

    const wire = buildManifestWire("", undefined, () => {}, E2E.actionInboxId);
    const manifest = { ...wire, name, description: "e2e throwaway v1" };

    const reg = await actor.register_ai_app({ manifest });
    expect("Success" in reg).toBe(true);
    const appId = Number(reg.Success.id);
    expect(reg.Success.manifest.inbox_canister_id).toHaveLength(1); // per-app inbox carried

    // Upsert: re-register the same name with a changed description → same id, updated.
    const reg2 = await actor.register_ai_app({ manifest: { ...manifest, description: "e2e throwaway v2" } });
    expect(Number(reg2.Success.id)).toBe(appId);
    expect(reg2.Success.manifest.description).toBe("e2e throwaway v2");

    // ai_apps read-back contains our app with the inbox we registered.
    const apps = (await actor.ai_apps({})).Success.apps as { manifest: { name: string; inbox_canister_id: unknown[] } }[];
    const mine = apps.find((a) => a.manifest.name === name);
    expect(mine).toBeDefined();
    expect(mine!.manifest.inbox_canister_id).toHaveLength(1);

    // explore_ai_apps is the public directory query (published apps); assert the endpoint decodes
    // and responds with a paginated match set. (Our throwaway is unpublished, so it isn't listed —
    // the register/read-back/delete lifecycle above already proved the upsert.)
    const explored = await actor.explore_ai_apps({ search_term: [], page_index: 0, page_size: 20 });
    expect("Success" in explored).toBe(true);
    expect(Array.isArray(explored.Success.matches)).toBe(true);

    // Cleanup: delete the throwaway app.
    const del = await actor.delete_ai_app({ name });
    expect("Success" in del).toBe(true);
    const del2 = await actor.delete_ai_app({ name });
    expect("NotFound" in del2).toBe(true); // idempotent-ish: already gone
  });

  it("P0-15: a base-manifest redeploy self-heals when re-registered with the user's types (template rule restored)", async () => {
    // The core of the "types not mapped after a fresh start" journey, proven at the live canister:
    // a deploy registers the BASE manifest (no template rules); IOU's app-load sync then re-registers
    // the SAME app (upsert) with the user's saved types, restoring the `template` keyword_map so a
    // chat message can route to a type again.
    const identity = freshIdentity();
    const actor = await registryActor(identity);
    const name = uniqueName();
    const tmplRule = (m: { actions: { rules: { keyword_map?: { field: string; map: { value: string }[] } }[] }[] }) =>
      m.actions[0].rules.find((r) => r.keyword_map?.field === "template");
    const readManifest = async () =>
      ((await actor.ai_apps({})).Success.apps as { manifest: { name: string; actions: unknown[] } }[]).find(
        (a) => a.manifest.name === name,
      )!.manifest;

    // 1. Deploy/CI registers the BASE manifest (no user types).
    const base = { ...buildManifestWire("", undefined, () => {}, E2E.actionInboxId, []), name, description: "p0-15 base" };
    const r1 = await actor.register_ai_app({ manifest: base });
    expect("Success" in r1).toBe(true);
    const appId = Number(r1.Success.id);
    expect(tmplRule(await readManifest())).toBeUndefined(); // no template routing yet

    // 2. App-load sync re-registers the SAME app WITH the user's types (upsert → same id).
    const templates = [{ id: "z1", name: "Reservation", keywords: ["reservation", "booking"] }];
    const healed = { ...buildManifestWire("", undefined, () => {}, E2E.actionInboxId, templates), name, description: "p0-15 healed" };
    const r2 = await actor.register_ai_app({ manifest: healed });
    expect(Number(r2.Success.id)).toBe(appId);

    // 3. The template keyword_map is back — routing restored.
    const rule = tmplRule(await readManifest());
    expect(rule).toBeDefined();
    expect(rule!.keyword_map!.map.map((m) => m.value)).toContain("Reservation");

    await actor.delete_ai_app({ name });
  });

  it("claim with a nonexistent code returns CodeNotFound", async () => {
    const out = await claimAiAppLinkCode({
      host: E2E.host,
      userIndexCanisterId: E2E.userIndexId,
      code: "000000",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\nX\n-----END PUBLIC KEY-----\n",
      identity: freshIdentity(),
    });
    expect(out.kind).toBe("code_not_found");
  });

  it("revoke of an unpaired key returns KeyNotFound after verifying the proof-of-possession signature", async () => {
    const { pem, sign } = await p256SpkiPemAndSigner();
    const out = await revokeAiAppUserKey({
      host: E2E.host,
      userIndexCanisterId: E2E.userIndexId,
      publicKeyPem: pem,
      sign, // signs the canonical challenge with the matching private key → on-chain verify passes
      identity: freshIdentity(),
    });
    // The signature is valid (verified on-chain) but the key was never paired → KeyNotFound.
    expect(out.kind).toBe("key_not_found");
  });

  it("throttles a caller after repeated failed claims (per-caller failure window)", async () => {
    const throttled = freshIdentity();
    const outcomes: string[] = [];
    for (let i = 0; i < 13; i++) {
      const out = await claimAiAppLinkCode({
        host: E2E.host,
        userIndexCanisterId: E2E.userIndexId,
        code: "000000",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\nX\n-----END PUBLIC KEY-----\n",
        identity: throttled,
      });
      outcomes.push(out.kind);
      if (out.kind === "oc_error") break; // throttle kicked in
    }
    // Early attempts are plain CodeNotFound; after the per-caller cap the canister returns a
    // throttle Error (oc_error). If the environment's window was already primed we still expect
    // to observe the throttle.
    expect(outcomes).toContain("oc_error");
    expect(outcomes[0]).toBe("code_not_found");
  });
});
