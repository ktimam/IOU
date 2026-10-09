import { Principal } from "@dfinity/principal";
import { localDeliveryBase64Url } from "./localImportEncryption";

export const LOCAL_SETUP_MAX_BYTES = 1024 * 1024;
export const LOCAL_SETUP_MAX_ROUTES = 32;
const HANDLE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
export type LocalSetupRoute = Readonly<{ handle: string; catalogJson: string }>;
export type LocalSetupContextV2 =
  | Readonly<{ version: 2; scope: "account"; accountId?: string; routes: readonly LocalSetupRoute[]; legacyCatalogJson?: string }>
  | Readonly<{ version: 2; scope: "chat"; accountId: string; handle: string; catalogJson?: string }>;
export type LocalSetupResultV2 = Readonly<{
  version: 2; scope: "account" | "chat"; appId: "iou"; accountId: string;
  catalogJson: string; routes: readonly LocalSetupRoute[];
}>;

function invalid(): never { throw new Error("Invalid app setup context"); }
function exact(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key !== "string" || ![...required, ...optional].includes(key)) ||
    required.some(key => !Object.hasOwn(descriptors, key)) ||
    Object.values(descriptors).some(field => !field.enumerable || !("value" in field))) invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, field]) => [key, field.value]));
}
function handle(value: unknown): string { if (typeof value !== "string" || !HANDLE.test(value)) invalid(); return value; }
function catalog(value: unknown): string {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).byteLength > LOCAL_SETUP_MAX_BYTES) invalid();
  return value;
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LOCAL_SETUP_MAX_BYTES) invalid();
  return value;
}
function routes(value: unknown): readonly LocalSetupRoute[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > LOCAL_SETUP_MAX_ROUTES ||
    Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const seen = new Set<string>();
  const output: LocalSetupRoute[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = Object.getOwnPropertyDescriptor(value, String(index));
    if (!field?.enumerable || !("value" in field)) invalid();
    const row = exact(field.value, ["handle", "catalogJson"]), id = handle(row.handle);
    if (seen.has(id)) invalid(); seen.add(id);
    output.push(Object.freeze({ handle: id, catalogJson: catalog(row.catalogJson) }));
  }
  return Object.freeze(output);
}
/** Metadata only. No chat coordinates, messages, model output or delivery actions. */
export function parseLocalSetupContextV2(value: unknown): LocalSetupContextV2 {
  const row = exact(value, ["version", "scope"], ["accountId", "routes", "handle", "catalogJson", "legacyCatalogJson"]);
  if (row.version !== 2) invalid();
  if (row.scope === "account") {
    if (Object.hasOwn(row, "handle") || Object.hasOwn(row, "catalogJson") || !Object.hasOwn(row, "routes")) invalid();
    return bounded(Object.freeze({ version: 2, scope: "account",
      ...(Object.hasOwn(row, "accountId") ? { accountId: handle(row.accountId) } : {}),
      routes: routes(row.routes),
      ...(Object.hasOwn(row, "legacyCatalogJson") ? { legacyCatalogJson: catalog(row.legacyCatalogJson) } : {}),
    }));
  }
  if (row.scope !== "chat" || Object.hasOwn(row, "routes") || Object.hasOwn(row, "legacyCatalogJson")) invalid();
  return bounded(Object.freeze({ version: 2, scope: "chat", accountId: handle(row.accountId), handle: handle(row.handle),
    ...(Object.hasOwn(row, "catalogJson") ? { catalogJson: catalog(row.catalogJson) } : {}),
  }));
}
export function serializeLocalSetupResultV2(context: LocalSetupContextV2, value: LocalSetupResultV2): string {
  const row = exact(value, ["version", "scope", "appId", "accountId", "catalogJson", "routes"]);
  if (row.version !== 2 || row.scope !== context.scope || row.appId !== "iou" ||
    (context.accountId !== undefined && context.accountId !== row.accountId)) invalid();
  const checked = { version: 2, scope: context.scope, appId: "iou", accountId: handle(row.accountId),
    catalogJson: catalog(row.catalogJson), routes: routes(row.routes) };
  const expected = context.scope === "account" ? context.routes.map(route => route.handle) : [context.handle];
  if (checked.routes.length !== expected.length || expected.some(id => !checked.routes.some(route => route.handle === id))) invalid();
  return JSON.stringify(bounded(checked));
}
/** Stable opaque app account identity; independent of sheet, delivery key, nonce and device. */
export async function localSetupAccountId(input: { principal: string; backendHost: string; backendCanisterId: string }): Promise<string> {
  for (const value of [input.principal, input.backendCanisterId]) {
    const p = Principal.fromText(value);
    if (p.toText() !== value || p.isAnonymous() || value === "aaaaa-aa") invalid();
  }
  const host = new URL(input.backendHost);
  if (host.origin !== input.backendHost || host.username || host.password || (host.protocol !== "https:" &&
    !(host.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname)))) invalid();
  return localDeliveryBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(["iou-local-setup-account-v2", input.principal, input.backendCanisterId, input.backendHost])))));
}
