import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRate, type FxRate } from "./fx";

const NOW = 1_800_000_000_000;
const VALID = { date: "2026-09-15", base: "USD", quote: "EGP", rate: 51.832 };
const fetchMock = vi.fn<typeof fetch>();

function response(body: unknown = VALID, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("fetchRate", () => {
  it("uses the modern single-pair API without amount, credentials, referrer, or client caching", async () => {
    fetchMock.mockResolvedValue(response());
    await expect(fetchRate(" usd ", "egp")).resolves.toEqual({
      base: "USD", quote: "EGP", rate: 51.832, fetchedAt: NOW, source: "frankfurter.dev",
    });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("https://api.frankfurter.dev/v2/rate/USD/EGP", {
      signal: expect.any(AbortSignal), credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "error",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not reuse a quote on a later request", async () => {
    fetchMock.mockResolvedValueOnce(response()).mockResolvedValueOnce(response({ ...VALID, rate: 52 }));
    expect((await fetchRate("USD", "EGP")).rate).toBe(51.832);
    expect((await fetchRate("USD", "EGP")).rate).toBe(52);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns the identity rate without a network request", async () => {
    await expect(fetchRate(" usd ", "USD")).resolves.toMatchObject({ base: "USD", quote: "USD", rate: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["", "US", "USDD", "USD/EGP", "US1", "ÜSD"])("rejects invalid currency %j before requesting", async (code) => {
    await expect(fetchRate(code, "EGP")).rejects.toThrow("Choose valid three-letter currencies");
    await expect(fetchRate("USD", code)).rejects.toThrow("Choose valid three-letter currencies");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, -Infinity, "51.832", null, undefined])("rejects invalid rate %s", async (rate) => {
    fetchMock.mockResolvedValue(response({ ...VALID, rate }));
    await expect(fetchRate("USD", "EGP")).rejects.toThrow("invalid exchange rate");
  });

  it.each([null, [], {}, "unexpected", { ...VALID, base: "EUR" }, { ...VALID, quote: "EUR" }])("rejects malformed or mismatched response %j", async (body) => {
    fetchMock.mockResolvedValue(response(body));
    await expect(fetchRate("USD", "EGP")).rejects.toThrow("invalid exchange rate");
  });

  it.each([400, 404, 422])("offers manual entry for unsupported pair HTTP %s", async (status) => {
    const reply = response({ message: "private transport detail" }, status);
    fetchMock.mockResolvedValue(reply);
    await expect(fetchRate("USD", "EGP")).rejects.toThrow("No automatic rate is available for USD to EGP. Enter the rate manually.");
    expect(reply.json).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([429, 500, 503])("offers retry/manual entry for provider HTTP %s", async (status) => {
    fetchMock.mockResolvedValue(response({}, status));
    await expect(fetchRate("USD", "EGP")).rejects.toThrow("provider is unavailable. Retry or enter the rate manually.");
  });

  it("replaces raw network errors with actionable, non-sensitive text", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch: private transport detail"));
    await expect(fetchRate("USD", "EGP")).rejects.toThrow("Could not reach the exchange-rate provider. Check your connection, retry, or enter the rate manually.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles malformed JSON without exposing the provider response", async () => {
    const reply = response();
    vi.mocked(reply.json).mockRejectedValue(new SyntaxError("private response"));
    fetchMock.mockResolvedValue(reply);
    await expect(fetchRate("USD", "EGP")).rejects.toThrow("The provider returned an invalid exchange rate. Retry or enter the rate manually.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a pre-cancelled request, including an identity rate, without fetching", async () => {
    const caller = new AbortController();
    caller.abort("private abort reason");
    await expect(fetchRate("USD", "EGP", caller.signal)).rejects.toMatchObject({ name: "AbortError", message: "Exchange-rate request cancelled." });
    await expect(fetchRate("USD", "USD", caller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels a pending fetch even when the transport ignores abort, removing its listener/timer", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const result = fetchRate("USD", "EGP", caller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    caller.abort();
    await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    pending.resolve(response());
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out a hanging fetch after ten seconds and aborts the transport", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const result = fetchRate("USD", "EGP");
    const rejected = expect(result).rejects.toThrow("lookup timed out. Retry or enter the rate manually.");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes stalled response-body reading in the same bounded deadline", async () => {
    const reply = response();
    vi.mocked(reply.json).mockReturnValue(new Promise(() => {}));
    fetchMock.mockResolvedValue(reply);
    const result = fetchRate("USD", "EGP");
    const rejected = expect(result).rejects.toThrow("lookup timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(reply.json).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("cancels while reading the body and clears the timeout on normal success", async () => {
    const reply = response();
    vi.mocked(reply.json).mockReturnValue(new Promise(() => {}));
    fetchMock.mockResolvedValue(reply);
    const caller = new AbortController();
    const result = fetchRate("USD", "EGP", caller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    caller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);

    const secondCaller = new AbortController();
    const remove = vi.spyOn(secondCaller.signal, "removeEventListener");
    fetchMock.mockResolvedValue(response());
    await fetchRate("USD", "EGP", secondCaller.signal);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("permits persisted manual and legacy provider labels", () => {
    const manual: FxRate = { base: "USD", quote: "EGP", rate: 52, fetchedAt: NOW, source: "manual" };
    const legacy: FxRate = { ...manual, source: "frankfurter.app" };
    const historical: FxRate = { ...manual, source: "manual:bank" };
    expect(manual.source).toBe("manual");
    expect(legacy.source).toBe("frankfurter.app");
    expect(historical.source).toBe("manual:bank");
  });
});
