import { Principal } from "@dfinity/principal";

export const AUTH_LOGOUT_CHANNEL = "iou:auth:sign-out:v1";
export type AuthLogoutSignal = { version: 1; principal: string; nonce: string };

/** Notifications contain only an account identifier, never delegation or key material. */
export function readAuthLogoutSignal(value: unknown): AuthLogoutSignal | undefined {
  try {
    const signal = (typeof value === "string" ? JSON.parse(value) : value) as Partial<AuthLogoutSignal> | null;
    if (!signal || signal.version !== 1 || typeof signal.principal !== "string" ||
      typeof signal.nonce !== "string" || signal.nonce.length < 1 || signal.nonce.length > 128 ||
      Principal.fromText(signal.principal).toText() !== signal.principal) return;
    return signal as AuthLogoutSignal;
  } catch { return; }
}
