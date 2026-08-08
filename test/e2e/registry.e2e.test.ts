// OpenChat user_index AI-app public registry E2E against the LIVE replica.
// This suite is deliberately read-only apart from rejected registration attempts:
// a standalone test-mode principal may update only an existing app it owns and
// must never allocate an app id or take over another owner's registration.

import { it, expect } from "vitest";
import { Actor } from "@dfinity/agent";
import { Principal } from "@dfinity/principal";
import { describeE2E, E2E, freshIdentity, agentFor, iouActor } from "./env";
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

const STANDALONE_UPDATE_ONLY_MESSAGE = "standalone local registrar may update only its existing app";

describeE2E("OpenChat registry — read-only public access and ownership boundaries", () => {
  it("reads back the LIVE 'iou' app's registered inbox (read-only, non-destructive)", async () => {
    const inbox = await getRegisteredInboxCanisterId({
      host: E2E.host,
      userIndexCanisterId: E2E.userIndexId,
      appName: "iou",
    });
    // The live "iou" app routes deposits to the configured action_inbox (or declares none → null).
    if (inbox !== null) expect(inbox).toBe(E2E.actionInboxId);
  });

  it("does not let a fresh standalone identity allocate an app", async () => {
    const identity = freshIdentity();
    const actor = await registryActor(identity);
    const name = uniqueName();
    const wire = buildManifestWire("", undefined, () => {}, E2E.actionInboxId);
    const manifest = { ...wire, name, description: "e2e throwaway v1" };

    const reg = await actor.register_ai_app({ manifest });
    expect(reg).toEqual({ InvalidRequest: STANDALONE_UPDATE_ONLY_MESSAGE });

    const apps = (await actor.ai_apps({})).Success.apps as { manifest: { name: string; inbox_canister_id: unknown[] } }[];
    expect(apps.some((app) => app.manifest.name === name)).toBe(false);
  });

  it("keeps private account templates out of the deployed public iou manifest", async () => {
    const identity = freshIdentity();
    const actor = await registryActor(identity);
    const tmplRule = (m: { actions: { rules: { keyword_map?: { field: string; map: { value: string }[] } }[] }[] }) =>
      m.actions.flatMap((action) => action.rules).find((rule) => rule.keyword_map?.field === "template");

    const explored = await actor.explore_ai_apps({ search_term: ["iou"], page_index: 0, page_size: 8 });
    expect("Success" in explored).toBe(true);
    const registration = explored.Success.matches.find(
      (app: { manifest: { name: string } }) => app.manifest.name === "iou",
    );
    expect(registration).toBeDefined();
    const manifest = registration!.manifest;
    expect(tmplRule(manifest)).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain("Family expense");
  });

  it("vouches only for the exact owner of the published iou registration", async () => {
    const identity = freshIdentity();
    const registry = await registryActor(identity);
    const explored = await registry.explore_ai_apps({ search_term: ["iou"], page_index: 0, page_size: 8 });
    expect("Success" in explored).toBe(true);
    const registration = explored.Success.matches.find(
      (app: { manifest: { name: string } }) => app.manifest.name === "iou",
    );
    expect(registration).toBeDefined();
    const owner = registration!.owner as Principal;
    const iou = await iouActor(identity);

    const approved = await iou.c2c_verify_ai_app({ name: "iou", owner });
    expect(approved.vouched).toBe(true);
    expect(approved.name).toEqual(["iou"]);
    expect(approved.owner).toHaveLength(1);
    expect(approved.owner[0].toText() === owner.toText()).toBe(true);

    const anonymousOwner = await iou.c2c_verify_ai_app({ name: "iou", owner: Principal.anonymous() });
    expect(anonymousOwner.vouched).toBe(false);

    const wrongName = await iou.c2c_verify_ai_app({ name: "IOU", owner });
    expect(wrongName.vouched).toBe(false);
  });

  it("does not let a fresh standalone identity take over the canonical iou app", async () => {
    const actor = await registryActor(freshIdentity());
    const manifest = { ...buildManifestWire("", undefined, () => {}, E2E.actionInboxId), name: "iou" };

    const result = await actor.register_ai_app({ manifest });
    expect(result).toEqual({ InvalidRequest: STANDALONE_UPDATE_ONLY_MESSAGE });
  });
});
