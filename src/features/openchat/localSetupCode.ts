import { decryptSetupCode, deriveSetupCode, encryptSetupCode } from "./appSetupCodeCrypto";
import { parseLocalSetupContextV2, serializeLocalSetupResultV2, type LocalSetupContextV2 } from "./localAppSetupV2";

type Result<T> = { Ok: T } | { Err: string };
type Blob = Uint8Array | number[];
export type SetupCodeActor = {
  claim_app_setup_code(id: string, proof: Uint8Array): Promise<Result<{ encrypted_context: Blob; expires_at_ms: bigint }>>;
  complete_app_setup_code(id: string, proof: Uint8Array, result: Uint8Array): Promise<Result<{ expires_at_ms: bigint }>>;
};
export type LocalSetupCodeSession = Readonly<{
  context: LocalSetupContextV2;
  clientOrigin: string;
  expiresAtMs: number;
  isCurrent(): boolean;
  close(): void;
  sendResult(json: string): Promise<void>;
}>;
const TTL = 10 * 60_000;
function invalid(): never { throw new Error("This connection code could not be verified. Copy a fresh code from OpenChat."); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function ok<T>(value: Result<T>): T {
  if (!value || Object.keys(value).length !== 1 || !("Ok" in value)) invalid();
  return value.Ok;
}
function bytes(value: Blob): Uint8Array {
  if ((!Array.isArray(value) && !(value instanceof Uint8Array)) || value.length < 28 || value.length > 1024 * 1024 + 28 ||
    Array.from(value).some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) invalid();
  return Uint8Array.from(value);
}
function clientOrigin(value: unknown): string {
  if (typeof value !== "string") invalid();
  const url = new URL(value);
  // Informational, supplied by the requesting client; not proof of its identity.
  if (url.origin !== value || url.username || url.password || (url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "tauri.localhost"].includes(url.hostname)))) invalid();
  return value;
}

/** A pasted high-entropy code grants only this short-lived setup exchange, not sign-in or entry access. */
export async function claimLocalSetupCode(options: {
  code: string; actor: SetupCodeActor; setupUrl: string; assertCurrent(): void; now?: () => number;
}): Promise<LocalSetupCodeSession> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let code = options.code.trim();
  const derived = await deriveSetupCode(code);
  options.assertCurrent();
  const claimed = ok(await options.actor.claim_app_setup_code(derived.requestId, derived.claimSecret));
  options.assertCurrent();
  const expiresAtMs = Number(claimed.expires_at_ms);
  if (typeof claimed.expires_at_ms !== "bigint" || !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= now() || expiresAtMs > startedAt + TTL) invalid();
  const request: unknown = JSON.parse(await decryptSetupCode(code, "context", bytes(claimed.encrypted_context)));
  options.assertCurrent();
  exact(request, ["version", "appId", "setupUrl", "clientOrigin", "expiresAtMs", "setupContext"]);
  if (request.version !== 1 || request.appId !== "iou" || request.setupUrl !== options.setupUrl || request.expiresAtMs !== expiresAtMs) invalid();
  const context = parseLocalSetupContextV2(request.setupContext);
  const origin = clientOrigin(request.clientOrigin);
  let closed = false, completed = false;
  let prepared: { json: string; ciphertext: Promise<Uint8Array> } | undefined;
  let sending: Promise<void> | undefined;
  const isCurrent = () => {
    try { options.assertCurrent(); return !closed && !completed && now() >= startedAt && now() < expiresAtMs; }
    catch { return false; }
  };
  const check = () => { if (!isCurrent()) invalid(); };
  return Object.freeze({ context, clientOrigin: origin, expiresAtMs, isCurrent,
    close() { closed = true; code = ""; derived.claimSecret.fill(0); },
    sendResult(json: string): Promise<void> {
      check();
      // Retain the exact ciphertext across an unknown response; do not regenerate grants, IVs or routes.
      if (prepared && prepared.json !== json) invalid();
      if (!prepared) {
        serializeLocalSetupResultV2(context, JSON.parse(json));
        prepared = { json, ciphertext: encryptSetupCode(code, "result", JSON.stringify({
          version: 1, appId: "iou", setupUrl: options.setupUrl, requestId: derived.requestId, catalogJson: json,
        })) };
      }
      if (sending) return sending;
      const ciphertext = prepared.ciphertext;
      const operation = (async () => {
        const encrypted = await ciphertext; check();
        const receipt = ok(await options.actor.complete_app_setup_code(derived.requestId, derived.claimSecret, encrypted));
        check();
        if (receipt.expires_at_ms !== claimed.expires_at_ms) invalid();
        completed = true; code = ""; derived.claimSecret.fill(0);
      })();
      sending = operation;
      void operation.finally(() => { if (sending === operation) sending = undefined; }).catch(() => undefined);
      return operation;
    },
  });
}
