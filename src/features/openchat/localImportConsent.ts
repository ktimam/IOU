import { createLocalImportNonce, isLocalImportId, type LocalImportEvent } from "./localImportHandoff";

export const LOCAL_IMPORT_CONSENT_MS = 2 * 60_000;
export const LOCAL_IMPORT_CONNECTION_MS = 10 * 60_000;

type Candidate = Readonly<{ senderOrigin: string; connectionId: string }>;
export type LocalImportConsentState =
  | Readonly<{ kind: "waiting"; expiresAtMs: number }>
  | Readonly<{ kind: "pending"; candidate: Candidate; expiresAtMs: number }>
  | Readonly<{ kind: "connected"; candidate: Candidate; expiresAtMs: number }>
  | Readonly<{ kind: "closed" }>;

export type LocalImportConnected = Readonly<{
  type: "oc:app-import:connected";
  version: 1;
  connectionId: string;
  sessionNonce: string;
}>;

/** This is an eligible address for a USER decision, never an allowlist or proof of app identity. */
export function nativeLocalImportSenderOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^http:\/\/localhost:[1-9][0-9]{3,4}$/.test(value)) return undefined;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return url.origin === value && url.hostname === "localhost" && Number.isInteger(port) &&
      port >= 1024 && port <= 65535 ? value : undefined;
  } catch { return undefined; }
}

function connectId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !["type", "version", "connectionId"].every(key => keys.includes(key))) return undefined;
  const fields = ["type", "version", "connectionId"].map(key => Object.getOwnPropertyDescriptor(value, key));
  if (fields.some(field => !field?.enumerable || !("value" in field))) return undefined;
  return fields[0]!.value === "oc:app-import:connect" && fields[1]!.value === 1 && isLocalImportId(fields[2]!.value)
    ? fields[2]!.value : undefined;
}

/**
 * Metadata-only native bootstrap. Capture the opener once, before any message. The public
 * connection ID is correlation, NOT authority. Receiving connect never creates a receiver,
 * reveals a nonce, queues a payload, sends a reply, or grants trust to other localhost ports.
 * Only the IOU-owned explicit Allow handler may call approve(). No persistence or network.
 */
export function createLocalImportConsent(options: {
  senderWindow: MessageEventSource;
  now?: () => number;
  nonce?: () => string;
}) {
  const senderWindow = options.senderWindow;
  const nonce = options.nonce ?? createLocalImportNonce;
  if (!senderWindow) throw new Error("Missing local sender window");
  const now = options.now ?? Date.now;
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || !Number.isSafeInteger(startedAt + LOCAL_IMPORT_CONNECTION_MS)) {
    throw new Error("Invalid local connection time");
  }
  let state: LocalImportConsentState = Object.freeze({ kind: "waiting", expiresAtMs: startedAt + LOCAL_IMPORT_CONSENT_MS });
  const close = () => { state = Object.freeze({ kind: "closed" }); };
  const current = (): LocalImportConsentState => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < startedAt || (state.kind !== "closed" && time >= state.expiresAtMs)) close();
    return state;
  };
  return Object.freeze({
    state: current,
    receive(event: LocalImportEvent): LocalImportConsentState {
      const before = current();
      if ((before.kind !== "waiting" && before.kind !== "pending") || event.source !== senderWindow) return before;
      const senderOrigin = nativeLocalImportSenderOrigin(event.origin);
      let connectionId: string | undefined;
      try { connectionId = connectId(event.data); } catch { return before; }
      if (!senderOrigin || !connectionId) return before;
      if (before.kind === "pending") {
        // Never silently replace what the user is reviewing, including when the opener navigates.
        if (before.candidate.senderOrigin !== senderOrigin || before.candidate.connectionId !== connectionId) close();
      } else {
        state = Object.freeze({ kind: "pending", candidate: Object.freeze({ senderOrigin, connectionId }), expiresAtMs: before.expiresAtMs });
      }
      return current();
    },
    approve(): { binding: { senderWindow: MessageEventSource; senderOrigin: string; sessionNonce: string }; reply: LocalImportConnected } | undefined {
      const before = current();
      if (before.kind !== "pending") return undefined;
      let sessionNonce: string;
      try { sessionNonce = nonce(); } catch (error) { close(); throw error; }
      if (!isLocalImportId(sessionNonce)) { close(); throw new Error("Invalid receiver nonce"); }
      if (current() !== before) return undefined;
      state = Object.freeze({ kind: "connected", candidate: before.candidate, expiresAtMs: startedAt + LOCAL_IMPORT_CONNECTION_MS });
      return {
        binding: Object.freeze({ senderWindow, senderOrigin: before.candidate.senderOrigin, sessionNonce }),
        reply: Object.freeze({ type: "oc:app-import:connected", version: 1, connectionId: before.candidate.connectionId, sessionNonce }),
      };
    },
    isConnected: () => current().kind === "connected",
    close,
  });
}
