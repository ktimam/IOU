import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VaultActions } from "./AccountVaultControls";
import { VaultUnlockRequiredError } from "./accountVault";

describe("manager-backed account encryption controls", () => {
  it("requires the manager entry during setup with no encryption-passkey actions or skip", () => {
    const html = renderToStaticMarkup(<VaultActions actor={{}} principal="alice" ready required />);
    expect(html).toContain("prepares your recovery entry automatically when needed");
    expect(html).not.toContain("Prepare recovery entry</button>");
    expect(html).toContain("without another setup charge");
    expect(html).toContain("keys are kept in this browser if saving fails or is cancelled");
    expect(html).not.toMatch(/passkey|PRF|recovery code|Continue to IOU|Skip|Set up account encryption/i);
  });
  it("offers saved manager recovery and explicit advanced recovery without sending a secret on render", () => {
    const html = renderToStaticMarkup(<VaultActions actor={{}} principal="alice" ready={false} required />);
    expect(html).toContain("Password-manager recovery");
    expect(html).toContain("without another VetKD charge");
    expect(html).toContain("Recover encryption access (paid VetKD)");
    expect(html).toContain("Lost your recovery entry and remembered device keys?");
    expect(html).toContain("Start a new emergency attempt (may pay again)");
    expect(html).not.toMatch(/passkey|PRF|recovery code|<input|Continue to IOU/i);
  });
  it("settings offer manager recovery without encryption-passkey actions", () => {
    const html = renderToStaticMarkup(<VaultActions actor={{}} principal="alice" ready />);
    expect(html).toContain("Checking your saved recovery entry");
    expect(html).not.toMatch(/passkey|PRF|recovery code|Continue to IOU/i);
  });
  it("locked-key errors only direct users to supported recovery paths", () => {
    const message = new VaultUnlockRequiredError().message;
    expect(message).toContain("password-manager recovery entry");
    expect(message).toContain("a device that remembers its keys");
    expect(message).toContain("explicit paid emergency recovery");
    expect(message).toContain("No paid recovery was started");
    expect(message).not.toMatch(/passkey|PRF/i);
  });
});
