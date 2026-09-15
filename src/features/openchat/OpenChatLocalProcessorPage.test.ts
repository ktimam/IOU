import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ effect: vi.fn(), attach: vi.fn(), cleanup: vi.fn() }));
vi.mock("react", () => ({ useEffect: calls.effect }));
vi.mock("./localProcessorBridge", () => ({ attachIouLocalProcessor: calls.attach }));
import { OpenChatLocalProcessorPage } from "./OpenChatLocalProcessorPage";
import { iouImageProcessorOptions } from "./modelImageProfiles";

beforeEach(() => { vi.clearAllMocks(); calls.attach.mockReturnValue(calls.cleanup); });
it("attaches the real processor page with the app-owned configuration and returns cleanup", () => {
  expect(OpenChatLocalProcessorPage()).toBeNull();
  expect(calls.effect).toHaveBeenCalledOnce();
  expect(calls.effect.mock.calls[0][1]).toEqual([]);
  const cleanup = calls.effect.mock.calls[0][0]();
  expect(calls.attach).toHaveBeenCalledExactlyOnceWith(undefined, iouImageProcessorOptions);
  expect(iouImageProcessorOptions.rawImageMoneyFormat).toBe("total-row");
  expect(cleanup).toBe(calls.cleanup);
});
