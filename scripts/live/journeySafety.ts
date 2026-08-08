export type StableMessageRef = Readonly<{
  messageId: string;
  messageIndex: number;
  eventIndex: number;
}>;

export type ExactImageContentEvidence = Readonly<{
  sha256: string;
  byteLength: number;
  mimeType: string;
}>;

function hasValidImageContentEvidence(value: ExactImageContentEvidence): boolean {
  return (
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    /^image\/[a-z0-9][a-z0-9.+-]*$/.test(value.mimeType)
  );
}

/** Compare the processed image bytes that OpenChat previews and then uploads, not their URL. */
export function matchesExactImageContentEvidence(
  expected: ExactImageContentEvidence,
  observed: ExactImageContentEvidence,
): boolean {
  return (
    hasValidImageContentEvidence(expected) &&
    hasValidImageContentEvidence(observed) &&
    expected.sha256 === observed.sha256 &&
    expected.byteLength === observed.byteLength &&
    expected.mimeType === observed.mimeType
  );
}

export type FreshSourceCandidate = StableMessageRef &
  Readonly<{
    senderOwned: boolean;
    exactEvidenceMatches: number;
  }>;

type JourneySourceTextInput = Readonly<{
  imagePath: string | undefined;
  nonce: string;
}>;

/** An attached image is the complete user message; only text-only runs get a visible body. */
export function journeySourceText(input: JourneySourceTextInput): string | undefined {
  if (input.imagePath !== undefined) return undefined;
  return `Journey ${input.nonce}: cleaning fee 350 EGP`;
}

type RunCardCandidate = Readonly<{
  candidate: StableMessageRef;
  senderOwned: boolean;
  exactNoteMatch: boolean;
  expectedSource?: StableMessageRef;
  expectedMessage?: StableMessageRef;
  requireSenderOwned: boolean;
}>;

function hasValidCoordinates(message: StableMessageRef): boolean {
  return (
    /^\d+$/.test(message.messageId) &&
    Number.isSafeInteger(message.messageIndex) &&
    message.messageIndex >= 0 &&
    Number.isSafeInteger(message.eventIndex) &&
    message.eventIndex >= 0
  );
}

/**
 * Select a mutation target only from exact source evidence that was absent from the pre-send
 * message-id baseline. The DOM collector supplies the count of exact text/blob matches within each
 * stable wrapper; this pure boundary rejects repeated evidence, multiple wrappers, invalid stable
 * coordinates, and recipient-owned content.
 */
export function selectFreshOwnedSourceCandidate(input: Readonly<{
  candidates: readonly FreshSourceCandidate[];
  baselineMessageIds: ReadonlySet<string>;
}>): StableMessageRef | null {
  const matches: FreshSourceCandidate[] = [];
  for (const candidate of input.candidates) {
    if (input.baselineMessageIds.has(candidate.messageId)) continue;
    if (
      !Number.isSafeInteger(candidate.exactEvidenceMatches) ||
      candidate.exactEvidenceMatches < 0
    ) {
      throw new Error("source evidence count is invalid");
    }
    if (candidate.exactEvidenceMatches > 1) {
      throw new Error("fresh source attachment evidence is ambiguous within one message");
    }
    if (candidate.exactEvidenceMatches === 1) matches.push(candidate);
  }

  if (matches.length > 1) {
    throw new Error("multiple fresh messages exactly matched this run");
  }
  if (matches.length === 0) return null;

  const selected = matches[0];
  if (!hasValidCoordinates(selected)) {
    throw new Error("fresh source has invalid stable message coordinates");
  }
  if (!selected.senderOwned) {
    throw new Error("fresh source is not sender-owned");
  }
  return {
    messageId: selected.messageId,
    messageIndex: selected.messageIndex,
    eventIndex: selected.eventIndex,
  };
}

export function sameStableMessage(
  left: StableMessageRef,
  right: StableMessageRef,
): boolean {
  return (
    hasValidCoordinates(left) &&
    hasValidCoordinates(right) &&
    left.messageId === right.messageId &&
    left.messageIndex === right.messageIndex &&
    left.eventIndex === right.eventIndex
  );
}

export function isImmediateStableSuccessor(
  source: StableMessageRef,
  candidate: StableMessageRef,
): boolean {
  return (
    hasValidCoordinates(source) &&
    hasValidCoordinates(candidate) &&
    source.messageId !== candidate.messageId &&
    candidate.messageIndex === source.messageIndex + 1 &&
    candidate.eventIndex === source.eventIndex + 1
  );
}

/**
 * Fail-closed targeting for a mutating live journey.
 *
 * The sender may select only their own immediate stable successor to the captured source. Once the
 * sender has selected that exact card, the recipient may select only the identical three stable
 * coordinates. A matching note is useful secondary evidence, but never overrides either boundary.
 */
export function matchesRunCardCandidate(input: RunCardCandidate): boolean {
  if (!hasValidCoordinates(input.candidate)) return false;
  if (input.requireSenderOwned && !input.senderOwned) return false;

  if (input.expectedMessage !== undefined) {
    return sameStableMessage(input.candidate, input.expectedMessage);
  }
  if (input.expectedSource !== undefined) {
    return (
      input.senderOwned &&
      isImmediateStableSuccessor(input.expectedSource, input.candidate)
    );
  }
  return input.exactNoteMatch;
}

type VisionExtraction = Readonly<{
  amount: string;
  currency: string;
  direction: string;
}>;

/** Validate the meaningful model-owned values before the harness edits any downstream field. */
export function assertAcceptedVisionExtraction(
  extraction: VisionExtraction,
): Readonly<{ amount: number; currency: 'EGP'; direction: 'credit' }> {
  const amount = Number(extraction.amount);
  if (!Number.isFinite(amount) || amount !== 350) {
    throw new Error(`real image amount must be 350 before editing; received ${extraction.amount}`);
  }
  if (extraction.currency !== 'EGP') {
    throw new Error(
      `real image currency must be EGP before editing; received ${extraction.currency || 'empty'}`,
    );
  }
  if (extraction.direction !== 'credit') {
    throw new Error(
      `real image direction must be credit before editing; received ${extraction.direction || 'empty'}`,
    );
  }
  return { amount, currency: 'EGP', direction: 'credit' };
}

type ExactMessageDeletionRetry = Readonly<{
  attempt: number;
  maxAttempts: number;
  error: unknown;
  target: StableMessageRef;
  observed: StableMessageRef;
  evidencePresent: boolean;
  senderOwned: boolean;
}>;

function isDetachedRenderChurn(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:element|node).*(?:detached|not attached)|detached from (?:the )?dom|stale element/i.test(
    message,
  );
}

/** Retry only a transient DOM detach for the still-present, sender-owned, identical target. */
export function shouldRetryExactMessageDeletion(
  state: ExactMessageDeletionRetry,
): boolean {
  return (
    Number.isSafeInteger(state.attempt) &&
    Number.isSafeInteger(state.maxAttempts) &&
    state.attempt >= 0 &&
    state.maxAttempts > 0 &&
    state.attempt + 1 < state.maxAttempts &&
    state.evidencePresent &&
    state.senderOwned &&
    sameStableMessage(state.target, state.observed) &&
    isDetachedRenderChurn(state.error)
  );
}
