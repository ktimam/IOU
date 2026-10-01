import { describe, expect, it, vi } from "vitest";
import {
  buildLocalImportCommittedReceipt, createLocalImportNonce, createLocalImportReceiver, isLocalImportId, LOCAL_IMPORT_ACTION,
  LOCAL_IMPORT_LIMITS, parseLocalImportPayload, type LocalImportEvent,
} from "./localImportHandoff";
import { localDeliveryBase64Url, LOCAL_DELIVERY_SCHEME } from "./localImportEncryption";

const ORIGIN = "https://unofficial.example";
const SOURCE = {} as Window;
const NONCE = "A".repeat(43);
const ID = "B".repeat(42) + "A";
const ROW = { kind: "iou", amount: 12.35, currency: "USD", direction: "debt", date: "2026-09-26", note: "Reviewed note" };
const DESTINATION = "http://localhost:3000/openchat/import";
const envelope = () => ({ version: 1, scheme: LOCAL_DELIVERY_SCHEME, keyId: "a".repeat(64), recipientContext: "AQ",
  ephemeralPublicKey: localDeliveryBase64Url(Uint8Array.from([4, ...new Array(64).fill(0)])), salt: localDeliveryBase64Url(new Uint8Array(32)),
  iv: localDeliveryBase64Url(new Uint8Array(12)), ciphertext: localDeliveryBase64Url(new Uint8Array(17)) });
const hello = () => ({ type: "oc:app-import:hello", version: 2, sessionNonce: NONCE });
const offer = () => ({ type: "oc:app-import:offer", version: 2, sessionNonce: NONCE, importId: ID,
  appId: "iou", appRevision: "local-import-v2", actionId: LOCAL_IMPORT_ACTION, destination: DESTINATION, envelope: envelope() });
const event = (data: unknown): LocalImportEvent => ({ origin: ORIGIN, source: SOURCE, data });
const receiver = () => createLocalImportReceiver({ senderOrigin: ORIGIN, senderWindow: SOURCE, sessionNonce: NONCE, destination: DESTINATION });
const readyReceiver = () => { const r = receiver(); r.receive(event(hello())); return r; };

describe("local import binding and generic handshake", () => {
  it.each(["null", "*", "http://unofficial.example", "https://unofficial.example/", "https://unofficial.example/path", "https://user:password@unofficial.example", "https://unofficial.example?x=1"]) ("rejects unsafe or non-canonical origin %s", (senderOrigin) => {
    expect(() => createLocalImportReceiver({ senderOrigin, senderWindow: SOURCE, sessionNonce: NONCE, destination: DESTINATION })).toThrow();
  });
  it.each(["http://localhost:5187", "http://127.0.0.1:5187", "http://[::1]:5187", ORIGIN])("accepts explicit secure/loopback origin %s", (senderOrigin) => {
    expect(() => createLocalImportReceiver({ senderOrigin, senderWindow: SOURCE, sessionNonce: NONCE, destination: DESTINATION })).not.toThrow();
  });
  it("generates distinct canonical 32-byte nonces", () => {
    const a = createLocalImportNonce(); const b = createLocalImportNonce();
    expect(isLocalImportId(a)).toBe(true); expect(isLocalImportId(b)).toBe(true); expect(a).not.toBe(b);
    expect(isLocalImportId("a".repeat(43))).toBe(false);
    expect(isLocalImportId(NONCE + "=")).toBe(false);
  });
  it("does not accept offers before the exact hello handshake", () => {
    const r = receiver();
    expect(r.receive(event(offer())).kind).toBe("ignored");
    expect(r.pending()).toEqual([]);
    expect(r.receive(event(hello()))).toMatchObject({ kind: "ready", reply: { type: "oc:app-import:ready", sessionNonce: NONCE } });
    expect(r.receive(event(offer())).kind).toBe("queued");
  });
  it("rejects origin, source, nonce and protocol-version substitution without replying", () => {
    const r = readyReceiver();
    const bad = [
      { ...event(offer()), origin: "https://attacker.example" },
      { ...event(offer()), source: {} as Window },
      { ...event(offer()), source: null },
      event({ ...offer(), sessionNonce: "C".repeat(42) + "A" }),
      event({ ...offer(), version: 1 }),
    ];
    for (const item of bad) expect(r.receive(item)).toEqual({ kind: "ignored" });
    expect(r.pending()).toEqual([]);
  });
  it("requires exact envelopes and the app-owned action", () => {
    const r = readyReceiver();
    for (const data of [{ ...offer(), extra: "hidden" }, { ...offer(), actionId: "other.action" }, { ...offer(), importId: "short" }]) {
      expect(r.receive(event(data))).toMatchObject({ kind: "rejected", reply: { reason: "invalid-offer" } });
    }
    expect(r.pending()).toEqual([]);
  });
  it("does not trust accessor properties or invoke getters", () => {
    const read = vi.fn(() => "oc:app-import:hello");
    const message = Object.defineProperty({ version: 2, sessionNonce: NONCE }, "type", { enumerable: true, get: read });
    expect(receiver().receive(event(message))).toEqual({ kind: "ignored" }); expect(read).not.toHaveBeenCalled();
  });
});

describe("strict IOU reviewed payload", () => {
  it("carries a bounded visible Type label/id pair, never hidden money defaults", () => {
    expect(parseLocalImportPayload({ entries: [{ ...ROW, typeId: "type-1", typeName: "Stay" }] })?.entries[0]).toMatchObject({ typeId: "type-1", typeName: "Stay" });
    for (const patch of [{ typeId: "type-1" }, { typeName: "Stay" }, { typeId: "type-1", typeName: "" },
      { typeId: "bad/id", typeName: "Stay" }, { typeId: "type-1", typeName: "x".repeat(129) },
      { typeId: "type-1", typeName: "Stay", fee_percent: 20 }]) {
      expect(parseLocalImportPayload({ entries: [{ ...ROW, ...patch }] })).toBeUndefined();
    }
  });
  it("retains exact reviewed fields without adding a missing date or recovering it from note", () => {
    const { date: _date, ...row } = ROW;
    const parsed = parseLocalImportPayload({ entries: [{ ...row, note: "  August 6-10  " }] });
    expect(parsed).toEqual({ entries: [{ ...row, note: "  August 6-10  " }] });
    expect(parsed?.entries[0]).not.toHaveProperty("date");
  });
  it.each(["message", "counterparty", "template", "template_ref", "image_heading", "interval_start", "fee_percent", "schedule", "draft_id", "__proto__"])("rejects unsupported/hidden field %s", (key) => {
    const row = { ...ROW, [key]: "hidden" };
    expect(parseLocalImportPayload({ entries: [row] })).toBeUndefined();
  });
  it.each([
    { amount: "12.35" }, { amount: NaN }, { amount: Infinity }, { amount: 0 }, { amount: -1 },
    { amount: 0.001 }, { amount: 1.234 }, { amount: Number.MAX_SAFE_INTEGER },
    { currency: "usd" }, { currency: " USD " }, { currency: "US" },
    { direction: "you owe" }, { kind: "Reservation" },
    { date: "2026-02-30" }, { date: "September 26" }, { date: "0000-01-01" }, { date: undefined },
    { note: null }, { note: "\u0000" }, { note: "\u202eevil" }, { note: "\ud800" },
  ])("rejects malformed/noncanonical fields %j", (patch) => {
    expect(parseLocalImportPayload({ entries: [{ ...ROW, ...patch }] })).toBeUndefined();
  });
  it("rejects absent required fields, non-objects, extra envelope fields and prototype tricks", () => {
    for (const key of ["amount", "currency", "kind", "direction"]) {
      const row: Record<string, unknown> = { ...ROW }; delete row[key];
      expect(parseLocalImportPayload({ entries: [row] })).toBeUndefined();
    }
    for (const value of [null, [], { entries: [] }, { entries: [null] }, { entries: [ROW], hidden: true }, { entries: [Object.create(ROW)] }]) {
      expect(parseLocalImportPayload(value)).toBeUndefined();
    }
  });
  it("bounds row count, UTF-8 note bytes and total payload", () => {
    expect(parseLocalImportPayload({ entries: Array.from({ length: 32 }, () => ({ ...ROW })) })).toBeDefined();
    expect(parseLocalImportPayload({ entries: Array.from({ length: 33 }, () => ({ ...ROW })) })).toBeUndefined();
    expect(parseLocalImportPayload({ entries: [{ ...ROW, note: "x".repeat(4096) }] })).toBeDefined();
    expect(parseLocalImportPayload({ entries: [{ ...ROW, note: "ع".repeat(2049) }] })).toBeUndefined();
    expect(parseLocalImportPayload({ entries: Array.from({ length: 32 }, () => ({ ...ROW, note: "x".repeat(4096) })) })).toBeUndefined();
  });
  it("rejects sparse arrays, array extras and array accessors without running them", () => {
    const read = vi.fn(() => ROW);
    const accessor = Object.defineProperty([ROW], "0", { enumerable: true, get: read });
    for (const entries of [new Array(1), Object.assign([ROW], { hidden: "source" }), accessor]) {
      expect(parseLocalImportPayload({ entries })).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
  });
});

describe("immutable pending-review lifecycle without side effects", () => {
  it("builds a separate saved receipt only from a complete batch acknowledgement", () => {
    const receipt = buildLocalImportCommittedReceipt(NONCE, ID, { entry_ids: [1n, 2n], accepted_count: 2, replayed: false });
    expect(receipt).toEqual({ type: "oc:app-import:committed", version: 2, sessionNonce: NONCE,
      importId: ID, status: "saved", acceptedCount: 2, replayed: false });
    expect(Object.isFrozen(receipt)).toBe(true);
    for (const ack of [
      { entry_ids: [], accepted_count: 0, replayed: false },
      { entry_ids: [1n], accepted_count: 2, replayed: false },
      { entry_ids: [1n, 1n], accepted_count: 2, replayed: true },
      { entry_ids: [0n], accepted_count: 1, replayed: false },
    ]) expect(() => buildLocalImportCommittedReceipt(NONCE, ID, ack)).toThrow();
    const r = readyReceiver();
    expect(r.receive(event(receipt))).toEqual({ kind: "ignored" });
    expect(r.pending()).toEqual([]);
  });
  it("snapshots immutable data, acknowledges only pending review, never writes or sends", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const r = readyReceiver(); const input = offer(); const result = r.receive(event(input));
      expect(result).toMatchObject({ kind: "queued", reply: { status: "pending-review", importId: ID } });
      input.envelope.keyId = "b".repeat(64);
      expect(r.pending()[0].envelope.keyId).toBe("a".repeat(64));
      expect(Object.isFrozen(r.pending())).toBe(true);
      expect(Object.isFrozen(r.pending()[0])).toBe(true);
      expect(Object.isFrozen(r.pending()[0].envelope)).toBe(true);
      expect(Object.isFrozen(r.pending()[0].envelopes)).toBe(true);
      expect(r.pending()[0]).not.toHaveProperty("payload");
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
  it("deduplicates exact envelopes but retains fresh ciphertext for authenticated comparison", () => {
    const r = readyReceiver(); r.receive(event(offer()));
    const duplicate = offer();
    expect(r.receive(event(duplicate)).kind).toBe("duplicate");
    const changed = offer(); changed.envelope.ciphertext = localDeliveryBase64Url(new Uint8Array(17).fill(1));
    expect(r.receive(event(changed)).kind).toBe("queued");
    expect(r.pending()).toHaveLength(1); expect(r.pending()[0].envelopes).toHaveLength(2);
    expect(r.receive(event({ ...offer(), envelope: { ...envelope(), keyId: "b".repeat(64) } }))).toMatchObject({ kind: "rejected", reply: { reason: "id-conflict" } });
  });
  it("refuses plaintext, mixed plaintext/ciphertext, wrong destinations and expired app revisions", () => {
    const r = readyReceiver();
    const { envelope: _envelope, ...base } = offer();
    for (const value of [{ ...base, payload: { entries: [ROW] } }, { ...offer(), payload: { entries: [ROW] } },
      { ...offer(), destination: "https://other.example/openchat/import" }, { ...offer(), appRevision: "local-import-v1" }]) {
      expect(r.receive(event(value)).kind).toBe("rejected");
    }
    expect(r.pending()).toEqual([]);
  });
  it("bounds pending queue and still permits an exact replay while full", () => {
    const r = readyReceiver();
    for (let i = 0; i < LOCAL_IMPORT_LIMITS.queued; i++) {
      expect(r.receive(event({ ...offer(), importId: String(i).repeat(42) + "A" })).kind).toBe("queued");
    }
    expect(r.receive(event(offer()))).toMatchObject({ kind: "rejected", reply: { reason: "queue-full" } });
    expect(r.receive(event({ ...offer(), importId: "0".repeat(42) + "A" })).kind).toBe("duplicate");
  });
  it("close clears queue and ignores late hello/offers", () => {
    const r = readyReceiver(); r.receive(event(offer())); r.close();
    expect(r.pending()).toEqual([]);
    expect(r.receive(event(hello()))).toEqual({ kind: "ignored" });
    expect(r.receive(event(offer()))).toEqual({ kind: "ignored" });
  });
});
