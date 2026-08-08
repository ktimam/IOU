import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const journey = readFileSync(
  path.join(process.cwd(), "scripts/live/journey-fanout.ts"),
  "utf8",
);
const routedTypes = readFileSync(
  path.join(process.cwd(), "scripts/live/verify-routed-card-types.ts"),
  "utf8",
);
const multiEntry = readFileSync(
  path.join(process.cwd(), "scripts/live/verify-multi-entry.ts"),
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
      "freshSourceCandidates(page, evidence, baselineIds)",
      "selectFreshOwnedSourceCandidate({",
      "baselineMessageIds: baselineIds",
      "if (message !== null)",
      "exactMessageWrapper(page, message).count()",
      "return message",
    ]);
    expect(journey).toContain("page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll(");
    expect(journey).toContain("wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(");
    expect(journey.match(/locator\("\.message_text"\)/g) ?? []).toHaveLength(0);
    expect(journey).not.toContain("let sheetOpen = true");
    expect(journey.match(/node\.closest\("\.message_text"\) !== null/g)).toHaveLength(2);
    expect(journey).toContain('classList.contains("me")');
    expect(journey).toContain('justifyContent === "flex-end"');

    const run = between("let sourceBaselineIds:", "if (failures > 0)");
    expectOrdered(run, [
      "sourceBaselineIds = await captureMessageIdBaseline(proposerOC)",
      "await sendJourneySource(proposerOC, composer, sourceText)",
      "sourceSendSucceeded = true",
      "sourceMessage = await captureFreshSourceMessage(",
      "sourceSendSucceeded &&",
      "sourceEvidence !== null",
      "sourceMessage = await captureFreshSourceMessage(",
      "for (const trackedCard of [...senderRunCards.values()]",
      "if (sourceMessage !== null && sourceEvidence !== null)",
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
      "rememberRunCards(senderCandidateCards",
      "proposalCardObserved ||= (await observedRunCardCount(proposerOC)) > 0",
      "uniqueTrackedRunCard(senderCandidateCards",
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
    expect(journey).toContain("journeySourceText({ imagePath: SOURCE_IMAGE_PATH, nonce })");
    expectOrdered(journey, [
      'await requireExactlyOneCardControl(frame, "Type")',
      'await requireExactlyOneCardControl(frame, "Amount")',
      'await requireExactlyOneCardControl(frame, "Currency")',
      'await requireExactlyOneCardControl(frame, "Direction")',
      'await requireExactlyOneCardControl(frame, "Note")',
      'await requireExactlyOneCardControl(frame, "Saved type")',
      'await requireExactlyOneCardControl(frame, "Date")',
      "assertAcceptedVisionExtraction({",
      'selectOption("iou")',
      "noteControl.fill(note)",
      'selectOption("")',
    ]);
    expect(journey).not.toContain('amount.fill("350")');
    expect(journey).not.toContain('currency.selectOption("EGP")');
    expect(journey).not.toContain('direction.selectOption("credit")');
  });

  it("sends SOURCE_IMAGE_PATH as an image-only exact source", () => {
    const sourceSend = between(
      "sourceBaselineIds = await captureMessageIdBaseline(proposerOC)",
      "// The propose entry is the message menu",
    );
    expectOrdered(sourceSend, [
      "captureExactDraftImageContent(proposerOC)",
      "journeySourceText({ imagePath: SOURCE_IMAGE_PATH, nonce })",
      "await sendJourneySource(proposerOC, composer, sourceText)",
      "captureFreshSourceMessage(",
    ]);
    expect(sourceSend).toContain('kind: "image", exactContent: draftImageContent');
    expect(sourceSend).not.toContain('keyboard.type("Analyze the attached receipt for an IOU.")');
    expect(journey).not.toContain('"Analyze the attached receipt for an IOU."');

    const candidates = between(
      "async function freshSourceCandidates(",
      "async function captureFreshSourceMessage(",
    );
    expect(candidates).toContain("page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll(");
    expect(candidates).toContain("digestUploadedAttachmentImage");
    expect(candidates).toContain("matchesExactImageContentEvidence");
    expect(candidates).toContain("baselineMessageIds.has(candidate.messageId)");
    expect(candidates).toContain("if (!candidate.senderOwned) continue");
    expect(candidates).toContain('.startsWith("blob:")');
    expect(candidates).toContain("attachmentSelector");
    expect(candidates).not.toContain("img.src === evidence.exactBlobUrl");
    expect(candidates).not.toContain('querySelectorAll<HTMLImageElement>("img")');
    expect(candidates).not.toContain("OPENCHAT_MESSAGE_TEXT_SELECTOR).last()");
    expect(candidates).not.toContain("newest");
    expectOrdered(candidates, [
      "baselineMessageIds.has(candidate.messageId)",
      "if (!candidate.senderOwned) continue",
      "digestUploadedAttachmentImage(",
      "matchesExactImageContentEvidence",
    ]);
    const capture = between(
      "async function captureFreshSourceMessage(",
      "async function captureCardMessage(",
    );
    expect(capture).toContain("selectFreshOwnedSourceCandidate");

    const cleanup = between(
      "if (sourceMessage !== null && sourceEvidence !== null)",
      "if (proposerDeleted.length > 0)",
    );
    expect(cleanup).toContain("sourceEvidence");
    expect(cleanup).not.toContain('{ kind: "source", exactText: text }');

    const evidence = between(
      "async function exactMessageEvidencePresent(",
      "async function exactMessageDeletionProven(",
    );
    expect(evidence).toContain("digestUploadedAttachmentImage");
    expect(evidence).toContain("matchesExactImageContentEvidence");
    expect(evidence).not.toContain("evidence.evidence.exactBlobUrl");

    const proposal = between("const maxProposalAttempts = 1", "check(posted,");
    expect(proposal).toContain("exactMessageEvidencePresent(");
    expect(proposal).toContain("sourceEvidence");
  });

  it("requires wrapper absence or a deleted tombstone instead of treating an image URL swap as deletion", () => {
    const proof = between(
      "async function exactMessageDeletionProven(",
      "async function waitForExactDeletionProof(",
    );
    expect(proof).toContain("exactMessageWrapper(page, message)");
    expect(proof).toContain('locator(".deleted")');
    expect(proof).toContain("MESSAGE_DELETED_TEXT");
    expect(proof).not.toContain("exactMessageEvidencePresent");

    const wait = between(
      "async function waitForExactDeletionProof(",
      "async function openOwnedMobileMessageMenu(",
    );
    expect(wait).toContain("exactMessageDeletionProven(page, message)");
    expect(wait).not.toContain("exactMessageEvidencePresent");

    const deletion = between(
      "async function deleteExactMessageViaUi(",
      "async function verifyDeletedAfterReload(",
    );
    expect(deletion).toContain("waitForExactDeletionProof(page, message)");
    expect(deletion).not.toContain("waitForExactEvidenceAbsent");
  });

  it("never tracks or deletes an IOU card until its verified iframe carries the exact run nonce", () => {
    expect(journey).toContain("async function cardHasExactRunNote(");
    expect(journey).toContain("async function rememberNonceBoundRunCards(");
    expect(journey).toContain("left untracked because its exact run note is unavailable");
    expect(journey).toContain('type ExactMessageEvidence =\n  | { kind: "source"; evidence: SourceMessageEvidence }\n  | { kind: "card"; observerId: string; exactNote: string };');

    const cardEvidence = between(
      'const cards = wrapper.locator(".action-card")',
      "async function exactMessageDeletionProven(",
    );
    expect(cardEvidence).toContain("cardLocatorHasExactRunNote(card, evidence.exactNote)");
    expect(cardEvidence).toContain("evidence.exactNote");
    const noteEvidence = between(
      "async function cardLocatorHasExactRunNote(",
      "async function cardHasExactRunNote(",
    );
    expect(noteEvidence).toContain('getByLabel("Note", { exact: true })');

    const cleanupInventory = between(
      "// A failed run must not leave its still-pending chat action behind.",
      "if (!deliveryObserved)",
    );
    expect(cleanupInventory).toContain("rememberNonceBoundRunCards(");
    expect(cleanupInventory).not.toContain("rememberRunCards(");

    const deletionLoop = between(
      "for (const trackedCard of [...senderRunCards.values()].sort(",
      "if (sourceMessage !== null && sourceEvidence !== null)",
    );
    expect(deletionLoop).toContain("exactNote: note");
  });

  it("keeps live card acceptance on the automatic trusted-card flow", () => {
    for (const source of [journey, routedTypes]) {
      expect(source).toContain('name: "Load app card", exact: true');
      expect(source).toContain("manual Load app card gate is a regression");
      expect(source).not.toContain("await load.click");
      expect(source).not.toContain("Share private context");
    }
    expect(multiEntry).toContain('["Load app card", "Share app context"]');
    expect(multiEntry).not.toContain("await load.click");
    expect(multiEntry).not.toContain("Share private context");
    expect(routedTypes).toContain('getByLabel("Type", { exact: true })');
    expect(routedTypes).toContain('getByLabel("Date", { exact: true })');
    expect(routedTypes).toContain('name: "Share app context", exact: true');

    const confirmation = between(
      "async function approveRunCardConfirmation(",
      "async function cancelRunCard(",
    );
    expectOrdered(confirmation, [
      'loaded.card.getByRole("button", { name: "Add to IOU", exact: true })',
      'loaded.frame.getByRole("button").count()',
      "await add.click",
    ]);
    expect(confirmation).not.toContain('loaded.frame.getByRole("button", { name: "Add to IOU"');
    expect(confirmation).not.toContain('name: "Confirm request", exact: true }).click');
  });

  it("pins the compact trusted IOU chrome and all first-render single-card fields", () => {
    expect(journey).toContain("async function assertTrustedIouCardChrome(");
    expect(journey).toContain("/favicon.svg");
    expect(journey).toContain('.locator(".app-name")');
    expect(journey).toContain('["Load app card", "Share app context"]');
    expect(journey).toContain("Loading contacts this external origin");
    expect(journey).toContain('.locator(".card-url")');
    expect(journey).toContain('requireExactlyOneCardControl(loaded.frame, "Type")');
    expect(journey).toContain('requireExactlyOneCardControl(loaded.frame, "Saved type")');
    expect(journey).toContain('requireExactlyOneCardControl(loaded.frame, "Date")');
    expect(journey).toContain("IOU card has no redundant disclosure checkbox");
    expect(journey).not.toContain("Directory entry:\\s*iou");
  });

  it("keeps the multi journey on one host-rendered stored-payload card", () => {
    expect(multiEntry).toContain('from "./cdpPorts"');
    expect(multiEntry).toContain("findClassicMultiCard");
    expect(multiEntry).toContain("trackExactCardRows");
    expect(multiEntry).toContain('name: "Add to IOU", exact: true');
    expect(multiEntry).toContain("ONE host-owned confirmation submitted the stored batch");
    expect(multiEntry).toContain("row.date === wanted.date");
    expect(multiEntry).toContain("row.message === wanted.message");
    expect(multiEntry).not.toContain("approveMultiCard(");
    expect(multiEntry).not.toContain("frame.getByRole");
    expect(multiEntry).not.toMatch(/\b(?:9241|9222|9231)\b/);
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
    expect(verifier).toContain("exactMessageDeletionProven(page, item.message)");
    expect(verifier).not.toContain('waitFor({ state: "attached"');

    const evidence = between(
      "async function exactMessageEvidencePresent(",
      "async function exactMessageDeletionProven(",
    );
    expect(evidence).toContain(
      "if (currentObserverId !== null && currentObserverId !== evidence.observerId) return false",
    );
    expect(evidence).toContain(
      'identity.appName.toLocaleLowerCase("en-US") !== "iou"',
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
