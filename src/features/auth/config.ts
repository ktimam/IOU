// II + canister configuration. Vite reads VITE_* env vars at build time.

const network = (import.meta.env.VITE_DFX_NETWORK as string) ?? "local";
const isLocal = network === "local";

export const host = isLocal
  ? "http://127.0.0.1:4943"
  : "https://icp-api.io";

export const internetIdentityUrl = isLocal
  ? `http://${import.meta.env.VITE_II_CANISTER_ID ?? "rdmx6-jaaaa-aaaaa-aaadq-cai"}.127.0.0.1:4943`
  : "https://identity.ic0.app";

export const canisterId =
  (import.meta.env.VITE_IOU_BACKEND_CANISTER_ID as string) ?? "iou_backend";
