import { describe, expect, it } from 'vitest';
import {
  assertAcceptedVisionExtraction,
  journeySourceText,
  matchesExactImageContentEvidence,
  matchesRunCardCandidate,
  selectFreshOwnedSourceCandidate,
  shouldRetryExactMessageDeletion,
  type StableMessageRef,
} from '../../scripts/live/journeySafety';

const source: StableMessageRef = {
  messageId: '100',
  messageIndex: 40,
  eventIndex: 51,
};

describe('live journey source policy', () => {
  it('sends an image as the entire message, without a visible caption', () => {
    expect(
      journeySourceText({
        imagePath: 'C:/fixtures/receipt.png',
        nonce: 'image-run',
      }),
    ).toBeUndefined();
  });

  it('keeps the nonce-bearing text source for a text-only journey', () => {
    expect(journeySourceText({ imagePath: undefined, nonce: 'text-run' })).toBe(
      'Journey text-run: cleaning fee 350 EGP',
    );
  });

  it('keeps exact image identity across the draft-to-upload URL transition', () => {
    const draft = {
      sha256: 'a'.repeat(64),
      byteLength: 12_345,
      mimeType: 'image/png',
    };

    expect(
      matchesExactImageContentEvidence(draft, {
        ...draft,
        // URLs are intentionally absent: identity is the processed bytes, not their location.
      }),
    ).toBe(true);
    expect(
      matchesExactImageContentEvidence(draft, {
        ...draft,
        sha256: 'b'.repeat(64),
      }),
    ).toBe(false);
    expect(
      matchesExactImageContentEvidence(draft, {
        ...draft,
        byteLength: draft.byteLength + 1,
      }),
    ).toBe(false);
    expect(
      matchesExactImageContentEvidence(draft, {
        ...draft,
        mimeType: 'image/jpeg',
      }),
    ).toBe(false);
  });

  it.each([
    { sha256: '', byteLength: 1, mimeType: 'image/png' },
    { sha256: 'a'.repeat(63), byteLength: 1, mimeType: 'image/png' },
    { sha256: 'z'.repeat(64), byteLength: 1, mimeType: 'image/png' },
    { sha256: 'a'.repeat(64), byteLength: 0, mimeType: 'image/png' },
    { sha256: 'a'.repeat(64), byteLength: 1, mimeType: '' },
  ])('rejects malformed image evidence %#', (candidate) => {
    expect(
      matchesExactImageContentEvidence(
        { sha256: 'a'.repeat(64), byteLength: 1, mimeType: 'image/png' },
        candidate,
      ),
    ).toBe(false);
  });

  it('selects only the unique fresh sender-owned exact attachment candidate', () => {
    const historical = {
      messageId: '100',
      messageIndex: 40,
      eventIndex: 51,
      senderOwned: true,
      exactEvidenceMatches: 1,
    };
    const fresh = {
      messageId: '101',
      messageIndex: 41,
      eventIndex: 52,
      senderOwned: true,
      exactEvidenceMatches: 1,
    };

    expect(
      selectFreshOwnedSourceCandidate({
        candidates: [historical, fresh],
        baselineMessageIds: new Set(['100']),
      }),
    ).toEqual({ messageId: '101', messageIndex: 41, eventIndex: 52 });
  });

  it.each([
    {
      label: 'two fresh wrappers carry the exact attachment blob',
      candidates: [
        {
          messageId: '101',
          messageIndex: 41,
          eventIndex: 52,
          senderOwned: true,
          exactEvidenceMatches: 1,
        },
        {
          messageId: '102',
          messageIndex: 42,
          eventIndex: 53,
          senderOwned: true,
          exactEvidenceMatches: 1,
        },
      ],
      error: 'multiple fresh messages',
    },
    {
      label: 'the exact attachment belongs to the recipient',
      candidates: [
        {
          messageId: '101',
          messageIndex: 41,
          eventIndex: 52,
          senderOwned: false,
          exactEvidenceMatches: 1,
        },
      ],
      error: 'not sender-owned',
    },
    {
      label: 'one wrapper repeats the attachment evidence',
      candidates: [
        {
          messageId: '101',
          messageIndex: 41,
          eventIndex: 52,
          senderOwned: true,
          exactEvidenceMatches: 2,
        },
      ],
      error: 'attachment evidence is ambiguous',
    },
  ])('fails closed when $label', ({ candidates, error }) => {
    expect(() =>
      selectFreshOwnedSourceCandidate({
        candidates,
        baselineMessageIds: new Set(),
      }),
    ).toThrow(error);
  });
});

describe('live journey mutation targeting', () => {
  it('accepts only the unique sender-owned immediate successor of the source', () => {
    const immediate: StableMessageRef = {
      messageId: '200',
      messageIndex: 41,
      eventIndex: 52,
    };

    expect(
      matchesRunCardCandidate({
        candidate: immediate,
        senderOwned: true,
        exactNoteMatch: false,
        expectedSource: source,
        requireSenderOwned: true,
      }),
    ).toBe(true);
    expect(
      matchesRunCardCandidate({
        candidate: immediate,
        senderOwned: false,
        exactNoteMatch: false,
        expectedSource: source,
        requireSenderOwned: true,
      }),
    ).toBe(false);
    expect(
      matchesRunCardCandidate({
        candidate: { ...immediate, messageIndex: 42, eventIndex: 53 },
        senderOwned: true,
        exactNoteMatch: false,
        expectedSource: source,
        requireSenderOwned: true,
      }),
    ).toBe(false);
  });

  it('lets the recipient load only the exact stable card selected on the sender side', () => {
    const selected: StableMessageRef = {
      messageId: '200',
      messageIndex: 41,
      eventIndex: 52,
    };
    expect(
      matchesRunCardCandidate({
        candidate: selected,
        senderOwned: false,
        exactNoteMatch: false,
        expectedMessage: selected,
        requireSenderOwned: false,
      }),
    ).toBe(true);
    expect(
      matchesRunCardCandidate({
        candidate: { ...selected, messageId: '201' },
        senderOwned: false,
        exactNoteMatch: true,
        expectedMessage: selected,
        requireSenderOwned: false,
      }),
    ).toBe(false);
  });
});

describe('real image acceptance', () => {
  it('accepts meaningful pre-edit values extracted from the image', () => {
    expect(
      assertAcceptedVisionExtraction({
        amount: '350.00',
        currency: 'EGP',
        direction: 'credit',
      }),
    ).toEqual({ amount: 350, currency: 'EGP', direction: 'credit' });
  });

  it.each([
    [{ amount: '', currency: 'EGP', direction: 'credit' }, 'amount'],
    [{ amount: '351', currency: 'EGP', direction: 'credit' }, 'amount'],
    [{ amount: '350', currency: 'USD', direction: 'credit' }, 'currency'],
    [{ amount: '350', currency: 'EGP', direction: 'debt' }, 'direction'],
  ])('rejects a wrong pre-edit extraction: %s', (candidate, field) => {
    expect(() => assertAcceptedVisionExtraction(candidate)).toThrow(field);
  });
});

describe('exact message deletion retries', () => {
  const target: StableMessageRef = {
    messageId: '700',
    messageIndex: 70,
    eventIndex: 80,
  };

  it('retries a bounded detached-render failure for the same owned exact target', () => {
    expect(
      shouldRetryExactMessageDeletion({
        attempt: 0,
        maxAttempts: 3,
        error: new Error('locator.click: Element was detached from the DOM'),
        target,
        observed: target,
        evidencePresent: true,
        senderOwned: true,
      }),
    ).toBe(true);
    expect(
      shouldRetryExactMessageDeletion({
        attempt: 2,
        maxAttempts: 3,
        error: new Error('locator.click: Element was detached from the DOM'),
        target,
        observed: target,
        evidencePresent: true,
        senderOwned: true,
      }),
    ).toBe(false);
  });

  it.each([
    {
      label: 'wrong stable target',
      observed: { ...target, messageId: '701' },
      evidencePresent: true,
      senderOwned: true,
      error: new Error('Element was detached from the DOM'),
    },
    {
      label: 'evidence disappeared',
      observed: target,
      evidencePresent: false,
      senderOwned: true,
      error: new Error('Element was detached from the DOM'),
    },
    {
      label: 'recipient-owned message',
      observed: target,
      evidencePresent: true,
      senderOwned: false,
      error: new Error('Element was detached from the DOM'),
    },
    {
      label: 'non-render failure',
      observed: target,
      evidencePresent: true,
      senderOwned: true,
      error: new Error('Target page, context or browser has been closed'),
    },
  ])('refuses retry for $label', (scenario) => {
    expect(
      shouldRetryExactMessageDeletion({
        attempt: 0,
        maxAttempts: 3,
        ...scenario,
        target,
      }),
    ).toBe(false);
  });
});
