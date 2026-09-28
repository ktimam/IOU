import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./LocalImportPage.tsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../app/App.tsx", import.meta.url), "utf8");

describe("private import route wiring", () => {
  it("is a separate route without legacy OpenChat registration/inbox/capability providers", () => {
    expect(routes).toContain('<Route path="/openchat/import" element={<LocalImportPage />} />');
    expect(page).not.toMatch(/ConsumerKeypairSync|ManifestTypesSync|DefaultCurrencySync|openchat_card|cardPrivateContext|chatSheetLinks/);
    expect(page).toContain("window.parent === window && window.opener");
    expect(page).toContain("localImportSenderOrigin(import.meta.env.VITE_LOCAL_IMPORT_SENDER_ORIGIN)");
  });
  it("offers only queue local state and replies with the exact origin; the sole write is an explicit Save click", () => {
    const receive = page.slice(page.indexOf("const receive = (event:"), page.indexOf('window.addEventListener("message", receive)'));
    expect(receive).toContain("receiver.receive(event)");
    expect(receive).not.toMatch(/actor\.|addEntryBatch|fetch\(|unwrapFor|save\(/);
    expect((page.match(/await addEntryBatch\(/g) ?? []).length).toBe(1);
    expect(page).toContain('onClick={() => void save()}');
    expect(page).toContain("sheetKey: key, beforeMutate: stillCurrent");
    expect(page).toContain("messageHandle: review.importId");
    expect(page).toContain("setLocked(true)");
    expect(page).not.toMatch(/postMessage\([^\n]*["']\*["']/);
  });
  it("separates persisted acknowledgement from pending-review and renders every stored field", () => {
    expect(page.indexOf("buildLocalImportCommittedReceipt(binding.sessionNonce")).toBeGreaterThan(page.indexOf("await addEntryBatch("));
    expect(page).toContain("JSON.stringify(review.payloads, null, 2)");
    expect(page).toContain("Review exact encrypted entry contents");
    expect(page).toContain("Signed-in IOU principal");
    expect(page).toContain("Load this sheet’s private Types");
    expect(page).not.toMatch(/<iframe|autoFocus|dangerouslySetInnerHTML/);
  });
  it("prepares verified setup separately from downloads and invalidates stale private context", () => {
    expect(page).not.toContain('download("iou-private-local-app.json"');
    expect(page).not.toContain("Downloaded the private setup catalog and public processor");
    expect(page).toContain("setupPending.current");
    expect(page).toContain("const { metadata, source } = await verifiedLocalSetupProcessor();\n      assertSetupCurrent(captured);");
    expect(page).toContain("localSetupContextMatches(captured, setupContext.current)");
    expect(page).toContain("mounted.current = false; setupOwner.current.clear()");
    expect(page).toContain("setupOwner.current.replace(prepared);\n      setSetup(prepared)");
    expect(page).toContain("if (setup && !setupCurrent) clearSetup()");
    expect(page).toContain("assertCurrent={() => assertSetupCurrent(setup.context)}");
    expect(page).toContain("Check your browser’s Downloads list to confirm it was saved.");
  });
});
