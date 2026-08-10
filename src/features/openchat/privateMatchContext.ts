// One-use private Saved-type matcher context for /openchat/private-match.
// The IOU canister returns an authoritative exact-text commitment and only
// encrypted linked-sheet roster material. The anonymous frame first proves the
// chat has a durable link, then requests the source and verifies its commitment
// before running the private keyword matcher.

import { Actor, HttpAgent } from "@dfinity/agent";
import { sha256 } from "@noble/hashes/sha256";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { canisterId, host } from "../auth/config";
import { unwrapSheetKeyProd } from "../crypto/prodVetkd";
import { decryptSlot } from "../templates/pairTemplatesActor";
import { mergePairTemplates, visibleTemplates } from "../templates/pairTemplates";
import { keywordMatches } from "../entries/resolveTemplateBase";
import {
  decodeCanonicalCapability,
  type CardTransportSession,
} from "./cardPrivateContext";

type IDL = any;

type RawSuccess = {
  sheet_id: string;
  context_version: number;
  app_subject: Uint8Array | number[];
  chat_handle: Uint8Array | number[];
  message_handle: Uint8Array | number[];
  app_id: number;
  app_revision: bigint;
  action_id: string;
  source_binding: Uint8Array | number[];
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

export type LoadedPrivateMatchContext = {
  // Only keyword sets survive the immediate decrypted-roster projection. Names, ids, defaults,
  // fees and schedules are erased before this function returns.
  keywordSets: string[][];
  sheetKey: Uint8Array;
  sourceBinding: Uint8Array;
};

export class PrivateMatchContextUnavailable extends Error {
  constructor(readonly definitiveNoMatch: boolean) {
    super("private match unavailable");
    this.name = "PrivateMatchContextUnavailable";
  }
}

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
    source_binding: idl.Vec(idl.Nat8),
    vetkd_public_key: idl.Vec(idl.Nat8),
    encrypted_vet_key: idl.Vec(idl.Nat8),
    templates_a_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_a_iv: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_enc: idl.Opt(idl.Vec(idl.Nat8)),
    templates_b_iv: idl.Opt(idl.Vec(idl.Nat8)),
  });
  return idl.Service({
    openchat_private_match_context: idl.Func(
      [idl.Vec(idl.Nat8), idl.Text, idl.Vec(idl.Nat8)],
      [idl.Variant({
        Success: Context,
        NotConfigured: idl.Null,
        InvalidCapability: idl.Null,
        NotLinked: idl.Null,
        ChatNotLinked: idl.Null,
        NotAuthorized: idl.Null,
        KeyUnavailable: idl.Null,
      })],
      [],
    ),
  });
};

function exactBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (
    Array.isArray(value) &&
    value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 0xff)
  ) {
    return Uint8Array.from(value);
  }
  throw new Error("invalid private-match byte field");
}

function zeroRawBytes(value: Uint8Array | number[] | undefined): void {
  value?.fill(0);
}

function takeOptionalBytes(value: [] | [Uint8Array | number[]]): Uint8Array | undefined {
  if (value.length === 0) return undefined;
  const raw = value[0];
  const copied = exactBytes(raw);
  zeroRawBytes(raw);
  value.splice(0, value.length);
  return copied;
}

function zeroUndecryptedRawMaterial(raw: RawSuccess): void {
  zeroRawBytes(raw.vetkd_public_key);
  zeroRawBytes(raw.encrypted_vet_key);
  for (const optional of [
    raw.templates_a_enc,
    raw.templates_a_iv,
    raw.templates_b_enc,
    raw.templates_b_iv,
  ]) {
    if (optional.length > 0) zeroRawBytes(optional[0]);
    optional.splice(0, optional.length);
  }
}

function u64be(value: number): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, BigInt(value), false);
  return result;
}

const SOURCE_HASH_DOMAIN = utf8ToBytes("openchat.ai-app-private-match-source.v1\0");

/** Byte-identical to OpenChat's ai_app_private_match_source_hash_v1. */
export function privateMatchSourceHashV1(source: string): Uint8Array {
  const bytes = utf8ToBytes(source);
  return sha256(concatBytes(SOURCE_HASH_DOMAIN, u64be(bytes.length), bytes));
}

export function exactPrivateMatchSource(source: string, expected: Uint8Array): boolean {
  const actual = privateMatchSourceHashV1(source);
  if (expected.length !== actual.length) {
    actual.fill(0);
    return false;
  }
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= actual[index] ^ expected[index];
  }
  actual.fill(0);
  return difference === 0;
}

/** Best-effort teardown for JS string-bearing roster objects after the decision. */
export function destroyPrivateMatchContext(context: LoadedPrivateMatchContext | undefined): void {
  if (context === undefined) return;
  context.sheetKey.fill(0);
  context.sourceBinding.fill(0);
  for (const keywords of context.keywordSets) {
    keywords.fill("");
    keywords.length = 0;
  }
  context.keywordSets.length = 0;
}

export function verifyPrivateMatchSource(
  context: LoadedPrivateMatchContext,
  exactMessageText: string,
): boolean {
  const matches = exactPrivateMatchSource(exactMessageText, context.sourceBinding);
  context.sourceBinding.fill(0);
  return matches;
}

export function uniquePrivateKeywordMatch(
  keywordSets: readonly string[][],
  source: string,
  matcher: (text: string, keyword: string) => boolean = keywordMatches,
): boolean {
  let matchingTypes = 0;
  for (const keywords of keywordSets) {
    let typeMatched = false;
    // Always evaluate every keyword in every type. Early exits would let a hostile host infer
    // private roster position/count from response timing even though the wire returns one boolean.
    for (const keyword of keywords) {
      typeMatched = matcher(source, keyword) || typeMatched;
    }
    matchingTypes += Number(typeMatched);
  }
  return matchingTypes === 1;
}

function eraseDecryptedTemplate(value: object): void {
  const record = value as Record<string, unknown>;
  const keywords = record.keywords;
  if (Array.isArray(keywords)) {
    keywords.fill("");
    keywords.length = 0;
  }
  const schedule = record.schedule;
  if (Array.isArray(schedule)) {
    for (const row of schedule) {
      if (row !== null && typeof row === "object") {
        for (const key of Object.keys(row)) Reflect.deleteProperty(row, key);
      }
    }
    schedule.length = 0;
  }
  for (const key of Object.keys(record)) Reflect.deleteProperty(record, key);
}

export async function preparePrivateMatchContext(
  capability: string,
  session: CardTransportSession,
): Promise<LoadedPrivateMatchContext> {
  const token = decodeCanonicalCapability(capability);
  const agent = new HttpAgent({ host });
  if (host.includes("127.0.0.1") || host.includes("localhost")) {
    await agent.fetchRootKey();
  }
  const actor = Actor.createActor(idl as never, { agent, canisterId }) as {
    openchat_private_match_context: (
      token: number[],
      recipientKeyScheme: string,
      recipientPublicKey: number[],
    ) => Promise<RawResult>;
  };
  let result: RawResult;
  try {
    result = await actor.openchat_private_match_context(
      Array.from(token),
      "iou.vetkd.bls12-381.v1",
      Array.from(session.transport.publicKey),
    );
  } finally {
    token.fill(0);
  }
  if (!("Success" in result)) {
    const definitiveNoMatch =
      "NotConfigured" in result ||
      "NotLinked" in result ||
      "ChatNotLinked" in result ||
      "NotAuthorized" in result;
    throw new PrivateMatchContextUnavailable(definitiveNoMatch);
  }

  const raw = result.Success;
  const sourceBinding = exactBytes(raw.source_binding);
  zeroRawBytes(raw.source_binding);
  zeroRawBytes(raw.app_subject);
  zeroRawBytes(raw.chat_handle);
  zeroRawBytes(raw.message_handle);
  if (sourceBinding.length !== 32) {
    sourceBinding.fill(0);
    zeroUndecryptedRawMaterial(raw);
    throw new Error("invalid private match source binding");
  }
  if (!/^[0-9a-f]{16}$/.test(raw.sheet_id)) {
    sourceBinding.fill(0);
    zeroUndecryptedRawMaterial(raw);
    throw new Error("invalid private match sheet");
  }

  let masterPublicKey: Uint8Array | undefined;
  let encryptedVetKey: Uint8Array | undefined;
  let templatesAEnc: Uint8Array | undefined;
  let templatesAIv: Uint8Array | undefined;
  let templatesBEnc: Uint8Array | undefined;
  let templatesBIv: Uint8Array | undefined;
  let sheetKey: Uint8Array | undefined;
  try {
    masterPublicKey = exactBytes(raw.vetkd_public_key);
    encryptedVetKey = exactBytes(raw.encrypted_vet_key);
    zeroRawBytes(raw.vetkd_public_key);
    zeroRawBytes(raw.encrypted_vet_key);
    templatesAEnc = takeOptionalBytes(raw.templates_a_enc);
    templatesAIv = takeOptionalBytes(raw.templates_a_iv);
    templatesBEnc = takeOptionalBytes(raw.templates_b_enc);
    templatesBIv = takeOptionalBytes(raw.templates_b_iv);
    if (masterPublicKey.length !== 96 || encryptedVetKey.length === 0) {
      throw new Error("invalid private match key material");
    }
    sheetKey = await unwrapSheetKeyProd(
      raw.sheet_id,
      session.transport,
      masterPublicKey,
      encryptedVetKey,
      new Uint8Array(),
    );
    const [slotA, slotB] = await Promise.all([
      decryptSlot(sheetKey, templatesAEnc, templatesAIv),
      decryptSlot(sheetKey, templatesBEnc, templatesBIv),
    ]);
    const visible = visibleTemplates(mergePairTemplates(slotA.templates, slotB.templates));
    const keywordSets = visible
      .map((template) => [...(template.keywords ?? [])])
      .filter((keywords) => keywords.length > 0);
    // mergePairTemplates retains references into the two decrypted slots. Erasing both slots covers
    // winners, losers and tombstones before the caller receives the minimal keyword-only projection.
    for (const template of [...slotA.templates, ...slotB.templates]) {
      eraseDecryptedTemplate(template);
    }
    slotA.templates.length = 0;
    slotB.templates.length = 0;
    slotA.dismissed.fill("");
    slotA.dismissed.length = 0;
    slotB.dismissed.fill("");
    slotB.dismissed.length = 0;
    return {
      keywordSets,
      sheetKey,
      sourceBinding,
    };
  } catch (error) {
    sheetKey?.fill(0);
    sourceBinding.fill(0);
    throw error;
  } finally {
    masterPublicKey?.fill(0);
    encryptedVetKey?.fill(0);
    templatesAEnc?.fill(0);
    templatesAIv?.fill(0);
    templatesBEnc?.fill(0);
    templatesBIv?.fill(0);
  }
}
