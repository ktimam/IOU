import {
  resolveDevLanQcOrigin,
  resolveDevLanQcIdentityOrigin,
  shouldFetchRootKeyForNetwork,
} from "./devLanQc";

const viteEnvironment = import.meta.env ?? {};
const nodeEnvironment =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export const DFX_NETWORK =
  (viteEnvironment.VITE_DFX_NETWORK as string | undefined) ??
  nodeEnvironment.VITE_DFX_NETWORK ??
  "local";

/**
 * One deliberately narrow switch for physical-device local QC. Vite does not expose it to or use
 * it in production (`import.meta.env.DEV` is false there), even if a stale shell variable exists.
 */
export const DEV_LAN_QC_IC_ORIGIN = resolveDevLanQcOrigin(
  (viteEnvironment.VITE_IC_URL as string | undefined) ?? nodeEnvironment.VITE_IC_URL,
  {
    isDevelopment:
      viteEnvironment.DEV === true || nodeEnvironment.NODE_ENV === "development",
    dfxNetwork: DFX_NETWORK,
  },
);

/** A new testing origin does not migrate the previous origin's IOU session or identity. */
export const DEV_LAN_QC_II_ORIGIN = resolveDevLanQcIdentityOrigin(
  (viteEnvironment.VITE_IOU_LAN_QC_II_ORIGIN as string | undefined) ??
    nodeEnvironment.VITE_IOU_LAN_QC_II_ORIGIN,
  {
    // An explicitly production Vite build always wins over a stale development shell.
    isDevelopment:
      viteEnvironment.DEV === true ||
      (viteEnvironment.DEV === undefined && nodeEnvironment.NODE_ENV === "development"),
    dfxNetwork: DFX_NETWORK,
  },
);

export function shouldFetchLocalRootKey(): boolean {
  return shouldFetchRootKeyForNetwork(DFX_NETWORK);
}
