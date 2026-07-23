// IOU glue for the manifest-sync decision (manifestSync.ts): the concrete "register the IOU manifest
// for this user with these types" call, gated on the user actually participating in OpenChat. Types
// are ACCOUNT-SCOPED, so every caller feeds it SLOT-sourced types (loadAllSharedTemplates across all
// the user's accounts — each account's chat routes through this user's manifest): usePairTemplates
// (after every slot publish, i.e. on type CRUD), ManifestTypesSync (once on app load), and
// ActionInboxSettings (on a successful Connect). Keeping this separate lets manifestSync.ts stay
// pure/unit-tested.

import type { Identity } from "@dfinity/agent";
import { registerAiApp } from "./registerAiApp";
import type { ManifestTemplate } from "./actionManifest";
import { invalidateInboxCache } from "./actionInboxClient";
import { OC_ACTION_INBOX_CANISTER_ID, OC_IC_URL, OC_USER_INDEX_CANISTER_ID } from "./ocConfig";
import { canisterId as iouBackendCanisterId } from "../auth/config";
import { maybeSyncManifest } from "./manifestSync";

async function registerIouManifest(
  identity: Identity,
  templates: ManifestTemplate[],
): Promise<{ ok: boolean }> {
  const outcome = await registerAiApp({
    host: OC_IC_URL,
    // Guarded by the OC_USER_INDEX_CANISTER_ID check in syncManifestWithTypes before we get here.
    userIndexCanisterId: OC_USER_INDEX_CANISTER_ID as string,
    consumerPublicKeyPem: "",
    // Our own backend canister so OpenChat can verify us at publish (c2c_verify_ai_app).
    appCanisterId: iouBackendCanisterId,
    // Preserve IOU's per-app inbox override on this upsert; dropping it makes deposits NotConfigured.
    inboxCanisterId: OC_ACTION_INBOX_CANISTER_ID,
    identity,
    templates,
  });
  return { ok: outcome.kind === "success" };
}

/**
 * Re-register the IOU manifest with the user's CURRENT types IF they participate in OpenChat
 * (connected via the 6-digit Connect OR explicitly linked). Fire-and-forget safe — errors are
 * swallowed by maybeSyncManifest. On a real re-register, drop the inbox resolver cache so the next
 * poll picks up any changed routing.
 */
export async function syncManifestWithTypes(
  identity: Identity | undefined,
  templates: ManifestTemplate[],
): Promise<void> {
  if (!identity || !OC_USER_INDEX_CANISTER_ID) return;
  const res = await maybeSyncManifest(identity, templates, registerIouManifest);
  if (res === "synced") invalidateInboxCache();
}
