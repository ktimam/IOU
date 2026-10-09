// Mounted normal-sheet lifecycle with synthetic authenticated service boundaries.
// Real envelope/key recovery and ledger receipts have separate service/backend tests.
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntryPayload } from "../../src/features/entries/types";
import type { DurableInboxItem } from "../../src/features/openchat/durableInboxService";
const fixture = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), dismiss: vi.fn(), unwrap: vi.fn() }));
vi.mock("../../src/features/auth/config", () => ({ host: "https://icp-api.io", canisterId: "rrkah-fqaaa-aaaaa-aaaaq-cai" }));
vi.mock("../../src/features/openchat/durableInboxService", () => ({
  loadDurableInbox: fixture.load, saveDurableInboxItem: fixture.save, dismissDurableInboxItem: fixture.dismiss,
}));
import { useDurableInbox } from "../../src/features/openchat/useDurableInbox";
type Options = Parameters<typeof useDurableInbox>[0];
type Inbox = ReturnType<typeof useDurableInbox>;
const id = "A".repeat(43);
const payload: EntryPayload = { ts: Date.parse("2026-10-08T00:00:00Z"), kind: "expense", amount_minor: 1111, currency: "USD", direction: "debt", txn_type: "iou", note: "Synthetic mounted review" };
const item = { id, receipt: { inbox_id: "a".repeat(64), request_id: id, body_sha256: new Uint8Array(32), received_at_ms: 1n,
  expires_at_ms: 9999999999999n, status: { Pending: null }, replayed: false }, grant: {},
  drafts: [{ initial: payload, draftId: `local:${id}:0`, summary: "Synthetic mounted review" }], request: {},
} as unknown as DurableInboxItem;
const success = { acknowledged: true, acknowledgement: { entry_ids: [1n], accepted_count: 1, replayed: false } };
let options: Options, api: Inbox, root: Root, container: HTMLDivElement, pending: DurableInboxItem[];
function Probe() {
  api = useDurableInbox(options);
  return <section><h2>Pending from chat ({api.items.length})</h2><p role="status">{api.notice}</p>
    {api.loading && !api.items.length && <p role="status">Checking pending entries…</p>}
    {api.items.map(value => <div key={value.id}><span>{value.error ?? "Encrypted draft ready for review"}</span>
      <button disabled={api.busy || !!value.error} onClick={() => api.select(value)}>Review &amp; add</button>
      <button disabled={api.busy} onClick={() => void api.dismiss(value)}>Dismiss</button></div>)}</section>;
}
const render = async () => { await act(async () => { root.render(<StrictMode><Probe /></StrictMode>); }); };
const tick = async () => { await act(async () => { await Promise.resolve(); }); };
const visible = async () => { await act(async () => { document.dispatchEvent(new Event("visibilitychange")); }); };
const select = async () => { let review!: ReturnType<Inbox["select"]>; await act(async () => { review = api.select(api.items[0]); }); return review; };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(yes => { resolve = yes; }), resolve: (value: T) => resolve(value) }; }
function change(kind: string) {
  if (kind === "account") options = { ...options, principal: "different-user", identity: {} as Options["identity"] };
  if (kind === "identity") options = { ...options, identity: {} as Options["identity"] };
  if (kind === "actor") options = { ...options, actor: {} };
  if (kind === "sheet") options = { ...options, sheetId: "0000000000000003" };
  if (kind === "templates") options = { ...options, templates: [] };
  if (kind === "generation") options = { ...options, generation: {} };
  if (kind === "not-ready") options = { ...options, ready: false };
  if (kind === "disabled") options = { ...options, enabled: false };
}
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  pending = [item];
  options = { enabled: true, actor: {}, principal: "synthetic-user", identity: {} as Options["identity"], sheetId: "0000000000000002",
    pairId: "0000000000000001", ready: true, generation: {}, templates: [], unwrapFor: fixture.unwrap };
  fixture.unwrap.mockReset().mockResolvedValue(new Uint8Array(32));
  fixture.load.mockReset().mockImplementation(async request => { request.assertCurrent(); return { items: [...pending], errors: [] }; });
  fixture.save.mockReset().mockImplementation(async request => { request.assertCurrent(); pending = []; return success; });
  fixture.dismiss.mockReset().mockImplementation(async request => { request.assertCurrent(); pending = []; });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("durable inbox normal-sheet lifecycle", () => {
  it("shows initial pending loading until the current sheet's read completes", async () => {
    const gate = deferred<{ items: DurableInboxItem[]; errors: string[] }>(); fixture.load.mockReturnValue(gate.promise);
    await render();
    expect(api.loading).toBe(true); expect(api.busy).toBe(false);
    expect(container.textContent).toContain("Checking pending entries…");
    await act(async () => { gate.resolve({ items: [item], errors: [] }); });
    expect(api.loading).toBe(false); expect(api.items).toHaveLength(1);
    expect(container.textContent).not.toContain("Checking pending entries…");
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.dismiss).not.toHaveBeenCalled();
  });
  it("finishes loading for an empty inbox or a failed initial read", async () => {
    fixture.load.mockResolvedValue({ items: [], errors: [] });
    await render(); expect(api.loading).toBe(false); expect(api.items).toHaveLength(0);
    fixture.load.mockRejectedValue(new Error("unavailable")); change("sheet"); await render();
    expect(api.loading).toBe(false); expect(api.items).toHaveLength(0);
    expect(container.textContent).not.toContain("Checking pending entries…");
    expect(api.notice).toMatch(/could not be refreshed/);
  });
  it("shows prerequisite loading only while this sheet's Types are being loaded", async () => {
    options = { ...options, ready: false, waiting: true }; await render();
    expect(api.loading).toBe(true); expect(fixture.load).not.toHaveBeenCalled();
    options = { ...options, waiting: false }; await render();
    expect(api.loading).toBe(false); expect(fixture.load).not.toHaveBeenCalled();
    options = { ...options, waiting: true, enabled: false }; await render(); expect(api.loading).toBe(false);
    options = { ...options, enabled: true, identity: null }; await render(); expect(api.loading).toBe(false);
  });
  it("does not let a stale read clear the new sheet's loading indication", async () => {
    const old = deferred<{ items: DurableInboxItem[]; errors: string[] }>();
    const current = deferred<{ items: DurableInboxItem[]; errors: string[] }>();
    fixture.load.mockReturnValue(old.promise); await render();
    fixture.load.mockReturnValue(current.promise); change("sheet"); await render();
    await act(async () => { old.resolve({ items: [item], errors: [] }); });
    expect(api.loading).toBe(true); expect(api.items).toHaveLength(0);
    await act(async () => { current.resolve({ items: [], errors: [] }); });
    expect(api.loading).toBe(false); expect(api.items).toHaveLength(0);
  });
  it("keeps loaded entries visible and review enabled during a background refresh", async () => {
    await render(); const gate = deferred<{ items: DurableInboxItem[]; errors: string[] }>();
    fixture.load.mockReturnValue(gate.promise); await visible();
    expect(api.loading).toBe(true); expect(api.busy).toBe(false); expect(api.items).toHaveLength(1);
    expect(container.textContent).not.toContain("Checking pending entries…");
    expect(container.querySelector("button")?.disabled).toBe(false);
    await act(async () => { gate.resolve({ items: [item], errors: [] }); });
    expect(api.loading).toBe(false); expect(api.items).toHaveLength(1);
  });
  it("reloads backend pending across unmount/remount without saving or dismissing", async () => {
    await render(); expect(api.items).toHaveLength(1);
    await act(async () => { root.unmount(); }); root = createRoot(container); await render();
    expect(container.textContent).toContain("Pending from chat (1)");
    expect(fixture.load.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.dismiss).not.toHaveBeenCalled(); expect(fixture.unwrap).not.toHaveBeenCalled();
  });
  it.each(["account", "identity", "actor", "sheet", "templates", "generation", "not-ready", "disabled"])("rejects late pending reads after %s change", async kind => {
    const gate = deferred<{ items: DurableInboxItem[]; errors: string[] }>(); fixture.load.mockReturnValue(gate.promise);
    await render(); const previousCalls = [...fixture.load.mock.calls];
    fixture.load.mockResolvedValue({ items: [], errors: [] }); change(kind); await render();
    await act(async () => { gate.resolve({ items: [item], errors: [] }); });
    expect(api.items).toHaveLength(0); expect(fixture.save).not.toHaveBeenCalled();
    for (const [request] of previousCalls) expect(() => request.assertCurrent()).toThrow();
  });
  it.each(["account", "identity", "actor", "sheet", "templates", "generation", "not-ready", "disabled"])("does not save after %s changes while the sheet key loads", async kind => {
    await render(); const review = await select(), gate = deferred<Uint8Array>(); fixture.unwrap.mockReturnValue(gate.promise);
    let saving!: Promise<void>;
    await act(async () => { saving = review.save([payload]); });
    const rejection = expect(saving).rejects.toThrow(/not confirmed/);
    change(kind); pending = []; await render();
    await act(async () => { gate.resolve(new Uint8Array(32)); await rejection; });
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.dismiss).not.toHaveBeenCalled();
  });
  it("stops a saved modal from being reused under a changed account", async () => {
    await render(); const review = await select(); change("account"); await render();
    await expect(review.save([payload])).rejects.toThrow(/account, sheet or Types changed/);
    expect(fixture.unwrap).not.toHaveBeenCalled(); expect(fixture.save).not.toHaveBeenCalled();
  });
  it.each(["save", "dismiss"])("does not resurrect %s rows from an older in-flight poll", async operation => {
    await render(); const review = await select(), old = deferred<{ items: DurableInboxItem[]; errors: string[] }>();
    fixture.load.mockReturnValueOnce(old.promise); await visible();
    const oldCount = fixture.load.mock.calls.length;
    if (operation === "save") await act(async () => { await review.save([payload]); });
    else await act(async () => { await api.dismiss(item); });
    expect(api.items).toHaveLength(0);
    await act(async () => { old.resolve({ items: [item], errors: [] }); });
    expect(api.items).toHaveLength(0); expect(fixture.load.mock.calls.length).toBeGreaterThanOrEqual(oldCount);
  });
  it("retains failed saves and blocks changed fields on retry", async () => {
    await render(); const review = await select(); fixture.save.mockRejectedValue(new Error("unknown outcome"));
    await act(async () => { await expect(review.save([payload])).rejects.toThrow(/not confirmed/); });
    expect(api.items).toHaveLength(1); expect(api.notice).toMatch(/Saving was not confirmed/);
    const again = await select(); await expect(again.save([{ ...payload, note: "Changed after unknown outcome" }])).rejects.toThrow(/save was already attempted/);
    expect(fixture.save).toHaveBeenCalledOnce(); expect(fixture.dismiss).not.toHaveBeenCalled();
  });
  it("reports confirmed save with failed cleanup truthfully and safely replays the same item", async () => {
    await render(); let review = await select();
    fixture.save.mockResolvedValueOnce({ ...success, acknowledged: false });
    await act(async () => { await review.save([payload]); });
    expect(api.items).toHaveLength(1); expect(api.notice).toMatch(/Saved in IOU, but clearing the pending item was not confirmed/);
    review = await select();
    await expect(review.save([{ ...payload, amount_minor: 2222 }])).rejects.toThrow(/save was already attempted/);
    fixture.save.mockImplementationOnce(async request => { request.assertCurrent(); pending = []; return { ...success, acknowledgement: { ...success.acknowledgement, replayed: true } }; });
    await act(async () => { await review.save([payload]); });
    expect(fixture.save).toHaveBeenCalledTimes(2); expect(api.items).toHaveLength(0);
    expect(api.notice).toMatch(/Already saved in IOU.*later form changes were not applied/);
    expect(fixture.save.mock.calls.map(call => call[0].item.id)).toEqual([id, id]);
  });
  it("prevents double-click saves while one operation is pending", async () => {
    await render(); const review = await select(), gate = deferred<typeof success>(); fixture.save.mockReturnValueOnce(gate.promise);
    let first!: Promise<void>; await act(async () => { first = review.save([payload]); await Promise.resolve(); });
    expect(api.busy).toBe(true); await expect(review.save([payload])).rejects.toThrow(/already being handled/);
    expect(fixture.save).toHaveBeenCalledOnce();
    pending = []; await act(async () => { gate.resolve(success); await first; }); expect(api.busy).toBe(false);
  });
  it("retains item-level errors and allows only explicit dismissal", async () => {
    pending = [{ ...item, drafts: undefined, error: "Reconnect IOU: key is unavailable" }]; await render();
    expect(container.textContent).toContain("key is unavailable");
    expect(() => api.select(api.items[0])).toThrow(/key is unavailable/);
    expect(fixture.save).not.toHaveBeenCalled(); expect(fixture.dismiss).not.toHaveBeenCalled();
    await act(async () => { await api.dismiss(api.items[0]); });
    expect(api.items).toHaveLength(0); expect(fixture.save).not.toHaveBeenCalled(); expect(api.notice).toMatch(/No ledger entry was added/);
  });
  it("retains pending when dismissal fails", async () => {
    await render(); fixture.dismiss.mockRejectedValue(new Error("ack response lost"));
    await act(async () => { await api.dismiss(item); });
    expect(api.items).toHaveLength(1); expect(api.notice).toMatch(/Dismissal was not confirmed/); expect(fixture.save).not.toHaveBeenCalled();
  });
  it("preserves the last known pending state when a refresh fails", async () => {
    await render(); fixture.load.mockRejectedValue(new Error("unavailable")); await visible();
    expect(api.items).toHaveLength(1); expect(api.notice).toMatch(/could not be refreshed/);
  });
  it("does not poll while saving and does not automatically save on visibility changes", async () => {
    await render(); const review = await select(), gate = deferred<typeof success>(); fixture.save.mockReturnValueOnce(gate.promise);
    let saving!: Promise<void>; await act(async () => { saving = review.save([payload]); await Promise.resolve(); });
    const reads = fixture.load.mock.calls.length; await visible(); expect(fixture.load).toHaveBeenCalledTimes(reads);
    pending = []; await act(async () => { gate.resolve(success); await saving; }); await tick();
    await visible(); expect(fixture.save).toHaveBeenCalledOnce();
  });
});
