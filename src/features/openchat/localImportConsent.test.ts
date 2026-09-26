import { describe, expect, it, vi } from "vitest";
import { createLocalImportConsent, LOCAL_IMPORT_CONNECTION_MS, LOCAL_IMPORT_CONSENT_MS, nativeLocalImportSenderOrigin } from "./localImportConsent";
import { createLocalImportReceiver, type LocalImportEvent } from "./localImportHandoff";

const source = {} as Window;
const origin = "http://localhost:5199";
const connectionId = "A".repeat(43);
const sessionNonce = "B".repeat(42) + "A";
const connect = () => ({ type: "oc:app-import:connect", version: 1, connectionId });
const event = (data: unknown, senderOrigin = origin, senderWindow: MessageEventSource = source): LocalImportEvent => ({ data, origin: senderOrigin, source: senderWindow });

describe("one-time native import consent", () => {
  it.each(["http://localhost:1024", origin, "http://localhost:65535"])("allows %s only as a candidate for user review", candidate => {
    expect(nativeLocalImportSenderOrigin(candidate)).toBe(candidate);
  });
  it.each(["http://localhost", "http://localhost:80", "http://localhost:1023", "http://localhost:65536",
    "http://localhost:05199", "http://LOCALHOST:5199", "http://localhost:5199/", "http://localhost:5199/path",
    "http://user@localhost:5199", "http://localhost:5199?allow=1", "http://localhost:5199#yes",
    "http://127.0.0.1:5199", "http://[::1]:5199", "http://localhost.evil:5199", "https://localhost:5199", "null", "*"])(
    "rejects noncanonical native sender %s", candidate => expect(nativeLocalImportSenderOrigin(candidate)).toBeUndefined(),
  );
  it("keeps connect metadata immutable and creates no receiver nonce before explicit approval", () => {
    const nonce = vi.fn(() => sessionNonce);
    const options = { senderWindow: source, now: () => 1000, nonce };
    const consent = createLocalImportConsent(options);
    expect(consent.approve()).toBeUndefined();
    const message = connect();
    const pending = consent.receive(event(message));
    message.connectionId = "C".repeat(42) + "A";
    options.senderWindow = {} as Window;
    expect(pending).toEqual({ kind: "pending", candidate: { senderOrigin: origin, connectionId }, expiresAtMs: 1000 + LOCAL_IMPORT_CONSENT_MS });
    expect(Object.isFrozen(pending)).toBe(true);
    expect(nonce).not.toHaveBeenCalled(); expect(consent.isConnected()).toBe(false);
    const approved = consent.approve()!;
    expect(approved.binding).toEqual({ senderOrigin: origin, senderWindow: source, sessionNonce });
    expect(approved.reply).toEqual({ type: "oc:app-import:connected", version: 1, connectionId, sessionNonce });
    expect(Object.isFrozen(approved.reply)).toBe(true);
    expect(nonce).toHaveBeenCalledOnce(); expect(consent.isConnected()).toBe(true);
    expect(consent.approve()).toBeUndefined();
    expect(consent.receive(event(connect(), "http://localhost:5200")).kind).toBe("connected");
  });
  it("ignores payload offers, unknown fields, wrong window/version/id and accessors before consent", () => {
    const nonce = vi.fn(() => sessionNonce); const getter = vi.fn();
    const consent = createLocalImportConsent({ senderWindow: source, now: () => 0, nonce });
    const accessor = Object.defineProperty({ type: "oc:app-import:connect", version: 1 }, "connectionId", { enumerable: true, get: getter });
    for (const input of [
      event({ type: "oc:app-import:offer", version: 1, sessionNonce, payload: { secret: "unaccepted" } }),
      event({ ...connect(), payload: "unaccepted" }), event({ ...connect(), version: 2 }),
      event({ ...connect(), connectionId: "not-an-id" }), event(connect(), origin, {} as Window), event(connect(), "null"), event(accessor),
    ]) expect(consent.receive(input).kind).toBe("waiting");
    expect(getter).not.toHaveBeenCalled(); expect(nonce).not.toHaveBeenCalled();
  });
  it.each(["origin", "correlation"])("closes instead of retargeting a changed pending %s", changed => {
    const consent = createLocalImportConsent({ senderWindow: source, now: () => 0 });
    consent.receive(event(connect()));
    const next = changed === "origin" ? event(connect(), "http://localhost:5200") : event({ ...connect(), connectionId: "C".repeat(42) + "A" });
    expect(consent.receive(next).kind).toBe("closed"); expect(consent.approve()).toBeUndefined();
  });
  it("bounds pending consent and the entire connection without extending on repeated hello", () => {
    let time = 0;
    const nonce = vi.fn(() => sessionNonce);
    const pending = createLocalImportConsent({ senderWindow: source, now: () => time, nonce });
    pending.receive(event(connect())); time = LOCAL_IMPORT_CONSENT_MS - 1; pending.receive(event(connect()));
    time++; expect(pending.approve()).toBeUndefined(); expect(pending.state().kind).toBe("closed"); expect(nonce).not.toHaveBeenCalled();
    time = 0; const connected = createLocalImportConsent({ senderWindow: source, now: () => time, nonce });
    connected.receive(event(connect())); time = LOCAL_IMPORT_CONSENT_MS - 1; connected.approve();
    time = LOCAL_IMPORT_CONNECTION_MS - 1; expect(connected.isConnected()).toBe(true);
    time++; expect(connected.isConnected()).toBe(false); expect(connected.approve()).toBeUndefined();
  });
  it("explicit close invalidates pending and connected attempts permanently", () => {
    for (const approved of [false, true]) {
      const consent = createLocalImportConsent({ senderWindow: source, now: () => 0, nonce: () => sessionNonce });
      consent.receive(event(connect())); if (approved) consent.approve(); consent.close();
      expect(consent.receive(event(connect())).kind).toBe("closed"); expect(consent.approve()).toBeUndefined(); expect(consent.isConnected()).toBe(false);
    }
  });
  it("only the accepted binding can enter the unchanged hello/offer receiver protocol", () => {
    const consent = createLocalImportConsent({ senderWindow: source, now: () => 0, nonce: () => sessionNonce });
    consent.receive(event(connect())); const accepted = consent.approve()!;
    const receiver = createLocalImportReceiver(accepted.binding);
    const hello = { type: "oc:app-import:hello", version: 1, sessionNonce };
    expect(receiver.receive(event({ ...hello, sessionNonce: connectionId })).kind).toBe("ignored");
    expect(receiver.receive(event(hello, "http://localhost:5200")).kind).toBe("ignored");
    expect(receiver.receive(event(hello, origin, {} as Window)).kind).toBe("ignored");
    expect(receiver.receive(event(hello)).kind).toBe("ready");
    expect(receiver.pending()).toEqual([]);
  });
});
