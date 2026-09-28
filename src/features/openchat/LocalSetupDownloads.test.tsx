import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalSetupDownloadFiles, createLocalSetupDownloadOwner, localSetupContextMatches, LocalSetupDownloads, verifiedLocalSetupProcessor, type LocalSetupContext } from "./LocalSetupDownloads";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const source = new TextEncoder().encode("export const version = 1;").buffer;

function urls() {
  const create = vi.spyOn(URL, "createObjectURL").mockReturnValueOnce("blob:catalog").mockReturnValueOnce("blob:processor");
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { create, revoke };
}

function fixture() {
  urls();
  const prepared = createLocalSetupDownloadFiles({ schemaVersion: 1, privateTypes: ["TEST ONLY"] }, source);
  const anchors: { href: string; download: string; click: ReturnType<typeof vi.fn> }[] = [];
  const createElement = vi.fn(() => { const a = { href: "", download: "", click: vi.fn() }; anchors.push(a); return a; });
  vi.stubGlobal("document", { createElement });
  const props = { files: prepared.files, disabled: false, assertCurrent: vi.fn(), onRequest: vi.fn(), onError: vi.fn() };
  // Exercise the actual stateless component's event handlers; no simulated browser save claim.
  const buttons = (options = props) => LocalSetupDownloads(options).props.children[1].map((paragraph: any) => paragraph.props.children);
  return { prepared, anchors, createElement, props, buttons };
}

describe("separate private setup downloads", () => {
  it("releases allocated URLs on unmount even before state publication", () => {
    const { revoke } = urls();
    const owner = createLocalSetupDownloadOwner();
    owner.replace(createLocalSetupDownloadFiles({}, source));
    // Cleanup owns the allocation immediately; no React state commit is needed.
    owner.clear(); owner.clear();
    expect(revoke.mock.calls).toEqual([["blob:catalog"], ["blob:processor"]]);
  });
  it("releases the previous resource synchronously on replacement", () => {
    const owner = createLocalSetupDownloadOwner();
    const first = { dispose: vi.fn() }; const second = { dispose: vi.fn() };
    owner.replace(first); owner.replace(second);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    owner.clear();
    expect(second.dispose).toHaveBeenCalledOnce();
  });
  it("prepares two exact files without triggering a download", async () => {
    const { create, revoke } = urls();
    const prepared = createLocalSetupDownloadFiles({ privateTypes: ["TEST ONLY"] }, source);
    expect(prepared.files.map((file) => file.name)).toEqual(["iou-private-local-app.json", "iou-local-processor.js"]);
    expect(create).toHaveBeenCalledTimes(2);
    const [catalogBlob] = create.mock.calls[0];
    const [processorBlob] = create.mock.calls[1];
    expect(await (catalogBlob as Blob).text()).toContain('"TEST ONLY"');
    expect((catalogBlob as Blob).type).toBe("application/json");
    expect(await (processorBlob as Blob).arrayBuffer()).toEqual(source);
    expect((processorBlob as Blob).type).toBe("text/javascript");
    prepared.dispose(); prepared.dispose();
    expect(revoke.mock.calls).toEqual([["blob:catalog"], ["blob:processor"]]);
  });

  it("cleans up the first URL if creating the second fails", () => {
    const { create, revoke } = urls();
    create.mockReset().mockReturnValueOnce("blob:catalog").mockImplementationOnce(() => { throw new Error("unavailable"); });
    expect(() => createLocalSetupDownloadFiles({}, source)).toThrow("unavailable");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:catalog");
  });

  it("renders two buttons, not permanent download links or a misleading success message", () => {
    const { props, createElement } = fixture();
    const html = renderToStaticMarkup(<LocalSetupDownloads {...props} />);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain("Download public processor");
    expect(html).toContain("Check your browser");
    expect(html).not.toMatch(/<a\b|href=|Downloaded|successfully saved/);
    expect(createElement).not.toHaveBeenCalled();
    expect(props.onRequest).not.toHaveBeenCalled();
  });

  it.each([0, 1])("one click downloads only file %s, synchronously and without fetching", (index) => {
    const { props, buttons, anchors, createElement } = fixture();
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    buttons()[index].props.onClick();
    expect(props.assertCurrent).toHaveBeenCalledOnce();
    expect(createElement).toHaveBeenCalledExactlyOnceWith("a");
    expect(anchors[0].href).toBe(props.files[index].href);
    expect(anchors[0].download).toBe(props.files[index].name);
    expect(anchors[0].click).toHaveBeenCalledOnce();
    expect(props.onRequest).toHaveBeenCalledExactlyOnceWith(props.files[index]);
    expect(props.onError).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not request a file when the captured session has expired", () => {
    const { props, buttons, createElement } = fixture();
    props.assertCurrent.mockImplementation(() => { throw new Error("changed"); });
    buttons()[1].props.onClick();
    expect(createElement).not.toHaveBeenCalled();
    expect(props.onRequest).not.toHaveBeenCalled();
    expect(props.onError).toHaveBeenCalledOnce();
  });

  it("does not request either file while disabled", () => {
    const { props, buttons, createElement } = fixture();
    for (const button of buttons({ ...props, disabled: true })) {
      expect(button.props.disabled).toBe(true);
      button.props.onClick();
    }
    expect(createElement).not.toHaveBeenCalled();
    expect(props.assertCurrent).not.toHaveBeenCalled();
    expect(props.onRequest).not.toHaveBeenCalled();
  });

  it("reports a request error without claiming a request when the browser action throws", () => {
    const { props, buttons, createElement } = fixture();
    createElement.mockImplementation(() => { throw new Error("unavailable"); });
    buttons()[0].props.onClick();
    expect(props.onRequest).not.toHaveBeenCalled();
    expect(props.onError).toHaveBeenCalledOnce();
  });
});

describe("prepared setup context invalidation", () => {
  const context = (): LocalSetupContext => ({ principal: "test-user", pairId: "test-pair", sheetId: "test-sheet",
    defaultCurrency: "USD", shared: [], actor: {}, identity: {}, binding: undefined, readyGeneration: {}, ready: true });
  it("allows unchanged standalone setup without a handoff binding", () => {
    const captured = context();
    expect(localSetupContextMatches(captured, { ...captured })).toBe(true);
  });
  it.each(["principal", "pairId", "sheetId", "defaultCurrency", "shared", "actor", "identity", "binding", "readyGeneration"] as const)("invalidates a changed %s before download", (field) => {
    const captured = context();
    const live = { ...captured, [field]: typeof captured[field] === "string" ? "changed" : {} };
    expect(localSetupContextMatches(captured, live)).toBe(false);
  });
  it("invalidates a removed or replacement binding even without its own liveness function", () => {
    const captured = { ...context(), binding: {} };
    expect(localSetupContextMatches(captured, { ...captured, binding: undefined })).toBe(false);
    expect(localSetupContextMatches(captured, { ...captured, binding: {} })).toBe(false);
  });
  it.each(["actor", "identity", "readyGeneration"] as const)("requires a live %s", (field) => {
    const missing = { ...context(), [field]: undefined };
    expect(localSetupContextMatches(missing, missing)).toBe(false);
  });
  it("invalidates loading context", () => {
    const captured = context();
    expect(localSetupContextMatches(captured, { ...captured, ready: false })).toBe(false);
  });
});

describe("setup processor verification", () => {
  async function responses(patch: Record<string, unknown> = {}, bytes = source, ok = true) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", source)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const metadata = { sha256: digest, byteLength: source.byteLength, ...patch };
    const fetcher = vi.fn().mockResolvedValueOnce({ ok, json: async () => metadata })
      .mockResolvedValueOnce({ ok: true, arrayBuffer: async () => bytes });
    vi.stubGlobal("fetch", fetcher);
    return { metadata, fetcher };
  }
  it("verifies exact bytes and makes only two credential-free setup requests", async () => {
    const { metadata, fetcher } = await responses();
    expect(await verifiedLocalSetupProcessor()).toEqual({ metadata, source });
    expect(fetcher.mock.calls).toEqual([
      ["/openchat/local-processor-v1.sha256.json", { credentials: "omit", cache: "no-store" }],
      ["/openchat/local-processor-v1.js", { credentials: "omit", cache: "no-store" }],
    ]);
  });
  it.each([{ sha256: "invalid" }, { byteLength: 0 }, { byteLength: 0.5 }, { byteLength: 524289 }])("rejects invalid metadata %j", async (patch) => {
    await responses(patch);
    await expect(verifiedLocalSetupProcessor()).rejects.toThrow("Invalid processor metadata");
  });
  it("rejects HTTP failure", async () => {
    await responses({}, source, false);
    await expect(verifiedLocalSetupProcessor()).rejects.toThrow("Processor download failed");
  });
  it("rejects mismatched digest", async () => {
    await responses({ sha256: "0".repeat(64) });
    await expect(verifiedLocalSetupProcessor()).rejects.toThrow("Processor integrity mismatch");
  });
  it("rejects mismatched byte length", async () => {
    await responses({ byteLength: source.byteLength + 1 });
    await expect(verifiedLocalSetupProcessor()).rejects.toThrow("Processor integrity mismatch");
  });
});
