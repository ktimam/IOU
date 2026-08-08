import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "scripts/live/verify-multi-entry.ts"),
  "utf8",
);

function expectOrdered(subject: string, markers: readonly string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = subject.indexOf(marker, cursor + 1);
    expect(next, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("multi-entry inbox cleanup policy", () => {
  it("states every claimed currency in the exact source evidence", () => {
    expect(source).toContain(
      'const text = `Multi ${nonce}: 350 EGP iou credit 2026-08-08 multi-a; 500 USD settlement debt 2026-08-09 multi-b`',
    );
    expect(source).not.toContain("two fees");
  });

  it("uses a synchronous tab-local prompt override instead of racing a native dialog", () => {
    expect(source).toContain("installManualPromptOverride,");
    expect(source).toContain("readManualPromptProbe,");
    expect(source).toContain("removeManualPromptOverride,");
    const install = source.indexOf(
      "promptOverride = await installManualPromptOverride(proposerOC, extraction)",
    );
    const propose = source.indexOf("await propose.click({ timeout: 12_000 })", install);
    const probe = source.indexOf("await readManualPromptProbe(proposerOC, promptOverride)", propose);
    const exactlyOne = source.indexOf("promptProbe.promptCalls !== 1", probe);
    const remove = source.indexOf(
      "await removeManualPromptOverride(proposerOC, promptOverride)",
      exactlyOne,
    );
    expect(install).toBeGreaterThanOrEqual(0);
    expect(propose).toBeGreaterThan(install);
    expect(probe).toBeGreaterThan(propose);
    expect(exactlyOne).toBeGreaterThan(probe);
    expect(remove).toBeGreaterThan(exactlyOne);
    expect(source).not.toContain('.on("dialog"');
    expect(source).not.toContain('.off("dialog"');
    expect(source).not.toContain("dialog.accept(");
  });

  it("re-reads the prompt probe at final teardown before restoring the native prompt", () => {
    const finalizer = source.indexOf("} finally {", source.indexOf("await modal.waitFor"));
    const finalRead = source.indexOf(
      "await readManualPromptProbe(proposerOC, promptOverride)",
      finalizer,
    );
    const exactFinal = source.indexOf("finalPromptProbe.promptCalls !== 1", finalRead);
    const restore = source.indexOf(
      "await removeManualPromptOverride(proposerOC, promptOverride)",
      exactFinal,
    );
    expect(finalizer).toBeGreaterThanOrEqual(0);
    expect(finalRead).toBeGreaterThan(finalizer);
    expect(exactFinal).toBeGreaterThan(finalRead);
    expect(restore).toBeGreaterThan(exactFinal);
  });

  it("captures every terminal proposal surface and page diagnostic during the one card wait", () => {
    const blocker = source.indexOf("async function throwVisibleProposalBlocker(");
    const everyToast = source.indexOf('page.locator(".toast")', blocker);
    const chooser = source.indexOf('page.locator(".ai-action-choices")', everyToast);
    const chooserFailure = source.indexOf("proposal stopped at action chooser", chooser);
    const linkModal = source.indexOf('getByRole("button", { name: /Check connection/i })', chooserFailure);
    const linkFailure = source.indexOf("proposal stopped at app-link consent", linkModal);
    const cardFinder = source.indexOf("async function findClassicMultiCard(");
    const blockerPoll = source.indexOf("await throwVisibleProposalBlocker(page)", cardFinder);
    const consoleCapture = source.indexOf('proposerOC.on("console", onConsole)', blockerPoll);
    const pageErrorCapture = source.indexOf('proposerOC.on("pageerror", onPageError)', consoleCapture);
    const diagnosticFailure = source.indexOf("proposal diagnostics:", pageErrorCapture);
    expect(blocker).toBeGreaterThanOrEqual(0);
    expect(everyToast).toBeGreaterThan(blocker);
    expect(chooser).toBeGreaterThan(everyToast);
    expect(chooserFailure).toBeGreaterThan(chooser);
    expect(linkModal).toBeGreaterThan(chooserFailure);
    expect(linkFailure).toBeGreaterThan(linkModal);
    expect(blockerPoll).toBeGreaterThan(cardFinder);
    expect(consoleCapture).toBeGreaterThan(blockerPoll);
    expect(pageErrorCapture).toBeGreaterThan(consoleCapture);
    expect(diagnosticFailure).toBeGreaterThan(pageErrorCapture);
  });

  it("fails fast with every exact visible OpenChat proposal toast while waiting", () => {
    const visibleHelper = source.indexOf("async function visibleLocatorTexts(");
    const diagnostic = source.indexOf("async function throwVisibleProposalBlocker(");
    const toast = source.indexOf('page.locator(".toast")', diagnostic);
    const exactText = source.indexOf("candidate.innerText()", visibleHelper);
    const thrown = source.indexOf("proposal toast:", toast);
    const cardFinder = source.indexOf("async function findClassicMultiCard(");
    const poll = source.indexOf("await throwVisibleProposalBlocker(page)", cardFinder);
    expect(visibleHelper).toBeGreaterThanOrEqual(0);
    expect(diagnostic).toBeGreaterThanOrEqual(0);
    expect(toast).toBeGreaterThan(diagnostic);
    expect(exactText).toBeGreaterThan(visibleHelper);
    expect(exactText).toBeLessThan(diagnostic);
    expect(thrown).toBeGreaterThan(toast);
    expect(poll).toBeGreaterThan(cardFinder);
  });

  it("requires one prompt after the single Propose and reports its count if no card arrives", () => {
    const proposeClick = source.indexOf("await propose.click({ timeout: 12_000 })");
    const promptDeadline = source.indexOf("const extractionPromptDeadline", proposeClick);
    const promptWait = source.indexOf("while (promptProbe.promptCalls === 0", promptDeadline);
    const toastPoll = source.indexOf(
      "await throwVisibleProposalBlocker(proposerOC)",
      promptWait,
    );
    const exactPrompt = source.indexOf("if (promptProbe.promptCalls !== 1)", toastPoll);
    const cardWait = source.indexOf("await findClassicMultiCard(", exactPrompt);
    const noCard = source.indexOf(
      "JSON extraction prompt count: ${extractionPromptCalls}",
      cardWait,
    );
    expect(proposeClick).toBeGreaterThanOrEqual(0);
    expect(promptDeadline).toBeGreaterThan(proposeClick);
    expect(promptWait).toBeGreaterThan(promptDeadline);
    expect(toastPoll).toBeGreaterThan(promptWait);
    expect(exactPrompt).toBeGreaterThan(toastPoll);
    expect(cardWait).toBeGreaterThan(exactPrompt);
    expect(noCard).toBeGreaterThan(cardWait);
    expect(source.match(/await propose\.click\(\{ timeout: 12_000 \}\)/g)).toHaveLength(1);
  });

  it("dismisses every blocking startup overlay before either direct-chat selection", () => {
    expect(source).toContain("dismissBlockingOpenChatOverlays,");
    const proposerDismiss = source.indexOf(
      "await dismissBlockingOpenChatOverlays(proposerOC)",
    );
    const proposerChat = source.indexOf(
      'proposerOC.locator(".chat-summary, .chat_summary")',
      proposerDismiss,
    );
    const confirmerDismiss = source.indexOf(
      "await dismissBlockingOpenChatOverlays(confirmerOC)",
      proposerChat,
    );
    const confirmerChat = source.indexOf(
      'confirmerOC.locator(".chat-summary, .chat_summary")',
      confirmerDismiss,
    );
    expect(proposerDismiss).toBeGreaterThanOrEqual(0);
    expect(proposerChat).toBeGreaterThan(proposerDismiss);
    expect(confirmerDismiss).toBeGreaterThan(proposerChat);
    expect(confirmerChat).toBeGreaterThan(confirmerDismiss);
  });

  it("opens the exact owned source menu through the shared responsive overlay-safe helper", () => {
    expect(source).toContain("openExactOwnedClassicOpenChatMessageMenu,");
    const exactSource = source.indexOf(
      "const sourceWrapper = exactOpenChatMessageWrapper(proposerOC, sourceMessage)",
    );
    const owned = source.indexOf("if (!senderOwned)", exactSource);
    const openMenu = source.indexOf(
      "await openExactOwnedClassicOpenChatMessageMenu(proposerOC, sourceWrapper)",
      owned,
    );
    const propose = source.indexOf(
      'proposerOC.getByRole("menuitem", { name: "Propose action", exact: true })',
      openMenu,
    );
    expect(exactSource).toBeGreaterThanOrEqual(0);
    expect(owned).toBeGreaterThan(exactSource);
    expect(openMenu).toBeGreaterThan(owned);
    expect(propose).toBeGreaterThan(openMenu);
    expect(source).not.toContain('bubble.locator(".menu-icon")');
    expect(source).not.toContain('getByText("Propose action"');
  });

  it("acknowledges only one exact match and retains ambiguous matches", () => {
    expect(source).toContain("if (shouldAcknowledge && matches.length === 1)");
    expect(source).not.toMatch(
      /if \(shouldAcknowledge\)\s*\{\s*for \(const match of matches\)/,
    );
  });

  it("lets SheetPage finish one inbox poll before a single fallback reload", () => {
    const linkedRoute = source.indexOf(
      "await confirmerIOU.goto(`${IOU_BASE}/sheet/${linkedSheet}`",
    );
    const firstWait = source.indexOf(
      "await waitForUniqueExactPendingBatch(",
      linkedRoute,
    );
    const fallbackReload = source.indexOf(
      'await confirmerIOU.reload({ waitUntil: "domcontentloaded" })',
      firstWait,
    );
    const secondWait = source.indexOf(
      "await waitForUniqueExactPendingBatch(",
      firstWait + 1,
    );
    const review = source.indexOf(
      'pendingCard.getByRole("button", { name: /Review & add/ })',
      secondWait,
    );

    expect(linkedRoute).toBeGreaterThanOrEqual(0);
    expect(firstWait).toBeGreaterThan(linkedRoute);
    expect(fallbackReload).toBeGreaterThan(firstWait);
    expect(secondWait).toBeGreaterThan(fallbackReload);
    expect(review).toBeGreaterThan(secondWait);
    expect(source.slice(linkedRoute, fallbackReload)).not.toContain(
      "confirmerIOU.reload",
    );
    expect(source.slice(linkedRoute, review).match(/confirmerIOU\.reload/g)).toHaveLength(1);
    expect(source.slice(linkedRoute, review)).not.toMatch(
      /for \([^)]*!sawCount[^)]*\)[\s\S]*?confirmerIOU\.reload/,
    );
  });

  it("requires one exact two-entry summary and refuses duplicate pending rows", () => {
    const summaryBuilder = source.indexOf(
      "function expectedPendingBatchSummary(",
    );
    const exactRows = source.indexOf(
      "async function exactPendingBatchRows(",
      summaryBuilder,
    );
    const directText = source.indexOf(
      "[...node.childNodes]",
      exactRows,
    );
    const exactCompare = source.indexOf(
      "renderedSummary === normalizedExpected",
      directText,
    );
    const uniqueWait = source.indexOf(
      "async function waitForUniqueExactPendingBatch(",
      exactCompare,
    );
    const ambiguity = source.indexOf(
      "exact matches; refusing ambiguity",
      uniqueWait,
    );
    const expectedSummary = source.indexOf(
      "const pendingSummary = expectedPendingBatchSummary(expected)",
      uniqueWait,
    );

    expect(summaryBuilder).toBeGreaterThanOrEqual(0);
    expect(exactRows).toBeGreaterThan(summaryBuilder);
    expect(directText).toBeGreaterThan(exactRows);
    expect(exactCompare).toBeGreaterThan(directText);
    expect(uniqueWait).toBeGreaterThan(exactCompare);
    expect(ambiguity).toBeGreaterThan(uniqueWait);
    expect(expectedSummary).toBeGreaterThan(uniqueWait);
    const summarySource = source.slice(summaryBuilder, exactRows);
    expectOrdered(summarySource, [
      '${entry.direction === "credit" ? "owed to you" : "you owe"} \\u00b7 ',
      '`${entry.date}`',
      '`${entry.note ? ` \\u00b7 ${entry.note}` : ""}`',
    ]);
    expect(source).not.toContain(".filter({ hasText: /2 entr/i })");
    expect(source).not.toContain("let sawCount = false");
  });
});
