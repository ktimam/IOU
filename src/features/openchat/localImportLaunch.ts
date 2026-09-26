import { isLocalImportId } from "./localImportHandoff";

let sessionNonce: string | undefined;

/** The URL carries only a non-secret handshake nonce, never an entry or account identifier. */
export function captureLocalImportLaunch(target: Pick<Window, "location" | "history"> = window): void {
  if (target.location.pathname !== "/openchat/import") return;
  const fragment = new URLSearchParams(target.location.hash.slice(1));
  const nonce = fragment.get("sessionNonce");
  sessionNonce = fragment.size === 1 && isLocalImportId(nonce) ? nonce : undefined;
  target.history.replaceState(target.history.state, "", target.location.pathname);
}

export function localImportSessionNonce(): string | undefined { return sessionNonce; }

/** Initial local-only prototype allowlist. Never learn a trusted sender from incoming messages. */
export function localImportSenderOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.origin === value && url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? value : undefined;
  } catch { return undefined; }
}
