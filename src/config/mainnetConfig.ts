import { Principal } from "@dfinity/principal";

export const MAINNET_IC_HOST = "https://icp-api.io";
export const MAINNET_IDENTITY_URL = "https://identity.ic0.app";
const LOCAL_BACKEND_CANISTER_ID = "uxrrr-q7777-77774-qaaaq-cai";

export type MainnetConfig = {
  host: string;
  internetIdentityUrl: string;
  canisterId: string;
};

/** Validate configuration, not deployment existence (which requires a separate IC check). */
export function requireMainnetCanisterId(value: unknown): string {
  const message =
    "VITE_IOU_BACKEND_CANISTER_ID must be an explicit canonical opaque mainnet backend canister principal (not a user identity, anonymous, management, or the local fallback)";
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    throw new Error(message);
  }
  let principal: Principal;
  try {
    principal = Principal.fromText(value);
  } catch {
    throw new Error(message);
  }
  const principalBytes = principal.toUint8Array();
  if (
    principal.toText() !== value ||
    principal.isAnonymous() ||
    principalBytes[principalBytes.length - 1] !== 1 ||
    value === LOCAL_BACKEND_CANISTER_ID
  ) {
    throw new Error(message);
  }
  return value;
}

/** Shared by Vite's build preflight and the browser/Node actor configuration. */
export function resolveMainnetConfig(
  env: Readonly<Record<string, unknown>>,
): MainnetConfig | undefined {
  if (env.VITE_DFX_NETWORK !== "ic") return undefined;

  const canisterId = requireMainnetCanisterId(env.VITE_IOU_BACKEND_CANISTER_ID);
  if (env.VITE_IOU_PROD_VETKD !== "1") {
    throw new Error("VITE_IOU_PROD_VETKD must be 1 for VITE_DFX_NETWORK=ic");
  }

  for (const name of [
    "VITE_DFX_PORT",
    "VITE_IOU_LAN_QC_II_ORIGIN",
    "VITE_IOU_LAN_QC_OPENCHAT_ORIGIN",
  ]) {
    if (env[name] !== undefined && env[name] !== "") {
      throw new Error(`${name} is a local development override and must be unset for mainnet`);
    }
  }
  for (const name of ["IOU_HOST", "VITE_IC_URL", "VITE_OC_IC_URL", "VITE_OPENCHAT_HOST"]) {
    if (env[name] !== undefined && env[name] !== "" && env[name] !== MAINNET_IC_HOST) {
      throw new Error(`${name} must be unset or ${MAINNET_IC_HOST} for mainnet`);
    }
  }
  if (
    env.VITE_II_CANISTER_ID !== undefined &&
    env.VITE_II_CANISTER_ID !== "" &&
    env.VITE_II_CANISTER_ID !== "rdmx6-jaaaa-aaaaa-aaadq-cai"
  ) {
    throw new Error("VITE_II_CANISTER_ID must be unset or the mainnet Internet Identity canister ID");
  }

  return { host: MAINNET_IC_HOST, internetIdentityUrl: MAINNET_IDENTITY_URL, canisterId };
}
