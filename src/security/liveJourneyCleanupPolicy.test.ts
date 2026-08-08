import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const journey = readFileSync(
  path.join(process.cwd(), "scripts/live/journey-fanout.ts"),
  "utf8",
);

function between(start: string, end: string, from = 0): string {
  const startAt = journey.indexOf(start, from);
  expect(startAt, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const endAt = journey.indexOf(end, startAt + start.length);
  expect(endAt, `missing end marker: ${end}`).toBeGreaterThan(startAt);
  return journey.slice(startAt, endAt);
}

function expectOrdered(source: string, markers: readonly string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    expect(next, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(cursor);
    cursor = next;
  }
}

describe("live OpenChat journey cleanup policy", () => {
  it("captures and recovers only one fresh sender-owned exact source", () => {
    const capture = between(
      "async function captureFreshSourceMessage(",
      "async function captureCardMessage(",
    );
    expectOrdered(capture, [
      "freshSourceCandidates(page, exactText, baselineIds)",
      "if (matches.length > 1)",
      "if (matches.length === 1)",
      "if (!matches[0].owned)",
      "exactMessageWrapper(page, message).count()",
      "return message",
    ]);
    expect(journey).toContain("baseline.includes(messageId)");
    expect(journey).toContain("page.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(");
    expect(journey).toContain("wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(");
    expect(journey.match(/locator\("\.message_text"\)/g) ?? []).toHaveLength(0);
    expect(journey).not.toContain("let sheetOpen = true");
    expect(journey.match(/node\.closest\("\.message_text"\) !== null/g)).toHaveLength(2);
    expect(journey).toContain('classList.contains("me")');
    expect(journey).toContain('justifyContent === "flex-end"');

    const run = between("let sourceBaselineIds:", "if (failures > 0)");
    expectOrdered(run, [
      "sourceBaselineIds = await captureMessageIdBaseline(proposerOC)",
      'await proposerOC.keyboard.press("Enter")',
      "sourceSendSucceeded = true",
      "sourceMessage = await captureFreshSourceMessage(",
      "if (sourceSendSucceeded && sourceMessage === null && sourceBaselineIds !== null)",
      "sourceMessage = await captureFreshSourceMessage(",
      "for (const trackedCard of [...senderRunCards.values()]",
      "if (sourceMessage !== null)",
    ]);
  });

  it("clicks Propose at most once, then only waits and inventories every exact card", () => {
    const retry = between("let proposalCardObserved = false", "check(posted,");
    expect(retry).toContain("const maxProposalAttempts = 1");
    expect(retry).toContain("attempt <= maxProposalAttempts");
    expect(retry).not.toContain("attempt <= 3");
    expectOrdered(retry, [
      "proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0",
      "if (!proposalCardObserved)",
      "findAndLoadRunCards(",
      "rememberRunCards(senderRunCards",
      "proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0",
      "uniqueTrackedRunCard(senderRunCards",
    ]);
    expect(retry).toContain("only waits and never clicks Propose again");
    expect(retry).not.toContain("findAndLoadRunCard(");

    const finder = between("async function findAndLoadRunCards(", "async function approveRunCardConfirmation(");
    expect(finder).toContain("const found = new Map<string, LoadedRunCard>()");
    expect(finder).toContain("return [...found.values()]");
    expect(finder).not.toContain("return {\n          card,");
    expect(journey).toContain("for (const trackedCard of [...senderRunCards.values()].sort(");
  });

  it("does not mistake a rerendered historical card for a newly proposed card", () => {
    const observer = between(
      "async function installNewCardObserver(",
      "async function observedCardTransitions(",
    );
    expect(observer).toContain("const stableCardKey = (card)");
    expect(observer).toContain("baselineKeys: new Set(");
    expect(observer).toContain("idsByStableKey: {}");
    expect(observer).toContain(
      "if (!stableKey || state.baselineKeys.has(stableKey)) continue",
    );
    expect(observer).toContain("state.idsByStableKey[stableKey]");
    expect(observer).not.toContain(
      'baseline: new Set(document.querySelectorAll(".action-card"))',
    );
  });

  it("cross-checks all stable card coordinates before confirmation", () => {
    expect(journey).toContain("captureCardMessage(card, observerId, who)");
    expect(journey).toContain(
      'ancestor::*[@data-id and @data-index and starts-with(@id,"event-")][1]',
    );
    expect(journey).toContain(
      "sameStableMessage(senderCard!.message, confirmerCard!.message)",
    );
    expect(journey).toContain(
      "isImmediateStableSuccessor(sourceMessage, senderCard!.message)",
    );
    expect(journey).toContain("requireSenderOwned: true");
    expect(journey).toContain("{ expectedMessage: senderCard.message }");
    expect(journey).not.toContain("followsExpectedSource");
  });

  it("answers one manual extraction prompt synchronously on only the disposable tab", () => {
    const override = between(
      "async function installManualPromptOverride(",
      "async function readManualPromptProbe(",
    );
    expectOrdered(override, [
      "originalPrompt: window.prompt",
      "window.prompt = (message) =>",
      "state.promptCalls++",
      "state.prompts.push",
      "return ${response}",
    ]);
    expect(journey).toContain("runProposeFlow still calls parseManualExtractionPrompt");
    expectOrdered(journey, [
      "proposerQcPage = await regularProposerPage.context().newPage()",
      "await installManualPromptOverride(proposerOC, REAL_MODEL ? null : extraction)",
      "const promptProbe = await readManualPromptProbe(proposerOC)",
      "promptProbe.promptCalls === 1",
      "runProposeFlow opened exactly one manual extraction prompt",
    ]);
    expect(journey).not.toContain('.on("dialog"');
    expect(journey).not.toContain('.off("dialog"');
  });

  it("has a real vision-model path with no manual-extraction URL or JSON prompt", () => {
    expect(journey).toContain(
      'const REAL_MODEL = process.argv.includes("--real-model")',
    );
    expect(journey).toContain("if (REAL_MODEL && SOURCE_IMAGE_PATH === undefined)");
    expect(journey).toContain("qcUrl.searchParams.delete(\"manualExtract\")");
    expect(journey).toContain("REAL_MODEL ? null : extraction");
    expect(journey).toContain("promptProbe.promptCalls === 0");
    expect(journey).toContain("real model path opened no JSON prompt");
    expect(journey).toContain("REAL_MODEL ? 300_000 : 60_000");
    expectOrdered(journey, [
      'qcUrl.searchParams.delete("manualExtract")',
      "await waitForImageModelReady(proposerOC)",
      "sourceBaselineIds = await captureMessageIdBaseline(proposerOC)",
    ]);
    expect(journey).toContain('selectedModalities.includes("image")');
    expect(journey).toContain('"Analyze the attached receipt for an IOU."');
    expectOrdered(journey, [
      'await requireExactlyOneCardControl(frame, "Transaction")',
      'await requireExactlyOneCardControl(frame, "Amount")',
      'await requireExactlyOneCardControl(frame, "Currency")',
      'await requireExactlyOneCardControl(frame, "Direction")',
      'await requireExactlyOneCardControl(frame, "Note")',
      'await requireExactlyOneCardControl(frame, "Account type")',
      "assertAcceptedVisionExtraction({",
      'selectOption("iou")',
      "noteControl.fill(note)",
      'selectOption("")',
    ]);
    expect(journey).not.toContain('amount.fill("350")');
    expect(journey).not.toContain('currency.selectOption("EGP")');
    expect(journey).not.toContain('direction.selectOption("credit")');
  });

  it("inventories exact IOU targets and refuses duplicate mutation", () => {
    const lookup = between("async function lookupInboxRun(", "async function exactHistoryRows(");
    expectOrdered(lookup, [
      "value.note === exactNote",
      "if (shouldAcknowledge && matches.length === 1)",
      "acknowledgeActionInbox",
    ]);
    expect(lookup).toContain("found: matches.length === 1");

    const cleanup = between("async function cleanupIouRun(", "async function pairViaUi(");
    expectOrdered(cleanup, [
      "if (lookup.matched > 1)",
      "if (exactEntries.length > 1)",
      "const acknowledged = await lookupInboxRun(page, note, true)",
      "if (acknowledged.matched > 1)",
      "await remove.click",
    ]);
    expect(cleanup).not.toMatch(/filter\(\{\s*hasText:\s*note\s*\}\)/);
    expect(journey).toContain("renderedNote === exactNote");
    expect(journey).not.toMatch(/filter\(\{\s*hasText:\s*note/);
  });

  it("continues after bucket failures and guarantees prompt, observer, and tab teardown", () => {
    const finalizer = between("} finally {\n    try {", "if (failures > 0)");
    const cleanupAssertion = between("function cleanupCheck(", "async function proposalFailureText(");
    expectOrdered(cleanupAssertion, ["try {", "check(cond, label)", "catch (error)", "failures++"]);
    expect(finalizer).not.toMatch(/(^|[^\w])check\(/m);
    expect(finalizer.match(/cleanupCheck\(/g)?.length).toBe(6);
    expectOrdered(finalizer, [
      "if (deliveryObserved)",
      "await bucketCount(a, fpProposer)",
      "action-inbox bucket verification failed",
      "for (const trackedCard of [...senderRunCards.values()].sort(",
      "deleteExactMessageViaUi(proposerOC, trackedCard.message, evidence)",
      "deleteExactMessageViaUi(proposerOC, sourceMessage, evidence)",
      "} finally {",
      "removeManualPromptOverride(proposerOC)",
      "removeNewCardObserver(proposerOC).catch",
      "removeNewCardObserver(confirmerOC).catch",
      "proposerQcPage?.close().catch",
    ]);
  });

  it("uses sender UI deletion, card first, and verifies persistence after reload", () => {
    const cleanup = journey.indexOf("const proposerDeleted:");
    const cardDelete = journey.indexOf(
      "deleteExactMessageViaUi(proposerOC, trackedCard.message",
      cleanup,
    );
    const sourceDelete = journey.indexOf(
      "deleteExactMessageViaUi(proposerOC, sourceMessage",
      cleanup,
    );
    expect(cleanup).toBeGreaterThanOrEqual(0);
    expect(cardDelete).toBeGreaterThan(cleanup);
    expect(sourceDelete).toBeGreaterThan(cardDelete);
    expect(journey).toContain('name: "Delete for me", exact: true');
    expect(journey).toContain('name: "Delete", exact: true');
    expect(journey).toContain("verifyDeletedAfterReload(proposerOC, proposerDeleted)");
    expect(journey).toContain("verifyDeletedAfterReload(confirmerOC, confirmerDeleted)");
    const verifier = between("async function verifyDeletedAfterReload(", "async function lookupInboxRun(");
    expect(verifier).toContain("const deadline = Date.now() + 20_000");
    expect(verifier).toContain("while (Date.now() < deadline)");
    expect(verifier).toContain("if (remaining.length === 0) return");
    expect(verifier).toContain("await page.waitForTimeout(1_000)");
    expect(verifier).toContain('waitFor({ state: "visible", timeout: 20_000 })');
    expect(verifier).toContain("exactMessageEvidencePresent(page, item.message, item.evidence)");
    expect(verifier).not.toContain('waitFor({ state: "attached"');

    const evidence = between(
      "async function exactMessageEvidencePresent(",
      "async function waitForExactEvidenceAbsent(",
    );
    expect(evidence).toContain(
      "if (currentObserverId !== null && currentObserverId !== evidence.observerId) return false",
    );
    expect(evidence).toContain(
      'if (identity.title !== "Add to IOU" || !/Directory entry:\\s*iou/i.test(identity.text)) return false',
    );
    expect(evidence).not.toContain("IOU card identity no longer matches");
  });

  it("retries only detached exact-message deletion after rechecking evidence and ownership", () => {
    const deletion = between(
      "async function deleteExactMessageViaUi(",
      "async function verifyDeletedAfterReload(",
    );
    expect(deletion).toContain("const maxDeleteAttempts = 3");
    expectOrdered(deletion, [
      "for (let attempt = 0; attempt < maxDeleteAttempts; attempt++)",
      "await dismissOpenChatOverlay(page)",
      "exactMessageEvidencePresent(page, message, evidence)",
      "messageRefFromWrapper(",
      "messageOwnedByCurrentUser(page, message)",
      "sameStableMessage(message, observed)",
      'name: "Delete", exact: true',
      "deleteItem.click",
      "shouldRetryExactMessageDeletion({",
    ]);
    expect(deletion).not.toContain(".last()");
    expect(deletion).not.toMatch(/filter\(\{\s*hasText:/);
  });
});
