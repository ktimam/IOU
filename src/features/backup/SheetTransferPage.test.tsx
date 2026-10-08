import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { SheetTransferPage } from "./SheetTransferPage";

const mocks = vi.hoisted(() => ({ state: { kind: "authenticated", principal: "test-principal" } as { kind: string; principal?: string } }));
vi.mock("../auth/AuthProvider", () => ({ useAuth: () => ({ state: mocks.state }) }));
vi.mock("../auth/config", () => ({ canisterId: "test-backend" }));
vi.mock("../flows/useActor", () => ({ useActor: () => ({ actor: {}, err: null }) }));
vi.mock("../flows/SheetKeyContext", () => ({ useSheetKey: () => ({ get: vi.fn(), unwrapFor: vi.fn() }) }));
vi.mock("./backupService", () => ({ exportSheetBackup: vi.fn(), previewSheetBackupImport: vi.fn(), importSheetBackup: vi.fn() }));

function render() {
  return renderToStaticMarkup(<MemoryRouter initialEntries={["/sheet/test-sheet/transfer"]}>
    <Routes><Route path="/sheet/:sheetId/transfer" element={<SheetTransferPage />} /></Routes>
  </MemoryRouter>);
}

describe("normal sheet import/export screen", () => {
  it("clearly warns about plaintext and starts without a write confirmation", () => {
    mocks.state = { kind: "authenticated", principal: "test-principal" };
    const html = render();
    expect(html).toContain("Download unencrypted JSON");
    expect(html).toContain("Anyone with the file can read them");
    expect(html).toContain("no sign-in credentials or encryption keys");
    expect(html).toContain("Existing unrelated data will not be merged or overwritten");
    expect(html).toContain('href="/sheet/test-sheet"');
    expect(html).not.toContain(">Import into this sheet</button>");
    expect(html).not.toContain("Private app handoff");
  });
  it("does not expose transfer controls when signed out", () => {
    mocks.state = { kind: "anonymous" };
    const html = render();
    expect(html).toContain('href="/sign-in"');
    expect(html).not.toContain('type="file"');
    expect(html).not.toContain("Download unencrypted JSON");
  });
  it("waits for restored authentication instead of redirecting prematurely", () => {
    mocks.state = { kind: "loading" };
    expect(render()).toContain("Loading your account");
  });
});
