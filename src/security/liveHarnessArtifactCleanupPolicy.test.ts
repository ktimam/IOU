import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function liveHarness(name: string): string {
  return readFileSync(path.join(process.cwd(), "scripts/live", name), "utf8");
}

const migratedHarnesses = [
  "verify-nomodel-guide.ts",
  "verify-app-card-edit.ts",
  "verify-app-card-multi.ts",
  "verify-default-currency.ts",
  "verify-extraction-gate.ts",
  "verify-multi-entry.ts",
  "verify-routed-card-types.ts",
] as const;

const exactProducerHarnesses = migratedHarnesses.filter(
  (name) => name !== "verify-nomodel-guide.ts",
);

const depositingHarnesses = [
  "verify-app-card-edit.ts",
  "verify-app-card-multi.ts",
  "verify-default-currency.ts",
] as const;

describe("live card harness artifact-cleanup policy", () => {
  for (const name of migratedHarnesses) {
    it(`${name} finalizes exact cleanup before closing every disposable tab scope`, () => {
      const source = liveHarness(name);
      expect(source).toContain("new OpenChatArtifactScope(");
      expect(source).toContain("await artifactScope.begin()");

      const beforeEachClose = source.split("await tabs.close()");
      expect(beforeEachClose.length).toBeGreaterThan(1);
      for (const segment of beforeEachClose.slice(0, -1)) {
        expect(segment).toContain("finalizeOpenChatArtifactCleanup(");
      }
    });
  }

  for (const name of exactProducerHarnesses) {
    it(`${name} binds cleanup to run-unique source and card evidence`, () => {
      const source = liveHarness(name);
      expect(source).toContain("artifactScope.expectExactText(");
      expect(source).toContain(
        name === "verify-multi-entry.ts"
          ? "artifactScope.expectCardRows("
          : "artifactScope.expectCardInputs(",
      );
    });
  }

  it("migrated harnesses have no mobile-only capture selector", () => {
    for (const name of migratedHarnesses) {
      const source = liveHarness(name);
      const directMobileSelectors = source.match(/locator\(["']\.message_text["']\)/g) ?? [];
      expect(directMobileSelectors, `${name} has a stale mobile-only capture selector`).toEqual([]);
    }
  });

  it("the routed-card and browser-model QC gesture only on exact fresh stable coordinates", () => {
    for (const name of ["verify-routed-card-types.ts", "v2-browser-model-e2e.ts"] as const) {
      const source = liveHarness(name);
      expect(source).toContain("await artifactScope.begin()");
      expect(source).toContain("waitForExactTextMessage(");
      expect(source).toContain("exactOpenChatMessageWrapper(");
      if (name === "verify-routed-card-types.ts") {
        expect(source).toContain("openProposeAction(page, sourceMessage)");
      } else {
        expect(source).toContain(".locator(OPENCHAT_MESSAGE_TEXT_SELECTOR)");
      }
      expect(source).not.toMatch(/\.message_text[\s\S]{0,80}\.last\(\)/);
    }
  });

  it("tracked batch-7 negative message evidence uses the cross-tree selector", () => {
    const source = liveHarness("verify-batch7-oc.ts");
    expect(source).toContain(".locator(OPENCHAT_MESSAGE_TEXT_SELECTOR)");
    expect(source).not.toContain('.locator(".message_text")');
  });

  it("the per-chat routing journey never navigates or retains the user's existing tabs", () => {
    const source = liveHarness("verify-per-chat-routing.ts");
    expect(source).toContain("new TemporaryTabScope()");
    expect(source).toContain("await tabs.open(");
    expect(source).toContain("routingPages.add(routingPage)");
    expect(source).toContain("await routingPage.close(");
    expect(source).toContain("finally {");
    expect(source).toContain("await tabs.close()");
    expect(source).toContain("const openchat = await tabs.open(openchatSource,");
    expect(source).not.toContain("await openchatSource.goto(");
  });

  it("the shared manual-extraction URL helper executes browser-native code", () => {
    const source = liveHarness("temporaryBrowserTab.ts");
    expect(source).toContain("await page.evaluate(`");
    expect(source).not.toContain("await page.evaluate(() =>");
  });

  it("the shared prompt override is uniquely owned and never clobbers another hook", () => {
    const source = liveHarness("temporaryBrowserTab.ts");
    expect(source).toContain("export type ManualPromptOverrideHandle");
    expect(source).toContain("if (root.__iouJourneyPromptProbe)");
    expect(source).toContain("manual prompt override is already installed");
    expect(source).toContain("state.ownerToken !== ownerToken");
    expect(source).toContain("window.prompt !== state.replacementPrompt");
    expect(source).toContain("manual prompt override ownership changed");
    expect(source).not.toContain("if (previous) window.prompt = previous.originalPrompt");
  });

  it("the image fixture omits redundant message text while text fixtures retain exact source text", () => {
    const journey = liveHarness("journey-fanout.ts");
    const journeyExtraction = journey.indexOf("const extraction = JSON.stringify({");
    expect(journeyExtraction).toBeGreaterThanOrEqual(0);
    expect(journey.slice(journeyExtraction, journey.indexOf("let proposerQcPage", journeyExtraction)))
      .toContain(
        "? {}\n      : { message: journeySourceText({ imagePath: SOURCE_IMAGE_PATH, nonce })! }",
      );
    expect(journey).not.toContain("IMAGE_FIXTURE_MESSAGE_EVIDENCE");

    const routed = liveHarness("verify-routed-card-types.ts");
    const routedExtraction = routed.slice(
      routed.indexOf("const extraction = JSON.stringify({"),
      routed.indexOf("let artifactScope", routed.indexOf("const extraction = JSON.stringify({")),
    );
    expect(routedExtraction).toContain("message,");

    const multi = liveHarness("verify-multi-entry.ts");
    expect(multi).toContain("const extraction = JSON.stringify(expected);");
    expect(multi).not.toContain("message: _message");

    const edit = liveHarness("verify-app-card-edit.ts");
    const editExtraction = edit.slice(
      edit.indexOf("const ex = JSON.stringify({"),
      edit.indexOf("const h =", edit.indexOf("const ex = JSON.stringify({")),
    );
    expect(editExtraction).toContain("message: sourceText");

    const appMulti = liveHarness("verify-app-card-multi.ts");
    const appMultiExtraction = appMulti.slice(
      appMulti.indexOf("const arr = JSON.stringify(["),
      appMulti.indexOf("dialogHandler =", appMulti.indexOf("const arr = JSON.stringify([")),
    );
    expect(appMultiExtraction.match(/message: sourceText/g) ?? []).toHaveLength(2);

    const defaultCurrency = liveHarness("verify-default-currency.ts");
    const defaultExtraction = defaultCurrency.slice(
      defaultCurrency.indexOf("const ex = JSON.stringify({"),
      defaultCurrency.indexOf("const h =", defaultCurrency.indexOf("const ex = JSON.stringify({")),
    );
    expect(defaultExtraction).toContain("message: sourceText");

    const gate = liveHarness("verify-extraction-gate.ts");
    const positiveStart = gate.indexOf("await propose(", gate.indexOf("const afterZero"));
    const positiveControl = gate.slice(
      positiveStart,
      gate.indexOf("let afterPos", positiveStart),
    );
    expect(positiveControl).toContain("message: positiveText");
  });

  it("the no-model boundary binds cleanup to each exact fresh source and never guesses at a card", () => {
    const source = liveHarness("verify-nomodel-guide.ts");
    expect(source).not.toContain("expectSingleFreshCard");
    expect(source).toContain("artifactScope.expectExactText(text)");
    expect(source.match(/await sendFreshSource\(page, artifactScope,/g)).toHaveLength(2);
    expect(source.match(/await proposeExactMessage\(page, sourceMessage\)/g)).toHaveLength(2);
    expect(source).toContain("exactOpenChatMessageWrapper(page, source.message)");
    expect(source).toContain("freshness alone cannot prove");
    expect(source).toContain('node.classList.contains("me")');
    expect(source).not.toContain("proposeExistingMessage");
    expect(source).not.toMatch(/getByText\("Propose action"[\s\S]{0,100}\.last\(\)/);
    expect(source).not.toContain("no existing message with a Propose action menu");
  });

  it("the routed private-type proof no longer leaves a pending card for inspection", () => {
    const source = liveHarness("verify-routed-card-types.ts");
    expect(source).toContain("const cardMessage = await artifactScope.trackExactCard(loaded.card, [note])");
    expect(source).toContain("installManualPromptOverride,");
    expect(source).toContain("readManualPromptProbe,");
    expect(source).toContain("removeManualPromptOverride,");
    expect(source).toContain("promptOverride = await installManualPromptOverride(page, extraction)");
    expect(source).toContain("finalPromptProbe.promptCalls !== 1");
    expect(source).toContain("await removeManualPromptOverride(page, promptOverride)");
    expect(source).not.toContain('page.on("dialog"');
    expect(source).not.toContain("dialog.accept(");
    expect(source).toContain("source message never became confirmed with an available Propose action");
    expect(source).toContain("date: new Date(Date.now() + 86_400_000)");
    expect(source).toContain('getByRole("button", { name: "Cancel", exact: true })');
    expect(source).toContain("exactOpenChatMessageWrapper(page, message).locator(");
    expect(source).toContain('".action-card .state-cancelled"');
    expect(source).toContain("waitForExactCardCancellation(page, cardMessage, cancel)");
    expect(source).toContain('await page.reload({ waitUntil: "domcontentloaded" })');
    expect(source).not.toContain('loaded.card.getByText("cancelled"');
    expect(source).toContain("the exact proof card was cancelled before message cleanup");
    expect(source).not.toContain('document.querySelectorAll(".action-card").length >');
    expect(source).toContain('locator(".toast").filter({ hasText: "Action failed" })');
    expect(source).toContain("OpenChat rejected the proposed card:");
    expect(source).not.toMatch(/pending card can be inspected later/i);
    const finalPromptCheck = source.indexOf("await finalizePromptOverride();");
    const cancelClick = source.indexOf("await cancel.click()", finalPromptCheck);
    const cancellationFallback = source.indexOf(
      "await waitForExactCardCancellation(page, cardMessage, cancel)",
      cancelClick,
    );
    expect(finalPromptCheck).toBeGreaterThanOrEqual(0);
    expect(cancelClick).toBeGreaterThan(finalPromptCheck);
    expect(cancellationFallback).toBeGreaterThan(cancelClick);
  });

  it("the routed private-type proof clears a fresh-tab startup overlay before clicking a chat", () => {
    const source = liveHarness("verify-routed-card-types.ts");
    const helper = source.indexOf("async function dismissBlockingOpenChatOverlays(");
    const dismiss = source.indexOf("await dismissBlockingOpenChatOverlays(page)");
    const chatRow = source.indexOf('.locator(".chat-summary, .chat_summary")', dismiss);
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(dismiss).toBeGreaterThan(helper);
    expect(chatRow).toBeGreaterThan(dismiss);
    expect(source).toContain("getComputedStyle(overlay).pointerEvents !== \"none\"");
  });

  it("the routed private-type proof executes all page scripts as browser-native source", () => {
    const source = liveHarness("verify-routed-card-types.ts");
    expect(source).not.toMatch(/page\.evaluate\s*\(\s*(?:async\s*)?\(?\s*[\w,{[]/);
    expect(source).not.toMatch(/page\.waitForFunction\s*\(\s*(?:async\s*)?\(?\s*[\w,{[]/);
    expect(source).not.toContain("page.evaluate(() =>");
    expect(source).not.toContain("page.evaluate((value) =>");
    expect(source).toContain('.replace(/\\\\s+/g, " ")');
  });

  it("supported journeys select Propose action by its accessible identity, never an SVG path", () => {
    for (const name of [
      "verify-routed-card-types.ts",
      "journey-fanout.ts",
    ] as const) {
      const source = liveHarness(name);
      expect(source).not.toContain('path[d^="M7.5,5.6"]');
      expect(source).toContain('getByRole("menuitem", { name: "Propose action", exact: true })');
      expect(source).not.toContain('getByText("Propose action", { exact: true })');
    }
  });

  for (const name of depositingHarnesses) {
    it(`${name} acknowledges both fan-out envelopes by exact payload after the test`, () => {
      const source = liveHarness(name);
      expect(source).toContain("new ActionInboxArtifactScope(");
      expect(source).toContain("await inboxScope.begin()");
      expect(source).toContain("inboxScope.arm()");
      expect(source).toContain('label: "father"');
      expect(source).toContain('label: "manager"');
      const inboxFinalize = source.lastIndexOf("finalizeActionInboxArtifactCleanup(");
      const chatFinalize = source.lastIndexOf("finalizeOpenChatArtifactCleanup(");
      const close = source.lastIndexOf("await tabs.close()");
      expect(inboxFinalize).toBeGreaterThanOrEqual(0);
      expect(chatFinalize).toBeGreaterThan(inboxFinalize);
      expect(close).toBeGreaterThan(chatFinalize);
    });
  }

  it("the end-to-end multi-entry proof cleans the confirmer delivery and any proposer leak", () => {
    const source = liveHarness("verify-multi-entry.ts");
    expect(source).toContain("cleanupIouBatch(confirmerIOU, expected");
    expect(source).toContain("cleanupIouBatch(proposerIOU, expected");
    expect(source).toContain("trackExactCardRows(senderCard.card, publicRows)");
    expect(source).toContain("cleanup returned both inbox buckets to their pre-run counts");
    expect(source).not.toContain("new ActionInboxArtifactScope(");
  });

  it("the shared helper refuses recipient-only and unbound deletion paths", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    expect(source).toContain("candidate.owned");
    expect(source).toContain("waitForExactTextMessage(exactText");
    expect(source).toContain('node.closest(".message_text") === null');
    expect(source).toContain("unsupported cleanup expectation");
    expect(source).toContain('name: "Delete for me", exact: true');
    expect(source).toContain('name: "Delete", exact: true');
    expect(source).toContain("const maxPersistenceAttempts = 3");
    expect(source).toContain("const backendDeleteSettleMs = 5_000");
    expect(source).toContain("deleteExactArtifactPersistently(");
    expect(source).toContain("deletion reappeared after 3 exact retries");
    expect(source).not.toContain("single_fresh_card");
    expect(source).not.toContain("expectSingleFreshCard");
  });

  it("retries only the same exact evidence-bound owned coordinates after backend settle", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    const helper = source.indexOf("async function deleteExactArtifactPersistently(");
    const deleteAttempt = source.indexOf("await deleteExactArtifact(page, artifact)", helper);
    const settle = source.indexOf("await page.waitForTimeout(backendDeleteSettleMs)", deleteAttempt);
    const reload = source.indexOf('await page.reload({ waitUntil: "domcontentloaded" })', settle);
    const exactWrapper = source.indexOf("exactOpenChatMessageWrapper(page, artifact.message)", reload);
    const exactEvidence = source.indexOf("await evidencePresent(page, artifact)", exactWrapper);
    const absentEvidenceGate = source.indexOf("if (!originalEvidencePresent)", exactEvidence);
    const deletionProof = source.indexOf(
      "await exactArtifactDeletionProven(page, artifact.message)",
      absentEvidenceGate,
    );
    const ownership = source.indexOf("await senderOwned(wrapper)", exactEvidence);
    const coordinates = source.indexOf("await messageRefFromWrapper(wrapper", ownership);
    const stableGuard = source.indexOf("sameMessageCoordinates(observed, artifact.message)", coordinates);

    expect(helper).toBeGreaterThanOrEqual(0);
    expect(deleteAttempt).toBeGreaterThan(helper);
    expect(settle).toBeGreaterThan(deleteAttempt);
    expect(reload).toBeGreaterThan(settle);
    expect(exactWrapper).toBeGreaterThan(reload);
    expect(exactEvidence).toBeGreaterThan(exactWrapper);
    expect(absentEvidenceGate).toBeGreaterThan(exactEvidence);
    expect(deletionProof).toBeGreaterThan(absentEvidenceGate);
    expect(ownership).toBeGreaterThan(exactEvidence);
    expect(coordinates).toBeGreaterThan(ownership);
    expect(stableGuard).toBeGreaterThan(coordinates);
    expect(source.slice(helper, source.indexOf("export class OpenChatArtifactScope"))).not.toContain(
      "MESSAGE_WRAPPER_SELECTOR",
    );
  });

  it("accepts an exact persisted OpenChat tombstone after reload", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    const proof = source.indexOf("async function exactArtifactDeletionProven(");
    const absence = source.indexOf("if (wrapperCount === 0) return true", proof);
    const classic = source.indexOf('wrapper.locator(".message-bubble > .deleted")', absence);
    const mobile = source.indexOf('wrapper.locator(".message_bubble_content")', classic);
    const textFallback = source.indexOf(
      "MESSAGE_DELETED_TEXT.test(normalized(await mobileContent.innerText()))",
      mobile,
    );
    const persistent = source.indexOf("async function deleteExactArtifactPersistently(");
    const evidenceRetry = source.indexOf("await evidencePresent(page, artifact)", persistent);
    const absentEvidenceGate = source.indexOf("if (!originalEvidencePresent)", evidenceRetry);
    const afterReloadProof = source.indexOf(
      "await exactArtifactDeletionProven(page, artifact.message)",
      absentEvidenceGate,
    );

    expect(proof).toBeGreaterThanOrEqual(0);
    expect(absence).toBeGreaterThan(proof);
    expect(classic).toBeGreaterThan(absence);
    expect(mobile).toBeGreaterThan(classic);
    expect(textFallback).toBeGreaterThan(mobile);
    expect(evidenceRetry).toBeGreaterThan(persistent);
    expect(absentEvidenceGate).toBeGreaterThan(evidenceRetry);
    expect(afterReloadProof).toBeGreaterThan(absentEvidenceGate);
  });

  it("continues exact cleanup after one artifact fails", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    const loop = source.indexOf("for (const artifact of artifacts)");
    const guardedDelete = source.indexOf("try {", loop);
    const persistentDelete = source.indexOf(
      "await deleteExactArtifactPersistently(this.page, artifact)",
      guardedDelete,
    );
    const failureCapture = source.indexOf("report.errors.push(", persistentDelete);
    expect(loop).toBeGreaterThanOrEqual(0);
    expect(guardedDelete).toBeGreaterThan(loop);
    expect(persistentDelete).toBeGreaterThan(guardedDelete);
    expect(failureCapture).toBeGreaterThan(persistentDelete);
  });

  it("the shared helper dismisses every visible pointer-blocking OpenChat overlay", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    expect(source).toContain('document.querySelectorAll(".overlay")');
    expect(source).toContain('getComputedStyle(overlay).pointerEvents !== "none"');
    expect(source).toContain("remainingBlockingOverlays");
    expect(source).toContain("blocking OpenChat overlay(s) could not be dismissed");
    expect(source).not.toContain('#masked_overlay.visible');
  });

  it("the shared helper clears blocking overlays before every exact-artifact menu attempt", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    const exactEvidence = source.indexOf("if (!(await evidencePresent(page, artifact))) return false");
    const senderGuard = source.indexOf("if (!(await senderOwned(wrapper)))", exactEvidence);
    const classicOpen = source.indexOf(
      "await openExactOwnedClassicOpenChatMessageMenu(page, wrapper)",
      senderGuard,
    );
    const classicHelper = source.indexOf(
      "export async function openExactOwnedClassicOpenChatMessageMenu(",
    );
    const classicDismiss = source.indexOf(
      "await dismissBlockingOpenChatOverlays(page)",
      classicHelper,
    );
    const classicHover = source.indexOf("await bubble.hover()", classicDismiss);
    expect(exactEvidence).toBeGreaterThanOrEqual(0);
    expect(senderGuard).toBeGreaterThan(exactEvidence);
    expect(classicOpen).toBeGreaterThan(senderGuard);
    expect(classicDismiss).toBeGreaterThan(classicHelper);
    expect(classicHover).toBeGreaterThan(classicDismiss);

    const mobileHelper = source.indexOf("async function openOwnedMobileMenu(");
    const clickDismiss = source.indexOf(
      "await dismissBlockingOpenChatOverlays(page)",
      mobileHelper,
    );
    const clickAttempt = source.indexOf('await trigger.dispatchEvent("click")', clickDismiss);
    const touchDismiss = source.indexOf(
      "await dismissBlockingOpenChatOverlays(page)",
      clickAttempt,
    );
    const touchAttempt = source.indexOf('type: "touchStart"', touchDismiss);
    expect(clickDismiss).toBeGreaterThan(mobileHelper);
    expect(clickAttempt).toBeGreaterThan(clickDismiss);
    expect(touchDismiss).toBeGreaterThan(clickAttempt);
    expect(touchAttempt).toBeGreaterThan(touchDismiss);
  });

  it("the responsive classic cleanup fallback stays inside the exact owned message bubble", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    const helper = source.indexOf(
      "export async function openExactOwnedClassicOpenChatMessageMenu(",
    );
    const exactWrapper = source.indexOf("(await wrapper.count()) !== 1", helper);
    const senderGuard = source.indexOf("if (!(await senderOwned(wrapper)))", exactWrapper);
    const exactBubble = source.indexOf('const bubble = wrapper.locator(".bubble-wrapper")', senderGuard);
    const exactIcons = source.indexOf('const menuIcons = bubble.locator(".menu-icon")', exactBubble);
    const singleAttached = source.indexOf("(await menuIcons.count()) !== 1", exactIcons);
    const containingMenu = source.indexOf('node.closest(".menu")', singleAttached);
    const stillAttached = source.indexOf("node.isConnected", containingMenu);
    const responsiveHidden = source.indexOf('getComputedStyle(menu).display === "none"', containingMenu);
    const fallbackClick = source.indexOf('await menuIcons.dispatchEvent("click")', responsiveHidden);
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(exactWrapper).toBeGreaterThan(helper);
    expect(senderGuard).toBeGreaterThan(exactWrapper);
    expect(exactBubble).toBeGreaterThan(senderGuard);
    expect(exactIcons).toBeGreaterThan(exactBubble);
    expect(singleAttached).toBeGreaterThan(exactIcons);
    expect(containingMenu).toBeGreaterThan(singleAttached);
    expect(stillAttached).toBeGreaterThan(containingMenu);
    expect(responsiveHidden).toBeGreaterThan(stillAttached);
    expect(fallbackClick).toBeGreaterThan(responsiveHidden);
    expect(source).not.toContain('page.locator(".menu-icon")');
  });

  it("the responsive classic fallback rechecks overlays and retains sender-only deletion", () => {
    const source = liveHarness("openChatArtifactCleanup.ts");
    const helper = source.indexOf(
      "export async function openExactOwnedClassicOpenChatMessageMenu(",
    );
    const classicHover = source.indexOf("await bubble.hover()", helper);
    const normalClick = source.indexOf("await visibleMenuIcons[0].click", classicHover);
    const normalOverlayCheck = source.lastIndexOf(
      "await dismissBlockingOpenChatOverlays(page)",
      normalClick,
    );
    const fallbackClick = source.indexOf('await menuIcons.dispatchEvent("click")', normalClick);
    const fallbackOverlayCheck = source.lastIndexOf(
      "await dismissBlockingOpenChatOverlays(page)",
      fallbackClick,
    );
    const rejectDeleteForMe = source.indexOf("refusing Delete for me", fallbackClick);
    const exactSenderDelete = source.indexOf('name: "Delete", exact: true', rejectDeleteForMe);
    expect(normalOverlayCheck).toBeGreaterThan(classicHover);
    expect(normalClick).toBeGreaterThan(normalOverlayCheck);
    expect(fallbackOverlayCheck).toBeGreaterThan(normalClick);
    expect(fallbackClick).toBeGreaterThan(fallbackOverlayCheck);
    expect(rejectDeleteForMe).toBeGreaterThan(fallbackClick);
    expect(exactSenderDelete).toBeGreaterThan(rejectDeleteForMe);
  });

  it("the inbox helper baselines ids and refuses ambiguous acknowledgement", () => {
    const source = liveHarness("actionInboxArtifactCleanup.ts");
    expect(source).toContain("excluded.has(candidate.id.toString())");
    expect(source).toContain("matches.length === 1");
    expect(source).toContain("acknowledgementSecret: match.acknowledgementSecret");
    expect(source).toContain("refusing ambiguous acknowledgement");
  });
});
