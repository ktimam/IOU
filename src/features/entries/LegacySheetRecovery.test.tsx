import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LegacySheetRecovery } from "./LegacySheetRecovery";

describe("sheet-local legacy key recovery", () => {
  it("offers free recheck and paid confirmation without invoking either on render", () => {
    const recover = vi.fn(), retryRead = vi.fn();
    const html = renderToStaticMarkup(<LegacySheetRecovery backupPending={false} recover={recover} retryRead={retryRead} />);
    expect(html).toContain("Check for an available key (no VetKD)");
    expect(html).toContain("Recover this sheet (paid VetKD)");
    expect(html).not.toContain("Confirm paid recovery for this sheet");
    expect(html).not.toContain("Settings");
    expect(recover).not.toHaveBeenCalled();
    expect(retryRead).not.toHaveBeenCalled();
  });
  it("offers only a free backup retry when the recovered key is already available", () => {
    const recover = vi.fn(), retryRead = vi.fn();
    const html = renderToStaticMarkup(<LegacySheetRecovery backupPending recover={recover} retryRead={retryRead} />);
    expect(html).toContain("Retry securing this sheet (no VetKD)");
    expect(html).not.toContain("Recover this sheet (paid VetKD)");
    expect(recover).not.toHaveBeenCalled();
    expect(retryRead).not.toHaveBeenCalled();
  });
});
