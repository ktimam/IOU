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

  it("fences retries after the observer sees any new card and inventories every exact card", () => {
    const retry = between("let proposalCardObserved = false", "check(posted,");
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

  it("cross-checks all stable card coordinates before confirmation", () => {
    expect(journey).toContain("captureCardMessage(card, observerId, who)");
    expect(journey).toContain(
      'ancestor::*[@data-id and @data-index and starts-with(@id,"event-")][1]',
    );
    expect(journey).toContain(
      "senderCard!.message.messageId === confirmerCard!.message.messageId",
    );
    expect(journey).toContain(
      "senderCard!.message.messageIndex === confirmerCard!.message.messageIndex",
    );
    expect(journey).toContain(
      "senderCard!.message.eventIndex === confirmerCard!.message.eventIndex",
    );
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
      "await installManualPromptOverride(proposerOC, extraction)",
      "const promptProbe = await readManualPromptProbe(proposerOC)",
      "promptProbe.promptCalls === 1",
      "runProposeFlow opened exactly one manual extraction prompt",
    ]);
    expect(journey).not.toContain('.on("dialog"');
    expect(journey).not.toContain('.off("dialog"');
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
    expect(verifier).toContain('waitFor({ state: "visible", timeout: 20_000 })');
    expect(verifier).toContain("exactMessageEvidencePresent(page, item.message, item.evidence)");
    expect(verifier).not.toContain('waitFor({ state: "attached"');
  });
});
