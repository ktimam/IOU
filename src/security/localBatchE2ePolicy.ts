import { Principal } from "@dfinity/principal";

/** The batch acceptance test may create only isolated data on an explicit local target. */
export function resolveLocalBatchE2eTarget(env: Record<string, string | undefined>) {
  if (env.IOU_BATCH_E2E_ALLOW_WRITES !== "1") {
    throw new Error("Local batch E2E requires IOU_BATCH_E2E_ALLOW_WRITES=1 for isolated test data.");
  }
  const host = env.IOU_BATCH_E2E_HOST;
  if (!host) throw new Error("Local batch E2E requires an explicit IOU_BATCH_E2E_HOST.");
  const url = new URL(host);
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (host !== url.origin && host !== `${url.origin}/`)
  ) {
    throw new Error("Local batch E2E target must be a canonical HTTP loopback origin, without credentials or a path.");
  }
  const canisterId = env.IOU_BATCH_E2E_CANISTER_ID;
  if (!canisterId || Principal.fromText(canisterId).toText() !== canisterId ||
    canisterId === "aaaaa-aa" || canisterId === "2vxsx-fae") {
    throw new Error("Local batch E2E requires an explicit canonical IOU canister ID.");
  }
  return Object.freeze({ host: url.origin, canisterId });
}

/** Agent and readiness requests share the same local-only, no-redirect transport. */
export function createLocalBatchFetch(host: string, fetchImpl: typeof fetch = fetch): typeof fetch {
  return (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== host) throw new Error("Batch test request left the explicit local origin.");
    return fetchImpl(input, { ...options, redirect: "error" });
  };
}
