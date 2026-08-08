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
      "freshSourceCandidates(page, evidence, baseline)",
      "selectFreshOwnedSourceCandidate({",
      "baselineMessageIds: baseline.messageIds",
      "if (message !== null)",
      "exactMessageWrapper(page, message).count()",
      "return message",
    ]);
    expect(journey).toContain("page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll(");
    expect(journey).toContain("wrapper.locator(OPENCHAT_MESSAGE_TEXT_SELECTOR).evaluateAll(");
    expect(journey.match(/locator\("\.message_text"\)/g) ?? []).toHaveLength(0);
    expect(journey).not.toContain("let sheetOpen = true");
    expect(journey.match(/node\.closest\("\.message_text"\) !== null/g)).toHaveLength(4);
    expect(journey).toContain('classList.contains("me")');
    expect(journey).toContain('justifyContent === "flex-end"');

    const run = between("let sourceBaseline:", "if (failures > 0)");
    expectOrdered(run, [
      "sourceBaseline = await captureStableMessageBaseline(proposerOC)",
      "sourceSendAttempted = true",
      "await sendJourneySource(proposerOC, composer, sourceText)",
      "sourceMessage = await captureFreshSourceMessage(",
      "sourceSendProven = true",
      "sourceSendAttempted &&",
      "sourceEvidence !== null",
      "sourceMessage = await captureFreshSourceMessage(",
      "sourceSendProven = true",
      "for (const trackedCard of [...senderRunCards.values()]",
      "const sourceCleanupMessage =",
      "sourceMessage ?? optimisticBindingForCleanup?.boundMessage ?? null",
    ]);
  });

  it("carries the pre-send stable-coordinate floor through image capture and recovery", () => {
    const baseline = between(
      "async function captureStableMessageBaseline(",
      "async function captureStableDraftMessageBoundary(",
    );
    expect(baseline).toContain("maxMessageIndex");
    expect(baseline).toContain("maxEventIndex");

    const candidates = between(
      "async function freshSourceCandidates(",
      "async function captureFreshSourceMessage(",
    );
    expectOrdered(candidates, [
      "baseline.messageIds.has(candidate.messageId)",
      "candidate.messageIndex <= baseline.maxMessageIndex",
      "candidate.eventIndex <= baseline.maxEventIndex",
      "if (!candidate.senderOwned) continue",
    ]);

    const capture = between(
      "async function captureFreshSourceMessage(",
      "async function captureCardMessage(",
    );
    expect(capture).toContain("baselineMaxMessageIndex: baseline.maxMessageIndex");
    expect(capture).toContain("baselineMaxEventIndex: baseline.maxEventIndex");

    const run = between("let sourceBaseline:", "if (failures > 0)");
    expectOrdered(run, [
      "sourceBaseline = await captureStableMessageBaseline(proposerOC)",
      "await sendJourneySource(proposerOC, composer, sourceText)",
      "sourceMessage = await captureFreshSourceMessage(",
      "sourceSendAttempted &&",
      "sourceMessage = await captureFreshSourceMessage(",
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
    expect(retry).toContain("REAL_MODEL ? 600_000 : 60_000");

    const finder = between("async function findAndLoadRunCards(", "async function approveRunCardConfirmation(");
    expect(finder).toContain("const found = new Map<string, LoadedRunCard>()");
    expect(finder).toContain("return [...found.values()]");
    expect(finder).not.toContain("return {\n          card,");
    expect(journey).toContain("for (const trackedCard of [...senderRunCards.values()].sort(");
    const cleanupInventory = between(
      "// A failed run must not leave its still-pending chat action behind.",
      "if (!deliveryObserved)",
    );
    expect(cleanupInventory).toContain("REAL_MODEL ? 60_000 : 5_000");
    expect(cleanupInventory).toContain("late real-model completion");
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
    const promptLifecycle = between(
      "// Only the disposable manualExtract tab replaces the browser primitive.",
      "// Dismiss any open modal/sheet overlay first",
    );
    expectOrdered(promptLifecycle, [
      "if (!REAL_MODEL)",
      "promptOverrideHandle = await installManualPromptOverride(proposerOC, extraction)",
    ]);
    expect(promptLifecycle).not.toContain("REAL_MODEL ? null : extraction");

    const promptAssertion = between(
      "posted = senderCard !== null && confirmerCard !== null;",
      "check(posted,",
    );
    expectOrdered(promptAssertion, [
      "if (!REAL_MODEL)",
      "if (promptOverrideHandle === null)",
      "const promptProbe = await readManualPromptProbe(proposerOC, promptOverrideHandle)",
      "promptProbe.promptCalls === 1",
      "runProposeFlow opened exactly one manual extraction prompt",
      "parseManualExtractionPrompt received the expected JSON prompt",
      "manual extraction prompt count/message did not match this run",
      "await removeManualPromptOverride(proposerOC, promptOverrideHandle)",
      "promptOverrideHandle = null",
    ]);
    expect(journey).toContain("runProposeFlow still calls parseManualExtractionPrompt");
    expectOrdered(journey, [
      "proposerQcPage = await regularProposerPage.context().newPage()",
      "promptOverrideHandle = await installManualPromptOverride(proposerOC, extraction)",
      "const promptProbe = await readManualPromptProbe(proposerOC, promptOverrideHandle)",
      "promptProbe.promptCalls === 1",
      "runProposeFlow opened exactly one manual extraction prompt",
      "await removeManualPromptOverride(proposerOC, promptOverrideHandle)",
      "promptOverrideHandle = null",
    ]);
    expect(journey).not.toContain('.on("dialog"');
    expect(journey).not.toContain('.off("dialog"');
  });

  it("restores the prompt override only while it still owns the browser primitive", () => {
    expect(journey).toContain("type ManualPromptOverrideHandle");
    expect(journey).toContain(
      "let promptOverrideHandle: ManualPromptOverrideHandle | null = null",
    );

    const teardown = between("} finally {\n      // This teardown", "if (failures > 0)");
    expectOrdered(teardown, [
      "if (promptOverrideHandle !== null)",
      "const handleToRemove = promptOverrideHandle",
      "await removeManualPromptOverride(proposerOC, handleToRemove)",
      "promptOverrideHandle = null",
      "catch (error)",
      "failures++",
      "manual prompt restore failed",
    ]);
  });

  it("has a real vision-model path with no manual-extraction URL or JSON prompt", () => {
    expect(journey).toContain(
      'const REAL_MODEL = process.argv.includes("--real-model")',
    );
    expect(journey).toContain("if (REAL_MODEL && SOURCE_IMAGE_PATH === undefined)");
    expect(journey).toContain("qcUrl.searchParams.delete(\"manualExtract\")");
    expect(journey).not.toContain("REAL_MODEL ? null : extraction");
    expect(journey).not.toContain("promptProbe.promptCalls === 0");
    expect(journey).not.toContain("real model path opened no JSON prompt");
    expect(journey).toContain("REAL_MODEL ? 600_000 : 60_000");
    expectOrdered(journey, [
      'qcUrl.searchParams.delete("manualExtract")',
      "await waitForImageModelReady(proposerOC)",
      "sourceBaseline = await captureStableMessageBaseline(proposerOC)",
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
      "noteControl.fill(note)",
      'selectOption("")',
    ]);
    expect(journey).not.toContain('transaction.selectOption("iou")');
    expect(journey).not.toContain("date.fill(");
    expect(journey).not.toContain('amount.fill("350")');
    expect(journey).not.toContain('currency.selectOption("EGP")');
    expect(journey).not.toContain('direction.selectOption("credit")');
    expect(journey).toContain("formValues.date === resolvedDraftDate");
  });

  it("matches the exact pending summary with the same resolved date asserted in the form", () => {
    const importFlow = between(
      "const importCurrency =",
      "entrySubmissionAttempted = true",
    );
    expectOrdered(importFlow, [
      "const resolvedDraftDate = new Date().toISOString().slice(0, 10)",
      "const pendingSummary = `IOU 350.00 ${importCurrency} \\u00b7 owed to you \\u00b7 ${resolvedDraftDate} \\u00b7 ${note}`",
      "formValues.date === resolvedDraftDate",
    ]);
    expect(importFlow).not.toContain(
      "formValues.date === new Date().toISOString().slice(0, 10)",
    );
  });

  it("sends SOURCE_IMAGE_PATH as an image-only exact source", () => {
    const sourceSend = between(
      "sourceBaseline = await captureStableMessageBaseline(proposerOC)",
      "// The propose entry is the message menu",
    );
    expectOrdered(sourceSend, [
      "captureExactDraftImageContent(",
      "journeySourceText({ imagePath: SOURCE_IMAGE_PATH, nonce })",
      "await sendJourneySource(proposerOC, composer, sourceText)",
      "captureFreshSourceMessage(",
    ]);
    expect(sourceSend).toContain('kind: "image"');
    expect(sourceSend).toContain("exactContent: exactDraftImageBinding.exactContent");
    expect(sourceSend).toContain("exactDraftUrl: exactDraftImageBinding.draftUrl");
    expect(sourceSend).not.toContain('keyboard.type("Analyze the attached receipt for an IOU.")');
    expect(journey).not.toContain('"Analyze the attached receipt for an IOU."');

    const candidates = between(
      "async function freshSourceCandidates(",
      "async function captureFreshSourceMessage(",
    );
    expect(candidates).toContain("page.locator(MESSAGE_WRAPPER_SELECTOR).evaluateAll(");
    expect(candidates).toContain("digestUploadedAttachmentImage");
    expect(candidates).toContain("classifySentImageResource");
    expect(candidates).toContain("matchesExactImageContentEvidence");
    expect(candidates).toContain("captionTextCount");
    expect(candidates).toContain("candidate.captionTextCount !== 0");
    expect(candidates).toContain("baseline.messageIds.has(candidate.messageId)");
    expect(candidates).toContain("candidate.messageIndex <= baseline.maxMessageIndex");
    expect(candidates).toContain("candidate.eventIndex <= baseline.maxEventIndex");
    expect(candidates).toContain("if (!candidate.senderOwned) continue");
    expect(candidates).toContain("classifySentImageResource");
    expect(candidates).toContain("attachmentSelector");
    expect(candidates).not.toContain("img.src === evidence.exactBlobUrl");
    expect(candidates).not.toContain('querySelectorAll<HTMLImageElement>("img")');
    expect(candidates).not.toContain("OPENCHAT_MESSAGE_TEXT_SELECTOR).last()");
    expect(candidates).not.toContain("newest");
    expectOrdered(candidates, [
      "baseline.messageIds.has(candidate.messageId)",
      "candidate.messageIndex <= baseline.maxMessageIndex",
      "candidate.eventIndex <= baseline.maxEventIndex",
      "if (!candidate.senderOwned) continue",
      "classifySentImageResource(",
      'readiness.kind === "pending"',
      "digestUploadedAttachmentImage(",
      "matchesExactImageContentEvidence",
    ]);
    const capture = between(
      "async function captureFreshSourceMessage(",
      "async function captureCardMessage(",
    );
    expect(capture).toContain("selectFreshOwnedSourceCandidate");

    const cleanup = between(
      "const sourceCleanupMessage =",
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
    expect(evidence).toContain("if (captionTextCount !== 0) return false");
    expect(evidence).not.toContain("evidence.evidence.exactBlobUrl");

    const proposal = between("const maxProposalAttempts = 1", "check(posted,");
    expect(proposal).toContain("exactMessageEvidencePresent(");
    expect(proposal).toContain("sourceEvidence");
  });

  it("captures the exact processed draft Blob without fetching its realm-bound URL", () => {
    const capture = between(
      "async function installExactDraftBlobCapture(",
      "async function sendJourneySource(",
    );
    expectOrdered(capture, [
      "const originalCreateObjectURL = URL.createObjectURL",
      "const captured = new Map()",
      "active: true",
      "const captureCreateObjectURL",
      "state.active && object instanceof Blob",
      "captured.set(url, object)",
      "URL.createObjectURL = captureCreateObjectURL",
      "if (URL.createObjectURL !== captureCreateObjectURL)",
      "state.active = false",
      "captured.clear()",
      "delete root.__iouExactDraftBlobCapture",
      "return false",
      "async function captureExactDraftImageContent(",
      'page.locator(\'img.draft[src^="blob:"]\')',
      "await exactImages[0].evaluate((node) => (node as HTMLImageElement).decode())",
      "state.captured.get(resourceUrl)",
      "await blob.arrayBuffer()",
      'mimeType.startsWith("image/")',
      'crypto.subtle.digest("SHA-256", bytes)',
      "async function removeExactDraftBlobCapture(",
      "const ownsHook = URL.createObjectURL === state.captureCreateObjectURL",
      "state.active = false",
      "if (ownsHook) URL.createObjectURL = state.originalCreateObjectURL",
      "state.captured.clear()",
      "delete root.__iouExactDraftBlobCapture",
      'return ownsHook ? "restored" : "detached"',
    ]);
    expect(capture).not.toContain("fetch(resourceUrl");

    const sourceSend = between(
      "sourceBaseline = await captureStableMessageBaseline(proposerOC)",
      "const sourceText = journeySourceText(",
    );
    expectOrdered(sourceSend, [
      "exactDraftSelectionBoundary = await prepareExactDraftAttachmentSelection(",
      "await installExactDraftBlobCapture(proposerOC)",
      "draftBlobCaptureInstalled = true",
      "draftAttachmentSelectionStarted = true",
      "await exactFileInput.setInputFiles(SOURCE_IMAGE_PATH)",
      "exactPartialDraftBinding = await retainExactPartialDraftBinding(",
      "exactDraftImageBinding = await captureExactDraftImageContent(",
      "await removeExactDraftBlobCapture(proposerOC)",
      "draftBlobCaptureInstalled = false",
    ]);
    const precondition = between(
      "async function assertNoPreexistingDraftAttachment(",
      "async function installExactDraftBlobCapture(",
    );
    expect(precondition).toContain("visibleDraftMedia.length !== 0");
    expect(precondition).toContain("visibleAttachmentStates.length !== 0");
    expect(precondition).toContain("refuses to replace a pre-existing draft attachment");
    expect(precondition).toContain("requires an empty composer before selecting its attachment");
  });

  it("retains an exact partial draft binding before byte hashing can fail", () => {
    const stableBoundary = between(
      "async function captureStableDraftMessageBoundary(",
      "async function assertStableDraftMessageBoundary(",
    );
    expect(stableBoundary.match(/evaluateAll\(/g) ?? []).toHaveLength(1);
    expectOrdered(stableBoundary, [
      "const records:",
      "stableEvidence: JSON.stringify({",
      "attachmentImageCount",
      "evidenceDigest:",
      "maxMessageIndex:",
      "maxEventIndex:",
      "matchesStableDraftMessageBoundary(boundary, boundary)",
    ]);
    expect(stableBoundary).not.toContain("attachmentUrls");
    expect(stableBoundary).not.toContain("image.src");

    const assertion = between(
      "async function assertStableDraftMessageBoundary(",
      "async function digestImageResource(",
    );
    expectOrdered(assertion, [
      "captureStableDraftMessageBoundary(page)",
      "matchesStableDraftMessageBoundary(expected, observed)",
      "throw new Error(label)",
    ]);

    const boundary = between(
      "async function prepareExactDraftAttachmentSelection(",
      "async function installExactDraftBlobCapture(",
    );
    expectOrdered(boundary, [
      "assertNoPreexistingDraftAttachment(page, composer)",
      'ancestor::*[contains(concat(" ", normalize-space(@class), " "), " footer ")][1]',
      'footer.locator(".ProseMirror")',
      "captureStableDraftMessageBoundary(page)",
      "node.setAttribute(attribute, footerMarker)",
    ]);

    const binding = between(
      "async function retainExactPartialDraftBinding(",
      "async function captureExactDraftImageContent(",
    );
    expectOrdered(binding, [
      'page.locator(\'img.draft[src^="blob:"]\')',
      "const draftUrl",
      "const markedFooters = await visibleMatches(",
      "binding.footerMarker",
      "selected image draft has",
      "const footer = exactDraft.locator(",
      'footer.locator(".ProseMirror")',
      "return { ...binding, draftUrl }",
    ]);
    expect(binding).not.toContain("assertStableDraftMessageBoundary(");
    expect(binding).not.toContain("matchesStableDraftMessageBoundary(");

    const sourceSend = between(
      "sourceBaseline = await captureStableMessageBaseline(proposerOC)",
      "const sourceText = journeySourceText(",
    );
    expectOrdered(sourceSend, [
      "exactDraftSelectionBoundary = await prepareExactDraftAttachmentSelection(",
      "await exactFileInput.setInputFiles(SOURCE_IMAGE_PATH)",
      "exactPartialDraftBinding = await retainExactPartialDraftBinding(",
      "await assertStableDraftMessageBoundary(",
      "exactDraftImageBinding = await captureExactDraftImageContent(",
    ]);
    expect(sourceSend).toContain("exactPartialDraftBinding");
  });

  it("keeps a failed draft-hook teardown installed so the outer cleanup retries it", () => {
    const sourceSend = between(
      "await installExactDraftBlobCapture(proposerOC)",
      "const sourceText = journeySourceText(",
    );
    expectOrdered(sourceSend, [
      "await removeExactDraftBlobCapture(proposerOC)",
      "draftBlobCaptureInstalled = false",
    ]);
    expect(sourceSend).not.toContain("} finally {\n        draftBlobCaptureInstalled = false");

    const finalizer = between("} finally {\n    try {", "// Enter may have succeeded");
    expectOrdered(finalizer, [
      "if (draftBlobCaptureInstalled)",
      "await removeExactDraftBlobCapture(proposerOC)",
      "draftBlobCaptureInstalled = false",
      "catch (error)",
      "failures++",
    ]);
    expect(finalizer).not.toContain("} finally {\n        draftBlobCaptureInstalled = false");

    const removal = between(
      "async function removeExactDraftBlobCapture(",
      "async function clearExactUnsentDraftAttachment(",
    );
    expect(removal).toContain('if (state === undefined) return "missing"');
    expectOrdered(removal, [
      "const ownsHook = URL.createObjectURL === state.captureCreateObjectURL",
      "if (ownsHook) URL.createObjectURL = state.originalCreateObjectURL",
      "state.captured.clear()",
      "delete root.__iouExactDraftBlobCapture",
    ]);
    expect(removal).not.toContain("if (outcome === \"missing\")");
    expect(removal).not.toContain("if (outcome === \"detached\")");
  });

  it("polls temporary sent-image renders but fails closed on terminal upload evidence", () => {
    const candidates = between(
      "async function freshSourceCandidates(",
      "async function captureFreshSourceMessage(",
    );
    expectOrdered(candidates, [
      'image.getAttribute("src")',
      "new URL(rawAttributeSrc, document.baseURI).href",
      "currentSrc: image.currentSrc",
      "complete: image.complete",
      "naturalWidth: image.naturalWidth",
      "naturalHeight: image.naturalHeight",
      "classifySentImageResource(candidate.attachmentStates[0])",
      'readiness.kind === "pending"',
      "exactOptimisticBindingMatches: candidate.exactOptimisticBindingMatches",
      "digestUploadedAttachmentImage(",
      "readiness.url",
      "matchesExactImageContentEvidence",
      "uploaded image bytes do not match the exact draft",
    ]);
    expect(candidates).not.toContain("digestUploadedAttachmentImage(\n      page,\n      candidate.attachmentStates[0].src");

    const capture = between(
      "async function captureFreshSourceMessage(",
      "async function captureCardMessage(",
    );
    expectOrdered(capture, [
      "selectFreshOwnedSourceCandidate({",
      "exactOptimisticBindingMatches",
      "exactOptimisticMessage = optimistic",
      "onExactOptimisticBinding?.(optimistic)",
      "selectFreshOwnedSourceCandidate({",
      "uploaded source differs from its exact optimistic binding",
      "return message",
    ]);
  });

  it("retains the exact optimistic image binding for cleanup only", () => {
    const run = between("let sourceBaseline:", "if (failures > 0)");
    expectOrdered(run, [
      "let exactOptimisticSourceBinding:",
      "const retainExactOptimisticSourceBinding =",
      "boundMessage: { ...message }",
      "boundDraftUrl: sourceEvidence.exactDraftUrl",
      "await captureFreshSourceMessage(",
      "retainExactOptimisticSourceBinding",
      "uploaded source differs from the retained exact optimistic binding",
      "sourceSendProven = true",
      "sourceMessage = await captureFreshSourceMessage(",
      "retainExactOptimisticSourceBinding",
      "recovered source differs from the retained exact optimistic binding",
      "const sourceCleanupMessage =",
      "sourceMessage ?? optimisticBindingForCleanup?.boundMessage ?? null",
      "optimisticBinding: optimisticBindingForCleanup",
    ]);

    const evidence = between(
      "async function exactMessageEvidencePresent(",
      "async function exactMessageDeletionProven(",
    );
    expectOrdered(evidence, [
      "classifySentImageResource(attachmentStates[0])",
      'readiness.kind === "pending"',
      "const binding = evidence.optimisticBinding",
      "const renderedBlobUrls =",
      'binding.boundDraftUrl.startsWith("blob:")',
      "binding.boundDraftUrl === evidence.evidence.exactDraftUrl",
      "renderedBlobUrls.every((url) => url === binding.boundDraftUrl)",
      "sameStableMessage(message, binding.boundMessage)",
      "messageOwnedByCurrentUser(page, message)",
      "digestUploadedAttachmentImage(",
      "matchesExactImageContentEvidence",
    ]);

    const proposal = between("const maxProposalAttempts = 1", "check(posted,");
    expect(proposal).toContain('{\n          kind: "source",\n          evidence: sourceEvidence,\n        }');
    expect(proposal).not.toContain("optimisticBinding");
  });

  it("removes an exact unsent image draft after a pre-send failure", () => {
    const cleanup = between(
      "async function clearExactUnsentDraftAttachment(",
      "async function sendJourneySource(",
    );
    expectOrdered(cleanup, [
      'img.draft[src^="blob:"]',
      "const markedFooters = await visibleMatches(",
      "binding.footerMarker",
      'footer.locator(".ProseMirror")',
      "image draft composer is not empty",
      "await assertStableDraftMessageBoundary(",
      "const mobileContainer = exactDraft.locator(",
      '" message_entry_wrapper "',
      'visibleMobileContainers[0].locator(".close > button.icon_button[type=button]")',
      'footer.locator(".open-draw > div[role=button]")',
      "expected one exact draft-removal control",
      "CLOSE_ICON_PATH",
      "await controls[0].click",
      "unsent draft attachment remained visible",
      "await assertStableDraftMessageBoundary(",
    ]);
    expect(cleanup).toContain("same exact footer");
    expect(cleanup).toContain("binding.draftUrl");
    expect(cleanup).toContain("binding.messageBoundary");
    expect(cleanup).toContain("binding.footerMarker");
    expect(cleanup).not.toContain("captureExactMessageInventoryDigest");
    expect(cleanup).not.toContain("matchesExactMessageInventory");
    expect(cleanup).not.toContain('page.locator(".footer .open-draw")');
    expect(cleanup).toContain("expected one exact draft-removal control");
    expect(cleanup).not.toContain(".last()");

    const finalizer = between("} finally {\n    try {", "if (failures > 0)");
    expectOrdered(finalizer, [
      "if (draftBlobCaptureInstalled)",
      "await removeExactDraftBlobCapture(proposerOC)",
      "sourceSendAttempted &&",
      "sourceSendProven = true",
      "draftAttachmentSelectionStarted &&",
      "!sourceSendProven",
      "exactPartialDraftBinding !== null",
      "await clearExactUnsentDraftAttachment(",
      "exactPartialDraftBinding",
      "cleanup removed exact unsent image draft",
    ]);
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
    expect(journey).toContain("type NonceBoundRunCard = LoadedRunCard &");
    expect(journey).toContain('kind: "card"');
    expect(journey).toContain("boundMessage: ChatMessageRef");
    expect(journey).toContain("boundExactNote: string");

    const cardEvidence = between(
      'const cards = wrapper.locator(".action-card")',
      "async function exactMessageDeletionProven(",
    );
    expect(cardEvidence).toContain(
      "cardLocatorExactRunNoteState(card, evidence.boundExactNote)",
    );
    expect(cardEvidence).toContain("evidence.boundExactNote");
    const noteEvidence = between(
      "async function cardLocatorExactRunNoteState(",
      "async function cardLocatorHasExactRunNote(",
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
      "if (exactSourceDeletionTarget !== null)",
    );
    expect(deletionLoop).toContain("const evidence = trackedCard.deletionEvidence");
    expect(deletionLoop).not.toContain("exactNote: note");
  });

  it("retains only previously verified nonce evidence when a confirmed card collapses", () => {
    const retention = between(
      "async function rememberNonceBoundRunCards(",
      "function uniqueTrackedRunCard<",
    );
    expectOrdered(retention, [
      "cardHasExactRunNote(card, exactNote)",
      "const deletionEvidence",
      "boundMessage: { ...card.message }",
      "boundExactNote: exactNote",
      "rememberRunCards(tracked, [{ ...card, deletionEvidence }]",
    ]);

    const evidence = between(
      "async function exactMessageEvidencePresent(",
      "async function exactMessageDeletionProven(",
    );
    expect(evidence).toContain("retainsNonceBoundCardEvidence({");
    expect(evidence).toContain("boundMessage: evidence.boundMessage");
    expect(evidence).toContain("boundExactNote: evidence.boundExactNote");
    expect(evidence).toContain("senderOwned: await messageOwnedByCurrentUser(page, message)");
    expect(evidence).toContain("currentIdentity");
    expect(evidence).toContain("currentNote");
    expect(evidence).not.toContain(".last()");
    expect(evidence).not.toContain("newest");

    expect(journey).toContain("const senderRunCards = new Map<string, NonceBoundRunCard>()");
    expect(journey).toContain("const confirmerRunCards = new Map<string, NonceBoundRunCard>()");
    expect(journey).toContain("evidence: card.deletionEvidence");
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
    const hydrationWait = between(
      "async function waitForHostAddEnabled(",
      "async function approveRunCardConfirmation(",
    );
    expectOrdered(hydrationWait, [
      "HOST_ADD_HYDRATION_TIMEOUT_MS",
      "while (Date.now() < deadline)",
      "await add.isEnabled()",
      'getByRole("status")',
      'getByRole("alert")',
      'name: "Restore app data", exact: true',
      "throw new Error",
    ]);
    expectOrdered(confirmation, [
      'loaded.card.getByRole("button", { name: "Add to IOU", exact: true })',
      "await waitForHostAddEnabled(loaded, add)",
      'loaded.frame.getByRole("button").count()',
      "await add.click",
    ]);
    expect(confirmation).not.toContain('loaded.frame.getByRole("button", { name: "Add to IOU"');
    expect(confirmation).not.toContain('name: "Confirm request", exact: true }).click');
  });

  it("accepts the exact real-image semantics before applying only downstream correlation edits", () => {
    const acceptance = between(
      "// Validate the model-owned semantic fields before editing anything.",
      "const [senderNonceBound, confirmerNonceBound]",
    );
    expectOrdered(acceptance, [
      'requireExactlyOneCardControl(frame, "Type")',
      'requireExactlyOneCardControl(frame, "Amount")',
      'requireExactlyOneCardControl(frame, "Currency")',
      'requireExactlyOneCardControl(frame, "Direction")',
      'requireExactlyOneCardControl(frame, "Date")',
      "assertAcceptedVisionExtraction({",
      "entryCount,",
      "kind: await transaction.inputValue()",
      "date: await date.inputValue()",
      "await noteControl.fill(note)",
    ]);
    expect(acceptance).not.toContain('transaction.selectOption("iou")');
    expect(acceptance).not.toContain("date.fill(");
    expect(acceptance).not.toContain("date.press(");
    expect(acceptance).not.toContain("data-public-message-evidence");
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
    expect(finalizer.match(/cleanupCheck\(/g)?.length).toBe(7);
    expectOrdered(finalizer, [
      "if (deliveryObserved)",
      "await bucketCount(a, fpProposer)",
      "action-inbox bucket verification failed",
      "for (const trackedCard of [...senderRunCards.values()].sort(",
      "deleteExactMessagePersistentlyViaUi(proposerOC, trackedCard)",
      "deleteExactMessagePersistentlyViaUi(proposerOC, exactSourceDeletionTarget)",
      "} finally {",
      "removeManualPromptOverride(proposerOC, handleToRemove)",
      "removeNewCardObserver(proposerOC).catch",
      "removeNewCardObserver(confirmerOC).catch",
      "proposerQcPage?.close().catch",
    ]);
  });

  it("uses sender UI deletion, card first, and verifies persistence after reload", () => {
    const cleanup = journey.indexOf("const proposerDeleted:");
    const cardDelete = journey.indexOf(
      "deleteExactMessagePersistentlyViaUi(proposerOC, trackedCard)",
      cleanup,
    );
    const sourceDelete = journey.indexOf(
      "deleteExactMessagePersistentlyViaUi(proposerOC, exactSourceDeletionTarget)",
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
      'identity.appName.toLocaleLowerCase("en-US") === "iou"',
    );
    expect(evidence).not.toContain("IOU card identity no longer matches");
  });

  it("opens the exact classic deletion menu through the bounded responsive fallback", () => {
    const deletion = between(
      "async function deleteExactMessageViaUi(",
      "async function verifyDeletedAfterReload(",
    );
    expectOrdered(deletion, [
      "exactMessageEvidencePresent(page, message, evidence)",
      "messageOwnedByCurrentUser(page, message)",
      'const bubble = wrapper.locator(".bubble-wrapper")',
      "await dismissOpenChatOverlay(page)",
      "await bubble.hover()",
      'const menuIcons = bubble.locator(".menu-icon")',
      "visibleMatches(menuIcons)",
      "await visibleMenuIcons[0].click",
      "(await menuIcons.count()) !== 1",
      'node.closest(".menu")',
      "node.isConnected",
      'getComputedStyle(menu).display === "none"',
      "await menuIcons.dispatchEvent(\"click\")",
    ]);
    expect(deletion).not.toContain('page.locator(".menu-icon")');
    expect(deletion).not.toContain(".last()");
  });

  it("dismisses every blocking overlay and waits through sender-menu animation", () => {
    const overlays = between(
      "async function blockingOpenChatOverlayCount(",
      "async function exactMessageEvidencePresent(",
    );
    expect(overlays).toContain('document.querySelectorAll(".overlay")');
    expect(overlays).toContain('getComputedStyle(overlay).pointerEvents !== "none"');
    expect(overlays).toContain("remainingBlockingOverlays");
    expect(overlays).toContain("blocking OpenChat overlay(s) could not be dismissed");
    expect(overlays).not.toContain("#masked_overlay");

    const deletion = between(
      "async function deleteExactMessageViaUi(",
      "async function verifyDeletedAfterReload(",
    );
    expectOrdered(deletion, [
      "const deleteMenuDeadline = Date.now() + 10_000",
      "while (Date.now() < deleteMenuDeadline)",
      'name: "Delete for me", exact: true',
      "UI offered Delete for me instead of sender deletion",
      'name: "Delete", exact: true',
      'await senderDelete[0].dispatchEvent("click", undefined, { timeout: 2_000 })',
      "deleteDispatched = true",
      "if (!deleteDispatched)",
    ]);
  });

  it("activates the exact visible sender Delete before its responsive menu can rerender", () => {
    const deletion = between(
      "async function deleteExactMessageViaUi(",
      "async function verifyDeletedAfterReload(",
    );
    expectOrdered(deletion, [
      "while (Date.now() < deleteMenuDeadline)",
      'name: "Delete for me", exact: true',
      "if (deleteForMe.length !== 0)",
      'name: "Delete", exact: true',
      "if (senderDelete.length > 1)",
      "if (senderDelete.length === 1)",
      'await senderDelete[0].dispatchEvent("click", undefined, { timeout: 2_000 })',
      "deleteDispatched = true",
      "if (!deleteDispatched)",
    ]);
    expect(deletion).not.toContain("let deleteItem: Locator | null");
    expect(deletion).not.toContain("deleteItem = senderDelete[0]");
    expect(deletion).not.toContain("await deleteItem.click");
  });

  it("refreshes the cleanup boundary once and revalidates every exact target before deletion", () => {
    const refresh = between(
      "async function refreshExactOpenChatDeletionBoundary(",
      "async function deleteExactMessageViaUi(",
    );
    expectOrdered(refresh, [
      "if (targets.length === 0) return",
      "const exactChatUrl = page.url()",
      'await page.reload({ waitUntil: "domcontentloaded" })',
      '.locator(".ProseMirror")',
      '.waitFor({ state: "visible", timeout: 20_000 })',
      "if (page.url() !== exactChatUrl)",
      "for (const target of targets)",
      "exactMessageEvidencePresent(page, target.message, target.evidence)",
      "messageRefFromWrapper(",
      "messageOwnedByCurrentUser(page, target.message)",
      "sameStableMessage(target.message, observed)",
    ]);
    expect(refresh).not.toContain(".last()");
    expect(refresh).not.toContain("newest");

    const finalizer = between("} finally {\n    try {", "if (failures > 0)");
    expectOrdered(finalizer, [
      "cleanup returned both action-inbox buckets to their pre-run counts",
      "const exactCardDeletionTargets",
      "const exactSourceDeletionTarget",
      "await refreshExactOpenChatDeletionBoundary(",
      "for (const trackedCard of exactCardDeletionTargets)",
      "deleteExactMessagePersistentlyViaUi(proposerOC, trackedCard)",
    ]);
    expect(finalizer.match(/refreshExactOpenChatDeletionBoundary\(/g)).toHaveLength(1);
    const beforeRefresh = finalizer.slice(
      0,
      finalizer.indexOf("await refreshExactOpenChatDeletionBoundary("),
    );
    expect(beforeRefresh).not.toContain("proposerOC.reload(");
  });

  it("contains cleanup-boundary refresh failure to OpenChat deletion", () => {
    const finalizer = between("} finally {\n    try {", "if (failures > 0)");
    expectOrdered(finalizer, [
      "let openChatDeletionBoundaryReady = true",
      "try {",
      "await refreshExactOpenChatDeletionBoundary(",
      "catch (error)",
      "failures++",
      "openChatDeletionBoundaryReady = false",
      "OpenChat deletion boundary refresh failed",
      "if (openChatDeletionBoundaryReady)",
      "for (const trackedCard of exactCardDeletionTargets)",
    ]);
    expect(finalizer).toContain("OpenChat message deletion was skipped");
    expectOrdered(finalizer, [
      "cleanupIouRun(",
      "action-inbox bucket verification failed",
      "await refreshExactOpenChatDeletionBoundary(",
    ]);
  });

  it("retries only the same exact deletion when optimistic success reappears after reload", () => {
    const persistence = between(
      "async function deleteExactMessagePersistentlyViaUi(",
      "async function verifyDeletedAfterReload(",
    );
    expectOrdered(persistence, [
      "const maxPersistenceAttempts = 3",
      "const backendDeleteSettleMs = 5_000",
      "for (let attempt = 0; attempt < maxPersistenceAttempts; attempt++)",
      "await deleteExactMessageViaUi(page, target.message, target.evidence)",
      "await page.waitForTimeout(backendDeleteSettleMs)",
      'await page.reload({ waitUntil: "domcontentloaded" })',
      '.waitFor({ state: "visible", timeout: 20_000 })',
      "if (page.url() !== exactChatUrl)",
      "const reappearanceDeadline = Date.now() + 5_000",
      "exactMessageWrapper(page, target.message)",
      "exactMessageDeletionProven(page, target.message)",
      "exactMessageEvidencePresent(page, target.message, target.evidence)",
      "messageRefFromWrapper(",
      "messageOwnedByCurrentUser(page, target.message)",
      "sameStableMessage(target.message, observed)",
      "attempt + 1 >= maxPersistenceAttempts",
    ]);
    expect(
      persistence.match(
        /if \(await exactMessageDeletionProven\(page, target\.message\)\) return;/g,
      ),
    ).toHaveLength(2);
    expect(persistence).not.toContain("MESSAGE_WRAPPER_SELECTOR");
    expect(persistence).not.toContain(".last()");
    expect(persistence).not.toContain("newest");

    const finalizer = between("} finally {\n    try {", "if (failures > 0)");
    const cardDelete = finalizer.indexOf(
      "deleteExactMessagePersistentlyViaUi(proposerOC, trackedCard)",
    );
    const sourceDelete = finalizer.indexOf(
      "deleteExactMessagePersistentlyViaUi(proposerOC, exactSourceDeletionTarget)",
    );
    const finalReloadProof = finalizer.indexOf(
      "verifyDeletedAfterReload(proposerOC, proposerDeleted)",
    );
    const participantProof = finalizer.indexOf(
      "verifyDeletedAfterReload(confirmerOC, confirmerDeleted)",
    );
    expect(cardDelete).toBeGreaterThanOrEqual(0);
    expect(sourceDelete).toBeGreaterThan(cardDelete);
    expect(finalReloadProof).toBeGreaterThan(sourceDelete);
    expect(participantProof).toBeGreaterThan(finalReloadProof);
    const deletion = between(
      "async function deleteExactMessageViaUi(",
      "async function deleteExactMessagePersistentlyViaUi(",
    );
    expect(deletion).toContain('name: "Delete for me", exact: true');
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
      'senderDelete[0].dispatchEvent("click", undefined, { timeout: 2_000 })',
      "shouldRetryExactMessageDeletion({",
    ]);
    expect(deletion).not.toContain(".last()");
    expect(deletion).not.toMatch(/filter\(\{\s*hasText:/);
  });
});
