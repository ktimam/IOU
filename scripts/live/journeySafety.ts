export type StableMessageRef = Readonly<{
  messageId: string;
  messageIndex: number;
  eventIndex: number;
}>;

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
