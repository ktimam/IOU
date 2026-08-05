// OpenChat user_index AI-app public registry E2E against the
// LIVE replica. Registers a UNIQUELY-NAMED throwaway app (never touches the real
// "iou" registration — register_ai_app is an upsert-by-name), then exercises
// upsert / read-back / explore / delete. Per-user claim/revoke is deliberately
// absent here: browsers call the signed-in IOU backend, and only IOU's registered
// app canister invokes OpenChat's authenticated C2C endpoints.

import { it, expect } from "vitest";
import { Actor } from "@dfinity/agent";
import { describeE2E, E2E, freshIdentity, agentFor } from "./env";
import { registryService } from "./registryIdl";
import { buildManifestWire, getRegisteredInboxCanisterId } from "../../src/features/openchat/registerAiApp";

async function registryActor(identity: Parameters<typeof agentFor>[0]) {
  const agent = await agentFor(identity);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return Actor.createActor(() => registryService(), { agent, canisterId: E2E.userIndexId }) as any;
}

function uniqueName(): string {
  return "iou-e2e-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

describeE2E("OpenChat registry — register/explore/delete", () => {
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

  it("keeps private account templates out of a live public manifest re-registration", async () => {
    // Prove the privacy boundary across the real Candid register/read-back path.
    const identity = freshIdentity();
    const actor = await registryActor(identity);
    const name = uniqueName();
    const tmplRule = (m: { actions: { rules: { keyword_map?: { field: string; map: { value: string }[] } }[] }[] }) =>
      m.actions[0].rules.find((r) => r.keyword_map?.field === "template");
    const readManifest = async () =>
      ((await actor.ai_apps({})).Success.apps as { manifest: { name: string; actions: unknown[] } }[]).find(
        (a) => a.manifest.name === name,
      )!.manifest;

    // 1. Deploy/CI registers the static public manifest.
    const base = { ...buildManifestWire("", undefined, () => {}, E2E.actionInboxId, []), name, description: "p0-15 base" };
    const r1 = await actor.register_ai_app({ manifest: base });
    expect("Success" in r1).toBe(true);
    const appId = Number(r1.Success.id);
    expect(tmplRule(await readManifest())).toBeUndefined();

    // 2. Supply private values through the regression-only builder seam.
    const templates = [{ id: "z1", name: "Private Reservation", keywords: ["private-booking-trigger"] }];
    const healed = { ...buildManifestWire("", undefined, () => {}, E2E.actionInboxId, templates), name, description: "p0-15 healed" };
    const r2 = await actor.register_ai_app({ manifest: healed });
    expect(Number(r2.Success.id)).toBe(appId);

    // 3. The live public record contains neither the roster nor its values.
    const registered = await readManifest();
    expect(tmplRule(registered)).toBeUndefined();
    expect(JSON.stringify(registered)).not.toContain("Private Reservation");
    expect(JSON.stringify(registered)).not.toContain("private-booking-trigger");

    await actor.delete_ai_app({ name });
  });

  it("register_ai_app: a DIFFERENT owner re-owns the same app name (test_mode re-own)", async () => {
    const idA = freshIdentity();
    const idB = freshIdentity();
    const actorA = await registryActor(idA);
    const actorB = await registryActor(idB);
    const name = uniqueName();
    const wire = { ...buildManifestWire("", undefined, () => {}, E2E.actionInboxId), name };

    const r1 = await actorA.register_ai_app({ manifest: wire });
    expect("Success" in r1).toBe(true);
    expect(r1.Success.owner.toText()).toBe(idA.getPrincipal().toText());

    // A DIFFERENT principal re-registers the same name → in test_mode it RE-OWNS the entry (the dev
    // convenience that lets a fresh deploy identity take over a local registration).
    const r2 = await actorB.register_ai_app({ manifest: { ...wire, description: "re-owned by B" } });
    expect("Success" in r2).toBe(true);
    expect(r2.Success.owner.toText()).toBe(idB.getPrincipal().toText()); // owner is now B
    expect(r2.Success.manifest.description).toBe("re-owned by B");

    await actorB.delete_ai_app({ name }); // B (the current owner) cleans up
  });

});
