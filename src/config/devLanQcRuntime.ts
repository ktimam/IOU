import {
  resolveDevLanQcOrigin,
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

export function shouldFetchLocalRootKey(): boolean {
  return shouldFetchRootKeyForNetwork(DFX_NETWORK);
}
