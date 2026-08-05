// Compatibility seam for callers that historically refreshed the public OpenChat manifest.
// Registration is deployment-owned; private account templates never enter the public wire.

import type { Identity } from "@dfinity/agent";

/**
 * Retained for existing callers. End-user identities must never register or mutate the
 * deployment-wide public manifest; deployment tooling owns that operation.
 */
export async function syncOpenChatManifest(_identity: Identity | undefined): Promise<void> {
  // The public manifest is deployment-owned. Per-user key claims do not mutate it.
}
