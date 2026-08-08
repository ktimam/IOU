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

export type SentImageResourceState = Readonly<{
  attributeSrc: string;
  src: string;
  currentSrc: string;
  complete: boolean;
  naturalWidth: number;
  naturalHeight: number;
}>;

export type SentImageResourceReadiness =
  | Readonly<{ kind: "pending"; reason: "not-loaded" | "temporary" | "transition" }>
  | Readonly<{ kind: "ready"; url: string }>;

function sentImageUrlKind(url: string): "missing" | "temporary" | "uploaded" {
  if (url === "") return "missing";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("sent image URL is invalid");
  }
  if (parsed.protocol === "blob:") return "temporary";
  if (parsed.protocol === "data:" && /^data:image\//i.test(url)) return "temporary";
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return "uploaded";
  throw new Error(`sent image URL uses an unsupported protocol: ${parsed.protocol}`);
}

/**
 * OpenChat first renders a local blob URL, can briefly render its data:image thumbnail fallback,
 * then rehydrates the message with the uploaded HTTP(S) blob URL. Only the last, fully rendered
 * state may be fetched and hashed as exact upload evidence.
 */
export function classifySentImageResource(
  state: SentImageResourceState,
): SentImageResourceReadiness {
  const attributeSrcKind = sentImageUrlKind(state.attributeSrc);
  const srcKind = sentImageUrlKind(state.src);
  const currentSrcKind = sentImageUrlKind(state.currentSrc);
  if (
    attributeSrcKind === "temporary" ||
    srcKind === "temporary" ||
    currentSrcKind === "temporary"
  ) {
    if (attributeSrcKind !== srcKind || srcKind !== currentSrcKind) {
      return { kind: "pending", reason: "transition" };
    }
    return { kind: "pending", reason: "temporary" };
  }
  if (
    attributeSrcKind === "missing" ||
    srcKind === "missing" ||
    currentSrcKind === "missing" ||
    !state.complete ||
    !Number.isFinite(state.naturalWidth) ||
    state.naturalWidth <= 0 ||
    !Number.isFinite(state.naturalHeight) ||
    state.naturalHeight <= 0
  ) {
    return { kind: "pending", reason: "not-loaded" };
  }
  if (state.attributeSrc !== state.src || state.src !== state.currentSrc) {
    return { kind: "pending", reason: "transition" };
  }
  return { kind: "ready", url: state.currentSrc };
}

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

/** Preserve a fail-closed DOM boundary around a draft-only UI mutation. */
export function matchesExactMessageInventory(input: Readonly<{
  expectedMessageIds: readonly string[];
  observedMessageIds: ReadonlySet<string>;
  expectedDigest: string;
  observedDigest: string;
}>): boolean {
  if (
    !/^[0-9a-f]{64}$/.test(input.expectedDigest) ||
    !/^[0-9a-f]{64}$/.test(input.observedDigest) ||
    input.expectedDigest !== input.observedDigest
  ) {
    return false;
  }
  const expectedIds = new Set(input.expectedMessageIds);
  if (
    expectedIds.size !== input.expectedMessageIds.length ||
    expectedIds.size !== input.observedMessageIds.size
  ) {
    return false;
  }
  return [...expectedIds].every((messageId) => input.observedMessageIds.has(messageId));
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
  baselineMaxMessageIndex: number;
  baselineMaxEventIndex: number;
}>): StableMessageRef | null {
  if (
    !Number.isSafeInteger(input.baselineMaxMessageIndex) ||
    input.baselineMaxMessageIndex < -1 ||
    !Number.isSafeInteger(input.baselineMaxEventIndex) ||
    input.baselineMaxEventIndex < -1
  ) {
    throw new Error("source baseline has invalid stable coordinate maxima");
  }
  const matches: FreshSourceCandidate[] = [];
  for (const candidate of input.candidates) {
    if (input.baselineMessageIds.has(candidate.messageId)) continue;
    if (candidate.messageIndex <= input.baselineMaxMessageIndex) continue;
    if (candidate.eventIndex <= input.baselineMaxEventIndex) continue;
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

type CurrentNonceBoundCardEvidence = "match" | "mismatch" | "unavailable";

/**
 * Retain a nonce binding after a confirmed card consumes its live UI only when the binding was
 * captured for this exact immutable message and the message is still sender-owned. Any currently
 * rendered identity or note mismatch overrides the retained evidence and fails closed.
 */
export function retainsNonceBoundCardEvidence(input: Readonly<{
  target: StableMessageRef;
  boundMessage: StableMessageRef;
  senderOwned: boolean;
  boundExactNote: string;
  currentIdentity: CurrentNonceBoundCardEvidence;
  currentNote: CurrentNonceBoundCardEvidence;
}>): boolean {
  return (
    sameStableMessage(input.target, input.boundMessage) &&
    input.senderOwned &&
    input.boundExactNote.trim().length > 0 &&
    (input.currentIdentity === "match" || input.currentIdentity === "unavailable") &&
    (input.currentNote === "match" || input.currentNote === "unavailable")
  );
}

type VisionExtraction = Readonly<{
  entryCount: number;
  kind: string;
  amount: string;
  currency: string;
  direction: string;
  date: string;
}>;

/**
 * Validate every fixture-owned model value before the harness edits any downstream field.
 *
 * The fixture visibly contains one IOU request for 350 EGP owed to the viewer and no date. The image
 * itself is the source of truth; a vision model's hidden text echo is neither required nor treated as
 * additional evidence.
 */
export function assertAcceptedVisionExtraction(
  extraction: VisionExtraction,
): Readonly<{
  entryCount: 1;
  kind: 'iou';
  amount: number;
  currency: 'EGP';
  direction: 'credit';
  date: '';
}> {
  if (!Number.isSafeInteger(extraction.entryCount) || extraction.entryCount !== 1) {
    throw new Error(
      `real image entry count must be exactly one before editing; received ${extraction.entryCount}`,
    );
  }
  if (extraction.kind !== 'iou') {
    throw new Error(
      `real image kind must be iou before editing; received ${extraction.kind || 'empty'}`,
    );
  }
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
  if (extraction.date.trim() !== '') {
    throw new Error(
      `real image date must be absent before editing; received ${extraction.date}`,
    );
  }
  return {
    entryCount: 1,
    kind: 'iou',
    amount,
    currency: 'EGP',
    direction: 'credit',
    date: '',
  };
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
