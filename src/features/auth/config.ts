// II + canister configuration. Vite reads VITE_* env vars at build time.

import { DEV_LAN_QC_IC_ORIGIN } from "../../config/devLanQcRuntime";

const network = (import.meta.env.VITE_DFX_NETWORK as string) ?? "local";
const isLocal = network === "local";

// Local replica port. IOU runs its own isolated replica (see dfx.json
// networks.local → 40436) so it doesn't collide with other ICP projects
// on the default 4943; set VITE_DFX_PORT to match.
const port = (import.meta.env.VITE_DFX_PORT as string) ?? "4943";

export const host = isLocal
  ? (DEV_LAN_QC_IC_ORIGIN ?? `http://127.0.0.1:${port}`)
  : "https://icp-api.io";

// `.localhost` (not `.127.0.0.1`) so the browser resolves the II canister
// subdomain — Chrome maps *.localhost → 127.0.0.1, but not *.127.0.0.1.
export const internetIdentityUrl = isLocal
  ? `http://${import.meta.env.VITE_II_CANISTER_ID ?? "rdmx6-jaaaa-aaaaa-aaadq-cai"}.localhost:${port}`
  : "https://identity.ic0.app";

export const canisterId =
  (import.meta.env.VITE_IOU_BACKEND_CANISTER_ID as string) ?? "iou_backend";
