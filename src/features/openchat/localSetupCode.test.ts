import { describe, expect, it, vi } from "vitest";
import { createSetupCode, decryptSetupCode, encryptSetupCode } from "./appSetupCodeCrypto";
import { claimLocalSetupCode } from "./localSetupCode";

const setupUrl = "https://iou.example/openchat/connect";
const accountId = "A".repeat(43), handle = "B".repeat(42) + "A";
const context = { version: 2, scope: "chat", accountId, handle };
const result = JSON.stringify({ version: 2, scope: "chat", appId: "iou", accountId,
  catalogJson: "synthetic account catalog", routes: [{ handle, catalogJson: "synthetic private route" }] });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function fixture(patch: Record<string, unknown> = {}, timing: { requesterNow?: number; recipientNow?: number; lifetimeMs?: number } = {}) {
  const material = await createSetupCode();
  let clock = timing.recipientNow ?? 1000;
  const expiresAtMs = (timing.requesterNow ?? 1000) + (timing.lifetimeMs ?? 600000);
  const request = { version: 1, appId: "iou", setupUrl, clientOrigin: "https://client.example", expiresAtMs, setupContext: context, ...patch };
  const encrypted_context = await encryptSetupCode(material.code, "context", JSON.stringify(request));
  const claimReceipt = { encrypted_context, expires_at_ms: BigInt(expiresAtMs) };
  const completions: { id: string; proof: Uint8Array; ciphertext: Uint8Array }[] = [];
  const actor = {
    claim_app_setup_code: vi.fn(async () => ({ Ok: claimReceipt } as any)),
    complete_app_setup_code: vi.fn(async (id: string, proof: Uint8Array, ciphertext: Uint8Array) => {
      completions.push({ id, proof: proof.slice(), ciphertext: ciphertext.slice() });
      return { Ok: { expires_at_ms: BigInt(expiresAtMs) } } as any;
    }),
  };
  const assertCurrent = vi.fn();
  const options = { code: material.code, actor, setupUrl, assertCurrent, now: () => clock };
  return { material, request, claimReceipt, actor, options, assertCurrent, completions, setClock: (value: number) => { clock = value; } };
}

describe("app-owned setup code session with real wire crypto", () => {
  it.each([-60000, -1, 0, 1, 2000, 60000])("accepts a nine-minute code with independent requester-to-recipient skew %i ms", async requesterSkewMs => {
    const recipientNow = 1000000;
    const requesterNow = recipientNow + requesterSkewMs;
    const f = await fixture({}, { requesterNow, recipientNow, lifetimeMs: 540000 });
    const session = await claimLocalSetupCode(f.options);
    expect(session.expiresAtMs).toBe(requesterNow + 540000);
    expect(session.expiresAtMs - recipientNow).toBeLessThanOrEqual(600000);
    expect(session.isCurrent()).toBe(true);
    expect(f.actor.claim_app_setup_code).toHaveBeenCalledTimes(1);
    expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
    session.close();
  });
  it.each([
    { requesterSkewMs: 60001, label: "more than the recipient ten-minute window" },
    { requesterSkewMs: -540000, label: "exactly expired" },
    { requesterSkewMs: -540001, label: "already expired" },
  ])("does not widen bounds for a nine-minute code that is $label", async ({ requesterSkewMs }) => {
    const recipientNow = 1000000;
    const f = await fixture({}, { requesterNow: recipientNow + requesterSkewMs, recipientNow, lifetimeMs: 540000 });
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow();
    expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it("rejects a claim reply received at its exact expiry despite a valid clock-offset request", async () => {
    const recipientNow = 1000000;
    const f = await fixture({}, { requesterNow: recipientNow + 60000, recipientNow, lifetimeMs: 540000 });
    const gate = deferred<any>();
    f.actor.claim_app_setup_code.mockReturnValue(gate.promise);
    const claim = claimLocalSetupCode(f.options);
    const rejected = expect(claim).rejects.toThrow();
    await vi.waitFor(() => expect(f.actor.claim_app_setup_code).toHaveBeenCalledOnce());
    f.setClock(Number(f.claimReceipt.expires_at_ms));
    gate.resolve({ Ok: f.claimReceipt });
    await rejected;
    expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it("retries a clock-offset completion with identical ciphertext and no expiry extension", async () => {
    const recipientNow = 1000000;
    const f = await fixture({}, { requesterNow: recipientNow + 60000, recipientNow, lifetimeMs: 540000 });
    const session = await claimLocalSetupCode(f.options);
    const expiry = session.expiresAtMs;
    f.actor.complete_app_setup_code.mockImplementationOnce(async () => { throw new Error("synthetic response lost"); });
    await expect(session.sendResult(result)).rejects.toThrow("synthetic response lost");
    expect(f.actor.complete_app_setup_code).toHaveBeenCalledTimes(1);
    const first = f.actor.complete_app_setup_code.mock.calls[0];
    f.setClock(recipientNow + 1000);
    await session.sendResult(result);
    const second = f.actor.complete_app_setup_code.mock.calls[1];
    expect(second[0]).toBe(first[0]);
    expect(second[2]).toBe(first[2]);
    expect(f.actor.complete_app_setup_code).toHaveBeenCalledTimes(2);
    expect(session.expiresAtMs).toBe(expiry);
    expect(session.isCurrent()).toBe(false);
  });
  it("claims only with the derived proof and returns immutable scoped context", async () => {
    const f = await fixture(), session = await claimLocalSetupCode({ ...f.options, code: ` ${f.material.code}\n` });
    expect(f.actor.claim_app_setup_code).toHaveBeenCalledExactlyOnceWith(f.material.requestId, f.material.claimSecret);
    expect(session.context).toEqual(context); expect(Object.isFrozen(session.context)).toBe(true);
    expect(session.clientOrigin).toBe("https://client.example"); expect(session.isCurrent()).toBe(true);
    expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it("encrypts the exact validated result, bound to app, publisher URL and request", async () => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options);
    await session.sendResult(result);
    expect(f.completions).toHaveLength(1);
    expect(f.completions[0].id).toBe(f.material.requestId); expect(f.completions[0].proof).toEqual(f.material.claimSecret);
    expect(JSON.parse(await decryptSetupCode(f.material.code, "result", f.completions[0].ciphertext))).toEqual({
      version: 1, appId: "iou", setupUrl, requestId: f.material.requestId, catalogJson: result,
    });
    expect(new TextDecoder().decode(f.completions[0].ciphertext)).not.toContain("synthetic private route");
    expect(session.isCurrent()).toBe(false);
    expect(() => session.sendResult(result)).toThrow();
  });
  it.each([
    ["app", { appId: "another-app" }], ["version", { version: 2 }], ["publisher", { setupUrl: "https://elsewhere.example/openchat/connect" }],
    ["expiry binding", { expiresAtMs: 601001 }], ["extra property", { extra: true }], ["scope", { setupContext: { ...context, scope: "message" } }],
    ["insecure client", { clientOrigin: "http://public.example" }], ["origin path", { clientOrigin: "https://client.example/path" }],
    ["origin credentials", { clientOrigin: "https://user:pass@client.example" }], ["null client", { clientOrigin: "null" }],
  ])("rejects mismatched or invalid %s before setup", async (_label, patch) => {
    const f = await fixture(patch as Record<string, unknown>);
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow(); expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it.each(["http://localhost:5190", "http://127.0.0.1:5190", "http://[::1]:5190", "http://tauri.localhost"])("accepts informational local origin %s", async clientOrigin => {
    const f = await fixture({ clientOrigin }); expect((await claimLocalSetupCode(f.options)).clientOrigin).toBe(clientOrigin);
  });
  it.each([1000n, 601001n, 9007199254740992n, 601000, "601000"])("rejects invalid server expiry %s", async expires => {
    const f = await fixture(); (f.claimReceipt as any).expires_at_ms = expires;
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow();
  });
  it.each([{ Err: "expired" }, { Ok: {}, Err: "ambiguous" }, null, {}])("rejects malformed/failed claim %j", async receipt => {
    const f = await fixture(); f.actor.claim_app_setup_code.mockResolvedValue(receipt);
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow();
  });
  it.each([[], [-1, ...Array(27).fill(0)], [256, ...Array(27).fill(0)], [0.5, ...Array(27).fill(0)], "not bytes"])("rejects malformed encrypted frames", async encrypted_context => {
    const f = await fixture(); (f.claimReceipt as any).encrypted_context = encrypted_context;
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow();
  });
  it("rejects tampered context and wrong codes", async () => {
    const f = await fixture(); f.claimReceipt.encrypted_context[15] ^= 1;
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow();
    const g = await fixture(); await expect(claimLocalSetupCode({ ...g.options, code: f.material.code })).rejects.toThrow();
  });
  it("does not claim an invalid code or stale account", async () => {
    const f = await fixture(); await expect(claimLocalSetupCode({ ...f.options, code: "123456" })).rejects.toThrow();
    f.assertCurrent.mockImplementation(() => { throw new Error("account changed"); });
    await expect(claimLocalSetupCode(f.options)).rejects.toThrow("account changed"); expect(f.actor.claim_app_setup_code).not.toHaveBeenCalled();
  });
  it("rejects an account change while the claim is in flight", async () => {
    const f = await fixture(), gate = deferred<any>(); f.actor.claim_app_setup_code.mockReturnValue(gate.promise);
    const claim = claimLocalSetupCode(f.options); const rejected = expect(claim).rejects.toThrow("changed");
    await vi.waitFor(() => expect(f.actor.claim_app_setup_code).toHaveBeenCalledOnce());
    f.assertCurrent.mockImplementation(() => { throw new Error("changed"); }); gate.resolve({ Ok: f.claimReceipt }); await rejected;
  });
  it.each(["cancel", "expiry", "clock rollback", "account"])("blocks completion after %s", async reason => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options);
    if (reason === "cancel") session.close(); if (reason === "expiry") f.setClock(601000); if (reason === "clock rollback") f.setClock(999);
    if (reason === "account") f.assertCurrent.mockImplementation(() => { throw new Error("changed"); });
    expect(session.isCurrent()).toBe(false); expect(() => session.sendResult(result)).toThrow(); expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it.each([
    { scope: "account" }, { accountId: "C".repeat(42) + "A" }, { appId: "elsewhere" }, { routes: [] },
    { routes: [{ handle: "C".repeat(42) + "A", catalogJson: "changed route" }] }, { extra: true },
  ])("rejects result scope/account/route mutations %j", async patch => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options);
    expect(() => session.sendResult(JSON.stringify({ ...JSON.parse(result), ...patch }))).toThrow(); expect(f.actor.complete_app_setup_code).not.toHaveBeenCalled();
  });
  it("retries an unknown outcome using identical ciphertext and disallows changed setup", async () => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options), failed: Uint8Array[] = [];
    f.actor.complete_app_setup_code.mockImplementationOnce(async (_id, _proof, ciphertext) => { failed.push(ciphertext.slice()); throw new Error("response lost"); });
    await expect(session.sendResult(result)).rejects.toThrow("response lost"); expect(session.isCurrent()).toBe(true);
    expect(() => session.sendResult(result + " ")).toThrow(); await session.sendResult(result);
    expect(f.actor.complete_app_setup_code).toHaveBeenCalledTimes(2); expect(f.completions[0].ciphertext).toEqual(failed[0]);
  });
  it("coalesces concurrent same-result sends into one backend call", async () => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options), gate = deferred<any>();
    f.actor.complete_app_setup_code.mockReturnValue(gate.promise);
    const first = session.sendResult(result), second = session.sendResult(result); expect(second).toBe(first);
    await vi.waitFor(() => expect(f.actor.complete_app_setup_code).toHaveBeenCalledOnce());
    gate.resolve({ Ok: { expires_at_ms: 601000n } }); await first;
  });
  it("does not report success when cancellation follows a submitted completion", async () => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options), gate = deferred<any>(); f.actor.complete_app_setup_code.mockReturnValue(gate.promise);
    const sent = session.sendResult(result), rejected = expect(sent).rejects.toThrow();
    await vi.waitFor(() => expect(f.actor.complete_app_setup_code).toHaveBeenCalledOnce()); session.close();
    gate.resolve({ Ok: { expires_at_ms: 601000n } }); await rejected; expect(session.isCurrent()).toBe(false);
    // Backend outcome may already be complete: this test asserts no false local success, not rollback.
  });
  it.each([{ Err: "expired" }, { Ok: { expires_at_ms: 601001n } }, { Ok: { expires_at_ms: 601000n }, Err: "ambiguous" }])("does not confirm an invalid completion receipt %#", async receipt => {
    const f = await fixture(), session = await claimLocalSetupCode(f.options); f.actor.complete_app_setup_code.mockResolvedValue(receipt);
    await expect(session.sendResult(result)).rejects.toThrow(); expect(session.isCurrent()).toBe(true);
  });
});
