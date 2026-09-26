import { isLocalImportId } from "./localImportHandoff";

let sessionNonce: string | undefined;
let nativeBootstrap = false;

/** The URL carries only a non-secret handshake nonce, never an entry or account identifier. */
export function captureLocalImportLaunch(target: Pick<Window, "location" | "history"> = window): void {
  sessionNonce = undefined;
  nativeBootstrap = false;
  if (target.location.pathname !== "/openchat/import") return;
  // A plain URL permits only a metadata/consent prompt, never an authorized sender. Malformed
  // fragments or query parameters must not fall back to native bootstrap after URL scrubbing.
  nativeBootstrap = !target.location.hash && !target.location.search;
  const fragment = new URLSearchParams(target.location.hash.slice(1));
  const nonce = fragment.get("sessionNonce");
  sessionNonce = fragment.size === 1 && isLocalImportId(nonce) ? nonce : undefined;
  target.history.replaceState(target.history.state, "", target.location.pathname);
}

export function localImportSessionNonce(): string | undefined { return sessionNonce; }
export function localImportNativeBootstrap(): boolean { return nativeBootstrap; }

/** Initial local-only prototype allowlist. Never learn a trusted sender from incoming messages. */
export function localImportSenderOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? value : undefined;
  } catch { return undefined; }
}
