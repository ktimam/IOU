// Keep IOU's static public OpenChat manifest current for participating users.
// Private account template names and keywords never enter this module.

import type { Identity } from "@dfinity/agent";
import { OC_LINKED_KEY, OC_CONNECTED_KEY } from "./ocConfig";

export type ManifestSyncState = {
  myPrincipal: string;
  /** localStorage OC_LINKED_KEY — set by the explicit "Link to OpenChat" action. */
  linkedPrincipal: string | null;
  /** This user completed the claim-token Connect (has a registered per-user delivery key). */
  connected: boolean;
};

/** Sync when the user participates in OpenChat at all: connected via claim-token Connect OR linked. */
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
 * state, decides whether to sync and, if so, invokes `register`. Errors
 * are swallowed into "error" (a slow/unreachable user_index must never block
 * connect). `register` is injected so this stays pure/testable — callers pass the real registerAiApp
 * wrapper. Returns "skipped" when the user doesn't participate in OpenChat (nothing to sync).
 */
export async function maybeSyncManifest(
  identity: Identity | undefined,
  register: (identity: Identity) => Promise<{ ok: boolean }>,
  state?: ManifestSyncState,
): Promise<ManifestSyncResult> {
  if (!identity) return "skipped";
  const st = state ?? readManifestSyncState(identity.getPrincipal().toText());
  if (!shouldSyncOpenChatManifest(st)) return "skipped";
  try {
    const r = await register(identity);
    return r.ok ? "synced" : "error";
  } catch {
    return "error";
  }
}
