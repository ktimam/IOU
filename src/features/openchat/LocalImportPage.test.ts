import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync(new URL("./LocalImportPage.tsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../../app/App.tsx", import.meta.url), "utf8");
const sheet = readFileSync(new URL("../entries/SheetPage.tsx", import.meta.url), "utf8");

describe("private import route wiring", () => {
  it("is a separate encrypted route without legacy OpenChat registration/inbox/capability providers", () => {
    expect(routes).toContain('<Route path="/openchat/import" element={<LocalImportPage />} />');
    expect(page).not.toMatch(/ConsumerKeypairSync|ManifestTypesSync|DefaultCurrencySync|openchat_card|cardPrivateContext|chatSheetLinks/);
    expect(page).toContain("localAppSenderWindow(window)");
    expect(page).toContain("localImportSenderOrigin(import.meta.env.VITE_LOCAL_IMPORT_SENDER_ORIGIN)");
    expect(page).toContain("<LocalDeliveryKeyProvider><LocalImportNavigationProvider enabled={launch.framed}><Layout>");
    expect(page).toContain("<PreferencesProvider key={principal ?? state.kind}>");
    expect(page).toContain("await deliveryKeys.load(false)");
    expect(page).toContain("await decryptPendingLocalImport(");
    expect(page).not.toContain("draft.payload.entries");
  });
  it("offers only queue local state and replies with the exact origin; the sole write is an explicit Save click", () => {
    const receive = page.slice(page.indexOf("const receive = (event:"), page.indexOf('window.addEventListener("message", receive)'));
    expect(receive).toContain("receiver.receive(event)");
    expect(receive).not.toMatch(/actor\.|addEntryBatch|fetch\(|unwrapFor|save\(/);
    expect((page.match(/await addEntryBatch\(/g) ?? []).length).toBe(1);
    expect(sheet).toContain("await localImport.save([toStore])");
    expect(sheet).toContain("await localImport.save(payloads)");
    expect(page).toContain("sheetKey: key, beforeMutate: () => assertCurrent(captured)");
    expect(page).toContain("messageHandle: draft.importId");
    expect(page).toContain("const exact = saveLock.current(payloads)");
    expect(page).toContain("pending.current = true");
    expect(page).not.toMatch(/postMessage\([^\n]*["']\*["']/);
  });
  it("separates persisted acknowledgement from pending-review and reuses the PR sheet review UI", () => {
    expect(page.indexOf("buildLocalImportCommittedReceipt(binding.sessionNonce")).toBeGreaterThan(page.indexOf("await addEntryBatch("));
    expect(page).toContain("<SheetPage localImport={localImport} />");
    expect(sheet).toContain("onClick={reviewLocalImport}>Review &amp; add");
    expect(sheet).toContain("<EntryForm");
    expect(sheet).toContain("<BatchConfirmModal");
    expect(page).not.toMatch(/JSON.stringify\(review|Choose an encrypted draft|Signed-in IOU principal|Load this sheet’s private Types|Prepare setup files/);
    expect(page).not.toMatch(/<iframe|autoFocus|dangerouslySetInnerHTML/);
  });
  it("resolves only an addressed active sheet and never labels local delivery as verified OpenChat provenance", () => {
    expect(page).toContain("localImportRecipient(draft.envelope.recipientContext, { principal, backendHost, backendCanisterId })");
    expect(page).toContain("unwrap(item.active_sheet_id) === context.sheetId");
    expect(page).toContain("unwrap(item.archived_at) == null");
    expect(page).toContain("requireReadableSlots: true");
    expect(page).toContain("live.generation !== captured.generation");
    const localRow = sheet.slice(sheet.indexOf("{localImport?.ready && !localImport.saved && <li"), sheet.indexOf("{[...pending, ...visibleInbox].map"));
    expect(localRow).not.toMatch(/Verified OpenChat|p.context|chatHandle|lock-cue/);
    expect(sheet).toContain("if (isLocalImport) return;");
  });
  it("auto-binds ciphertext only to the validated native parent, not an arbitrary message source", () => {
    expect(page).toContain("active.consent?.receive(event)");
    expect(page).toContain('pending.kind === "pending" && window.parent !== window && launch.senderWindow === window.parent');
    expect(page).toContain("const approved = active.consent.approve()");
    expect(page).not.toContain("createIouLocalAppPackage");
    expect(page).not.toContain("postMessage(approved.reply, \"*\")");
  });
});
