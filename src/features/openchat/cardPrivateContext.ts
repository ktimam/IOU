// Viewer-authorized private context for the credentialless OpenChat card.
// OpenChat never receives IOU account types. It mints a short-lived,
// app/card/viewer/recipient-key-bound capability; IOU redeems it C2C, checks
// the linked active sheet, and releases ciphertext plus a vetKD key encrypted
// to this iframe's fresh transport key.

import { Actor, HttpAgent } from "@dfinity/agent";
import { canisterId, host } from "../auth/config";
import {
  newTransportKey,
  unwrapSheetKeyProd,
  type VetkdTransportKey,
} from "../crypto/prodVetkd";
import type { TxnTemplate } from "../templates/TemplatesContext";
import { decryptSlot } from "../templates/pairTemplatesActor";
import { mergePairTemplates, visibleTemplates } from "../templates/pairTemplates";
import {
  APP_SCOPED_CARD_CONTEXT_VERSION,
  CARD_RECIPIENT_KEY_SCHEME,
  type CardInitContext,
} from "./cardBridge";

type IDL = any;
const U64_MAX = 18_446_744_073_709_551_615n;

export type CardTransportSession = {
  transport: VetkdTransportKey;
  publicKeyBase64Url: string;
};

export type AuthoritativeCardContext = {
  sheetId: string;
  contextVersion: typeof APP_SCOPED_CARD_CONTEXT_VERSION;
  appSubject: string;
  chatHandle: string;
  messageHandle: string;
  appId: number;
  appRevision: bigint;
  actionId: string;
};

export type LoadedCardPrivateContext = {
  authoritative: AuthoritativeCardContext;
  templates: TxnTemplate[];
  sheetKey: Uint8Array;
};

type RawSuccess = {
  sheet_id: string;
  context_version: number;
  app_subject: Uint8Array | number[];
  chat_handle: Uint8Array | number[];
  message_handle: Uint8Array | number[];
  app_id: number;
  app_revision: bigint;
  action_id: string;
  vetkd_public_key: Uint8Array | number[];
  encrypted_vet_key: Uint8Array | number[];
  templates_a_enc: [] | [Uint8Array | number[]];
  templates_a_iv: [] | [Uint8Array | number[]];
  templates_b_enc: [] | [Uint8Array | number[]];
  templates_b_iv: [] | [Uint8Array | number[]];
};

type RawResult =
  | { Success: RawSuccess }
  | { NotConfigured: null }
  | { InvalidCapability: null }
  | { NotLinked: null }
  | { ChatNotLinked: null }
  | { NotAuthorized: null }
  | { KeyUnavailable: null };

const idl = ({ IDL: idl }: { IDL: IDL }) => {
  const Context = idl.Record({
    sheet_id: idl.Text,
    context_version: idl.Nat16,
    app_subject: idl.Vec(idl.Nat8),
    chat_handle: idl.Vec(idl.Nat8),
    message_handle: idl.Vec(idl.Nat8),
    app_id: idl.Nat32,
    app_revision: idl.Nat64,
    action_id: idl.Text,
    vetkd_public_key: idl.Vec(idl.Nat8),
    encrypted_vet_key: idl.Vec(idl.Nat8),
    templates_a_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_a_iv: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  const Result = idl.Variant({
    Success: Context,
    NotConfigured: idl.Null,
    InvalidCapability: idl.Null,
    NotLinked: idl.Null,
    ChatNotLinked: idl.Null,
    NotAuthorized: idl.Null,
    KeyUnavailable: idl.Null,
  });
  return idl.Service({
    openchat_card_context: idl.Func(
      [idl.Vec(idl.Nat8), idl.Text, idl.Vec(idl.Nat8)],
      [Result],
      [],
    ),
  });
};

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeCanonicalCapability(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("invalid OpenChat card capability");
  }
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.length !== 32 || bytesToBase64Url(bytes) !== value) {
      throw new Error("invalid OpenChat card capability");
    }
    return bytes;
  } catch {
    throw new Error("invalid OpenChat card capability");
  }
}

export function createCardTransportSession(): CardTransportSession {
  const transport = newTransportKey();
  if (transport.secretKey.length !== 32 || transport.publicKey.length !== 48) {
    transport.secretKey.fill(0);
    throw new Error("invalid card transport key");
  }
  return {
    transport,
    publicKeyBase64Url: bytesToBase64Url(transport.publicKey),
  };
}

export function destroyCardTransportSession(session: CardTransportSession | undefined): void {
  session?.transport.secretKey.fill(0);
}

export function destroyLoadedCardContext(context: LoadedCardPrivateContext | undefined): void {
  context?.sheetKey.fill(0);
}

export function cardContextMatchesInit(
  authoritative: AuthoritativeCardContext,
  init: CardInitContext,
): boolean {
  const scoped = init.privateContext?.context;
  return (
    scoped !== undefined &&
    authoritative.contextVersion === scoped.contextVersion &&
    authoritative.appSubject === scoped.appSubject &&
    authoritative.chatHandle === scoped.chatHandle &&
    authoritative.messageHandle === scoped.messageHandle &&
    authoritative.appId === init.appId &&
    authoritative.appRevision === init.appRevision &&
    authoritative.actionId === init.actionId &&
    authoritative.appId === scoped.appId &&
    authoritative.appRevision === scoped.appRevision &&
    authoritative.actionId === scoped.actionId
  );
}

function exactBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)
  ) {
    return Uint8Array.from(value);
  }
  throw new Error("invalid private card byte field");
}

function opt<T>(value: [] | [T]): T | undefined {
  return value[0];
}

function optionalBytes(value: [] | [Uint8Array | number[]]): Uint8Array | undefined {
  const candidate = opt(value);
  return candidate === undefined ? undefined : exactBytes(candidate);
}

export function parseAuthoritativeCardContext(raw: RawSuccess): AuthoritativeCardContext {
  let appSubject: Uint8Array;
  let chatHandle: Uint8Array;
  let messageHandle: Uint8Array;
  try {
    appSubject = exactBytes(raw.app_subject);
    chatHandle = exactBytes(raw.chat_handle);
    messageHandle = exactBytes(raw.message_handle);
  } catch {
    throw new Error("invalid private card context");
  }
  if (
    !/^[0-9a-f]{16}$/.test(raw.sheet_id) ||
    raw.context_version !== APP_SCOPED_CARD_CONTEXT_VERSION ||
    appSubject.length !== 32 ||
    chatHandle.length !== 32 ||
    messageHandle.length !== 32 ||
    !Number.isSafeInteger(raw.app_id) ||
    raw.app_id < 0 ||
    raw.app_id > 4_294_967_295 ||
    typeof raw.app_revision !== "bigint" ||
    raw.app_revision < 0n ||
    raw.app_revision > U64_MAX ||
    typeof raw.action_id !== "string" ||
    raw.action_id.length === 0 ||
    raw.action_id.length > 128
  ) {
    throw new Error("invalid private card context");
  }
  return {
    sheetId: raw.sheet_id,
    contextVersion: APP_SCOPED_CARD_CONTEXT_VERSION,
    appSubject: bytesToBase64Url(appSubject),
    chatHandle: bytesToBase64Url(chatHandle),
    messageHandle: bytesToBase64Url(messageHandle),
    appId: raw.app_id,
    appRevision: raw.app_revision,
    actionId: raw.action_id,
  };
}

function resultError(result: Exclude<RawResult, { Success: RawSuccess }>): Error {
  if ("NotLinked" in result) {
    return new Error("Connect this IOU account to OpenChat to show its types.");
  }
  if ("ChatNotLinked" in result) {
    return new Error(
      "Choose this chat's account/sheet in IOU Settings → Chat routing, then retry the card.",
    );
  }
  if ("NotConfigured" in result) return new Error("Private card context is not configured.");
  if ("KeyUnavailable" in result) return new Error("Account types are temporarily unavailable.");
  return new Error("Private card context is unavailable.");
}

export async function loadCardPrivateContext(
  capability: string,
  session: CardTransportSession,
): Promise<LoadedCardPrivateContext> {
  const token = decodeCanonicalCapability(capability);
  const agent = new HttpAgent({ host });
  if (host.includes("127.0.0.1") || host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor(idl as never, { agent, canisterId }) as {
    openchat_card_context: (
      token: number[],
      recipientKeyScheme: string,
      recipientPublicKey: number[],
    ) => Promise<RawResult>;
  };
  let result: RawResult;
  try {
    result = await actor.openchat_card_context(
      Array.from(token),
      CARD_RECIPIENT_KEY_SCHEME,
      Array.from(session.transport.publicKey),
    );
  } finally {
    token.fill(0);
  }
  if (!("Success" in result)) throw resultError(result);
  const raw = result.Success;
  const authoritative = parseAuthoritativeCardContext(raw);
  let masterPublicKey: Uint8Array;
  let encryptedVetKey: Uint8Array;
  let templatesAEnc: Uint8Array | undefined;
  let templatesAIv: Uint8Array | undefined;
  let templatesBEnc: Uint8Array | undefined;
  let templatesBIv: Uint8Array | undefined;
  try {
    masterPublicKey = exactBytes(raw.vetkd_public_key);
    encryptedVetKey = exactBytes(raw.encrypted_vet_key);
    templatesAEnc = optionalBytes(raw.templates_a_enc);
    templatesAIv = optionalBytes(raw.templates_a_iv);
    templatesBEnc = optionalBytes(raw.templates_b_enc);
    templatesBIv = optionalBytes(raw.templates_b_iv);
  } catch {
    throw new Error("invalid private card key material");
  }
  if (masterPublicKey.length !== 96 || encryptedVetKey.length === 0) {
    throw new Error("invalid private card key material");
  }

  let sheetKey: Uint8Array | undefined;
  try {
    sheetKey = await unwrapSheetKeyProd(
      authoritative.sheetId,
      session.transport,
      masterPublicKey,
      encryptedVetKey,
      new Uint8Array(),
    );
    const [slotA, slotB] = await Promise.all([
      decryptSlot(sheetKey, templatesAEnc, templatesAIv),
      decryptSlot(sheetKey, templatesBEnc, templatesBIv),
    ]);
    const templates = visibleTemplates(
      mergePairTemplates(slotA.templates, slotB.templates),
    );
    return { authoritative, templates, sheetKey };
  } catch (error) {
    sheetKey?.fill(0);
    throw error;
  }
}
