import { canisterId, host } from "../auth/config";

export const ANONYMOUS_STORAGE_PRINCIPAL = "anonymous";

/** A browser cache must never be reusable by another IOU deployment. */
export function currentDeploymentScope(): string {
  return `${host}|${canisterId}`;
}

/** Build a localStorage key isolated by both deployment and authenticated principal. */
export function scopedStorageKey(
  namespace: string,
  principal: string | null | undefined,
  deployment = currentDeploymentScope(),
): string {
  const owner = principal?.trim() || ANONYMOUS_STORAGE_PRINCIPAL;
  return `${namespace}:${encodeURIComponent(deployment)}:${encodeURIComponent(owner)}`;
}
