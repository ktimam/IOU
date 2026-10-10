import { describe, expect, it, vi } from "vitest";
import { createLocalAppSetupConsent, LOCAL_APP_SETUP_MS } from "./localAppSetupConsent";

const id = "A".repeat(43);
function fixture() {
  const opener = { postMessage: vi.fn() } as unknown as Window;
  let time = 1000;
  const consent = createLocalAppSetupConsent({ opener, appId: "iou", now: () => time });
  const event = (patch: Record<string, unknown> = {}, origin = "https://client.example", source: MessageEventSource = opener) => ({
    origin, source, data: { type: "oc:app-setup:connect", version: 1, connectionId: id, appId: "iou", ...patch },
  });
  const request = () => {
    const state = consent.receive(event());
    if (state.kind !== "pending") throw new Error("Expected pending setup");
    return state;
  };
  return { consent, opener, event, request, clock: (value: number) => { time = value; } };
}

describe("explicit IOU setup consent binding", () => {
  it("accepts metadata only, binds the captured opener and reveals nothing before approval", () => {
    const f = fixture();
    expect(f.consent.state()).toEqual({ kind: "waiting" });
    const state = f.request();
    expect(state).toEqual({ kind: "pending", binding: { senderOrigin: "https://client.example", connectionId: id, appId: "iou" }, expiresAtMs: 1000 + LOCAL_APP_SETUP_MS });
    expect(f.opener.postMessage).not.toHaveBeenCalled();
    expect(Object.isFrozen(state.binding)).toBe(true);
  });
  it.each([
    { version: 2 }, { appId: "another-app" }, { connectionId: "wrong" }, { connectionId: "A".repeat(42) + "B" },
    { type: "oc:app-import:connect" }, { chatId: "private" }, { payload: { message: "private" } },
  ])("rejects malformed/unrelated metadata %j", (patch) => {
    const f = fixture();
    expect(f.consent.receive(f.event(patch))).toEqual({ kind: "waiting" });
  });
  it.each(["null", "http://remote.example", "https://client.example/path", "file:///client", "https://user:secret@client.example", "https://client.example/"])("rejects noncanonical or unsafe origin %s", (origin) => {
    const f = fixture();
    expect(f.consent.receive(f.event({}, origin))).toEqual({ kind: "waiting" });
  });
  it.each(["http://localhost:5190", "http://127.0.0.1:5190", "http://[::1]:5190"])("allows visible explicit consent for loopback %s", (origin) => {
    const f = fixture();
    expect(f.consent.receive(f.event({}, origin)).kind).toBe("pending");
  });
  it("ignores another window and does not evaluate accessor fields", () => {
    const f = fixture();
    expect(f.consent.receive(f.event({}, "https://client.example", {} as Window)).kind).toBe("waiting");
    const getter = vi.fn(() => id);
    const event = f.event();
    Object.defineProperty(event.data, "connectionId", { get: getter, enumerable: true });
    expect(f.consent.receive(event).kind).toBe("waiting");
    expect(getter).not.toHaveBeenCalled();
  });
  it.each(["origin", "connection"])("closes rather than replacing the displayed %s binding", (change) => {
    const f = fixture(); const state = f.request();
    f.consent.receive(f.event(change === "connection" ? { connectionId: "B".repeat(42) + "A" } : {}, change === "origin" ? "https://other.example" : undefined));
    expect(f.consent.state().kind).toBe("closed");
    expect(() => f.consent.approve(state.binding, "{}")).toThrow();
  });
  it("duplicate requests cannot extend the original ten-minute deadline", () => {
    const f = fixture(); const state = f.request();
    f.clock(1000 + LOCAL_APP_SETUP_MS - 1);
    expect(f.request()).toBe(state);
    f.clock(1000 + LOCAL_APP_SETUP_MS);
    expect(f.consent.receive(f.event()).kind).toBe("closed");
    expect(() => f.consent.approve(state.binding, "{}")).toThrow();
  });
  it("clock rollback and explicit close reject late approval", () => {
    for (const close of [false, true]) {
      const f = fixture(); const state = f.request();
      if (close) f.consent.close(); else f.clock(999);
      expect(f.consent.isCurrent(state.binding)).toBe(false);
      expect(() => f.consent.approve(state.binding, "{}")).toThrow();
      expect(f.consent.receive(f.event()).kind).toBe("closed");
    }
  });
  it("returns exactly one bounded catalog response only for the same live binding", () => {
    const f = fixture(); const state = f.request();
    expect(() => f.consent.approve({ ...state.binding }, "{}")).toThrow();
    expect(() => f.consent.approve(state.binding, "x".repeat(1024 * 1024 + 1))).toThrow();
    expect(f.consent.approve(state.binding, '{"version":1}')).toEqual({ type: "oc:app-setup:result", version: 1, connectionId: id, appId: "iou", catalogJson: '{"version":1}' });
    expect(f.consent.state().kind).toBe("shared");
    expect(() => f.consent.approve(state.binding, "{}")).toThrow();
    expect(f.consent.receive(f.event()).kind).toBe("shared");
  });
  it("cancels only the current binding once without a catalog and rejects late approval", () => {
    const f = fixture(), state = f.request();
    expect(() => f.consent.cancel({ ...state.binding })).toThrow("expired or changed");
    expect(f.consent.isCurrent(state.binding)).toBe(true);
    expect(f.consent.cancel(state.binding)).toEqual({ type: "oc:app-setup:cancel", version: 1, connectionId: id, appId: "iou" });
    expect(f.consent.state()).toEqual({ kind: "closed" });
    expect(f.consent.isCurrent(state.binding)).toBe(false);
    expect(() => f.consent.cancel(state.binding)).toThrow("expired or changed");
    expect(() => f.consent.approve(state.binding, "{}")).toThrow("expired or changed");
    expect(f.consent.receive(f.event()).kind).toBe("closed");
    expect(f.opener.postMessage).not.toHaveBeenCalled();
  });
  it.each(["expired", "shared", "closed"])("does not cancel an already %s binding", outcome => {
    const f = fixture(), state = f.request();
    if (outcome === "expired") f.clock(1000 + LOCAL_APP_SETUP_MS);
    if (outcome === "shared") f.consent.approve(state.binding, "{}");
    if (outcome === "closed") f.consent.close();
    expect(() => f.consent.cancel(state.binding)).toThrow("expired or changed");
  });
});

describe("version-two scoped setup consent", () => {
  const accountId = "B".repeat(42) + "A";
  const setupContext = { version: 2, scope: "account", accountId, routes: [] };
  const response = (patch: Record<string, unknown> = {}) => JSON.stringify({ version: 2, scope: "account", appId: "iou", accountId,
    catalogJson: '{"version":1,"apps":[]}', routes: [], ...patch });
  it.each([setupContext, { version: 2, scope: "chat", accountId, handle: id }])("cancels a scoped request without exposing its context", context => {
    const f = fixture(), state = f.consent.receive(f.event({ version: 2, setupContext: context }));
    if (state.kind !== "pending") throw new Error("Expected setup consent");
    expect(f.consent.cancel(state.binding)).toEqual({ type: "oc:app-setup:cancel", version: 2, connectionId: id, appId: "iou" });
    expect(f.consent.state()).toEqual({ kind: "closed" });
    expect(() => f.consent.approve(state.binding, response())).toThrow("expired or changed");
  });
  it("pins the scope and account before sharing a single version-two reply", () => {
    const f = fixture(), state = f.consent.receive(f.event({ version: 2, setupContext }));
    if (state.kind !== "pending") throw new Error("Expected setup consent");
    expect(state.binding.setupContext).toEqual(setupContext);
    expect(f.opener.postMessage).not.toHaveBeenCalled();
    expect(f.consent.approve(state.binding, response())).toMatchObject({ version: 2, connectionId: id, appId: "iou", catalogJson: response() });
    expect(() => f.consent.approve(state.binding, response())).toThrow();
  });
  it.each([
    { version: 1, setupContext },
    { version: 2, setupContext: { ...setupContext, chatId: "not-permitted" } },
    { version: 2, setupContext: { version: 2, scope: "chat", handle: id } },
  ])("rejects mixed or incomplete protocol metadata %j", patch => {
    const f = fixture(); expect(f.consent.receive(f.event(patch)).kind).toBe("waiting");
  });
  it.each(["downgrade", "account", "scope"])("closes rather than changing a pending %s context", change => {
    const f = fixture(); f.consent.receive(f.event({ version: 2, setupContext }));
    const event = change === "downgrade" ? f.event() : f.event({ version: 2, setupContext: change === "account"
      ? { ...setupContext, accountId: id } : { version: 2, scope: "chat", accountId, handle: id } });
    expect(f.consent.receive(event).kind).toBe("closed");
  });
  it.each([{ accountId: id }, { scope: "chat" }, { routes: [{ handle: id, catalogJson: "{}" }] }, { extra: true }])(
    "rejects a response that does not match the pinned request %j", patch => {
      const f = fixture(), state = f.consent.receive(f.event({ version: 2, setupContext }));
      if (state.kind !== "pending") throw new Error("Expected setup consent");
      expect(() => f.consent.approve(state.binding, response(patch))).toThrow();
      expect(f.consent.state().kind).toBe("pending");
      expect(f.opener.postMessage).not.toHaveBeenCalled();
    });
  it("does not evaluate a setupContext accessor", () => {
    const f = fixture(), event = f.event({ version: 2, setupContext }), getter = vi.fn(() => setupContext);
    Object.defineProperty(event.data, "setupContext", { enumerable: true, get: getter });
    expect(f.consent.receive(event).kind).toBe("waiting"); expect(getter).not.toHaveBeenCalled();
  });
});
