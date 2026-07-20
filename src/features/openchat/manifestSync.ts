// Keep the REGISTERED OpenChat manifest in lock-step with a user's saved transaction types. Each
// type's trigger words become a `template` keyword_map entry in the manifest so a chat message that
// matches routes to that type.
//
// The recurring "my types aren't mapped after a fresh start" bug lived in the SYNC DECISION + its
// timing. IOU only synced when the user had explicitly tapped "Link to OpenChat" (OC_LINKED_KEY),
// on a type EDIT. But:
//   - people commonly do only the 6-digit "Connect" (claim_ai_app_link_code), which never sets that
//     flag — so a connect-only user stayed on the deploy's BASE manifest (no template rules);
//   - a fresh deploy re-registers the base manifest, and nothing re-synced on app LOAD, so even a
//     linked user's existing types silently dropped until their next edit.
//
// The correct rule: sync whenever the user PARTICIPATES in OpenChat (connected OR linked), and do it
// on connect, on a type change, AND once on app load.

import type { Identity } from "@dfinity/agent";
import type { ManifestTemplate } from "./actionManifest";
import { OC_LINKED_KEY, OC_CONNECTED_KEY } from "./ocConfig";

export type ManifestSyncState = {
  myPrincipal: string;
  /** localStorage OC_LINKED_KEY — set by the explicit "Link to OpenChat" action. */
  linkedPrincipal: string | null;
  /** This user completed the 6-digit Connect (has a registered per-user delivery key). */
  connected: boolean;
};

/** Sync when the user participates in OpenChat at all: connected via the 6-digit Connect OR linked. */
export function shouldSyncOpenChatManifest(state: ManifestSyncState): boolean {
  return state.connected || state.linkedPrincipal === state.myPrincipal;
}

type LocalStorageLike = { getItem(key: string): string | null } | null | undefined;

function lsGet(ls: LocalStorageLike, key: string): string | null {
  try {
    return ls?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Read the OpenChat participation state for `myPrincipal` from localStorage (injectable for tests). */
export function readManifestSyncState(
  myPrincipal: string,
  ls: LocalStorageLike = (globalThis as { localStorage?: LocalStorageLike }).localStorage,
): ManifestSyncState {
  return {
    myPrincipal,
    linkedPrincipal: lsGet(ls, OC_LINKED_KEY),
    connected: lsGet(ls, OC_CONNECTED_KEY) === myPrincipal,
  };
}

/** Result of a sync attempt — distinguishes "we decided not to" from "we tried and it failed". */
export type ManifestSyncResult = "synced" | "skipped" | "error";

/**
 * The single decision-and-fire point for a manifest (re)registration. Given the user's participation
 * state, decides whether to sync and, if so, invokes `register` with their CURRENT templates. Errors
 * are swallowed into "error" (a slow/unreachable user_index must never block a template save or a
 * connect). `register` is injected so this stays pure/testable — callers pass the real registerAiApp
 * wrapper. Returns "skipped" when the user doesn't participate in OpenChat (nothing to sync).
 */
export async function maybeSyncManifest(
  identity: Identity | undefined,
  templates: ManifestTemplate[],
  register: (identity: Identity, templates: ManifestTemplate[]) => Promise<{ ok: boolean }>,
  state?: ManifestSyncState,
): Promise<ManifestSyncResult> {
  if (!identity) return "skipped";
  const st = state ?? readManifestSyncState(identity.getPrincipal().toText());
  if (!shouldSyncOpenChatManifest(st)) return "skipped";
  try {
    const r = await register(identity, templates);
    return r.ok ? "synced" : "error";
  } catch {
    return "error";
  }
}
