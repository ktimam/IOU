import { parseLocalSetupContextV2, serializeLocalSetupResultV2, type LocalSetupContextV2, type LocalSetupResultV2 } from "./localAppSetupV2";

const CONNECTION_ID = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export const LOCAL_APP_SETUP_MS = 10 * 60_000;
export type LocalAppSetupBinding = Readonly<{ senderOrigin: string; connectionId: string; appId: string; setupContext?: LocalSetupContextV2 }>;
export type LocalAppSetupState =
  | Readonly<{ kind: "waiting" }>
  | Readonly<{ kind: "pending"; binding: LocalAppSetupBinding; expiresAtMs: number }>
  | Readonly<{ kind: "shared" | "closed" }>;

function senderOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      ? value : undefined;
  } catch { return undefined; }
}

/** A request is only a visible consent candidate, never authority to read or share private setup. */
export function createLocalAppSetupConsent(options: { opener: MessageEventSource; appId: string; now?: () => number }) {
  const { opener, appId } = options;
  if (!opener || !appId) throw new Error("Missing setup requester binding");
  const now = options.now ?? Date.now;
  let state: LocalAppSetupState = Object.freeze({ kind: "waiting" });
  let startedAt: number | undefined;
  const close = () => { state = Object.freeze({ kind: "closed" }); };
  const current = (): LocalAppSetupState => {
    if (state.kind === "pending") {
      const time = now();
      if (!Number.isSafeInteger(time) || time < startedAt! || time >= state.expiresAtMs) close();
    }
    return state;
  };
  return Object.freeze({
    state: current,
    close,
    receive(event: Pick<MessageEvent, "source" | "origin" | "data">): LocalAppSetupState {
      const prior = current();
      if (!["waiting", "pending"].includes(prior.kind) || event.source !== opener) return prior;
      try {
        const message: unknown = event.data;
        if (!message || typeof message !== "object" || Array.isArray(message) ||
          ![null, Object.prototype].includes(Object.getPrototypeOf(message))) return prior;
        const keys = Reflect.ownKeys(message);
        if (![4, 5].includes(keys.length) || !["type", "version", "connectionId", "appId"].every(key => keys.includes(key)) ||
          keys.some(key => typeof key !== "string" || !["type", "version", "connectionId", "appId", "setupContext"].includes(key))) return prior;
        const fields = ["type", "version", "connectionId", "appId"].map(key => Object.getOwnPropertyDescriptor(message, key));
        if (fields.some(field => !field?.enumerable || !("value" in field))) return prior;
        const [type, version, connectionId, requestedApp] = fields.map(field => field!.value);
        const origin = senderOrigin(event.origin);
        if (type !== "oc:app-setup:connect" || (version !== 1 && version !== 2) || requestedApp !== appId ||
          typeof connectionId !== "string" || !CONNECTION_ID.test(connectionId) || !origin) return prior;
        const contextField = Object.getOwnPropertyDescriptor(message, "setupContext");
        if (version === 1 ? contextField !== undefined : !contextField?.enumerable || !("value" in contextField)) return prior;
        const setupContext = version === 2 ? parseLocalSetupContextV2(contextField!.value) : undefined;
        if (prior.kind === "pending") {
          if (prior.binding.senderOrigin !== origin || prior.binding.connectionId !== connectionId ||
            JSON.stringify(prior.binding.setupContext) !== JSON.stringify(setupContext)) close();
        } else {
          const time = now();
          if (!Number.isSafeInteger(time) || time < 0 || !Number.isSafeInteger(time + LOCAL_APP_SETUP_MS)) { close(); return state; }
          startedAt = time;
          state = Object.freeze({ kind: "pending", binding: Object.freeze({ senderOrigin: origin, connectionId, appId,
            ...(setupContext ? { setupContext } : {}) }), expiresAtMs: time + LOCAL_APP_SETUP_MS });
        }
      } catch { return prior; }
      return current();
    },
    isCurrent(binding: LocalAppSetupBinding): boolean {
      const active = current();
      return active.kind === "pending" && active.binding === binding;
    },
    cancel(binding: LocalAppSetupBinding) {
      const active = current();
      if (active.kind !== "pending" || active.binding !== binding) throw new Error("Setup connection expired or changed");
      // Consume before posting so a late async approval cannot race cancellation.
      close();
      return Object.freeze({ type: "oc:app-setup:cancel" as const, version: binding.setupContext ? 2 as const : 1 as const,
        connectionId: binding.connectionId, appId });
    },
    approve(binding: LocalAppSetupBinding, catalogJson: string) {
      const active = current();
      if (active.kind !== "pending" || active.binding !== binding) throw new Error("Setup connection expired or changed");
      if (typeof catalogJson !== "string" || !catalogJson || new TextEncoder().encode(catalogJson).byteLength > 1024 * 1024) {
        throw new Error("Setup catalog exceeds the client limit");
      }
      if (binding.setupContext) serializeLocalSetupResultV2(binding.setupContext, JSON.parse(catalogJson) as LocalSetupResultV2);
      // Consume before posting; an unknown transport outcome is never an automatic retry.
      state = Object.freeze({ kind: "shared" });
      return Object.freeze({ type: "oc:app-setup:result" as const, version: binding.setupContext ? 2 as const : 1 as const,
        connectionId: binding.connectionId, appId, catalogJson });
    },
  });
}
