import { describe, expect, it } from 'vitest';
import {
  assertAcceptedVisionExtraction,
  classifySentImageResource,
  journeySourceText,
  matchesExactImageContentEvidence,
  matchesStableDraftMessageBoundary,
  matchesRunCardCandidate,
  retainsNonceBoundCardEvidence,
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
  it('allows mounted-message virtualization while preserving stable draft-only boundaries', () => {
    const expected = {
      maxMessageIndex: 10,
      maxEventIndex: 11,
      records: [
        {
          messageId: '3',
          messageIndex: 8,
          eventIndex: 9,
          evidenceDigest: 'a'.repeat(64),
        },
        {
          messageId: '9',
          messageIndex: 10,
          eventIndex: 11,
          evidenceDigest: 'b'.repeat(64),
        },
      ],
    };

    expect(
      matchesStableDraftMessageBoundary(expected, {
        maxMessageIndex: 10,
        maxEventIndex: 11,
        records: [expected.records[1]],
      }),
    ).toBe(true);

    expect(
      matchesStableDraftMessageBoundary(expected, {
        maxMessageIndex: 10,
        maxEventIndex: 11,
        records: [
          {
            messageId: '2',
            messageIndex: 7,
            eventIndex: 8,
            evidenceDigest: 'c'.repeat(64),
          },
          expected.records[1],
        ],
      }),
    ).toBe(true);
  });

  it('rejects fresh, changed, ambiguous, or uncorrelated draft-boundary observations', () => {
    const expected = {
      maxMessageIndex: 10,
      maxEventIndex: 11,
      records: [
        {
          messageId: '9',
          messageIndex: 10,
          eventIndex: 11,
          evidenceDigest: 'a'.repeat(64),
        },
      ],
    };
    const mismatches = [
      {
        maxMessageIndex: 12,
        maxEventIndex: 11,
        records: [
          expected.records[0],
          {
            messageId: '10',
            messageIndex: 12,
            eventIndex: 11,
            evidenceDigest: 'b'.repeat(64),
          },
        ],
      },
      {
        maxMessageIndex: 10,
        maxEventIndex: 12,
        records: [
          expected.records[0],
          {
            messageId: '10',
            messageIndex: 9,
            eventIndex: 12,
            evidenceDigest: 'b'.repeat(64),
          },
        ],
      },
      {
        maxMessageIndex: 10,
        maxEventIndex: 11,
        records: [{ ...expected.records[0], evidenceDigest: 'b'.repeat(64) }],
      },
      {
        maxMessageIndex: 9,
        maxEventIndex: 10,
        records: [
          {
            ...expected.records[0],
            messageIndex: 9,
            eventIndex: 10,
          },
        ],
      },
      {
        maxMessageIndex: 10,
        maxEventIndex: 11,
        records: [
          {
            messageId: '9',
            messageIndex: 9,
            eventIndex: 10,
            evidenceDigest: 'a'.repeat(64),
          },
          {
            messageId: '8',
            messageIndex: 10,
            eventIndex: 11,
            evidenceDigest: 'b'.repeat(64),
          },
        ],
      },
      {
        maxMessageIndex: -1,
        maxEventIndex: -1,
        records: [],
      },
      {
        maxMessageIndex: 9,
        maxEventIndex: 10,
        records: [
          {
            messageId: '8',
            messageIndex: 9,
            eventIndex: 10,
            evidenceDigest: 'b'.repeat(64),
          },
        ],
      },
    ];

    for (const observed of mismatches) {
      expect(
        matchesStableDraftMessageBoundary(expected, observed),
      ).toBe(false);
    }

    expect(
      matchesStableDraftMessageBoundary(expected, {
        maxMessageIndex: 10,
        maxEventIndex: 11,
        records: [expected.records[0], expected.records[0]],
      }),
    ).toBe(false);
    expect(
      matchesStableDraftMessageBoundary(expected, {
        maxMessageIndex: 10,
        maxEventIndex: 11,
        records: [{ ...expected.records[0], evidenceDigest: 'not-a-digest' }],
      }),
    ).toBe(false);
    expect(
      matchesStableDraftMessageBoundary(
        { maxMessageIndex: -1, maxEventIndex: -1, records: [] },
        { maxMessageIndex: -1, maxEventIndex: -1, records: [] },
      ),
    ).toBe(true);
  });

  it('waits through OpenChat blob and thumbnail fallbacks until the exact HTTP upload is rendered', () => {
    expect(
      classifySentImageResource({
        attributeSrc: 'blob:http://localhost:5003/draft',
        src: 'blob:http://localhost:5003/draft',
        currentSrc: 'blob:http://localhost:5003/draft',
        complete: true,
        naturalWidth: 900,
        naturalHeight: 680,
      }),
    ).toEqual({ kind: 'pending', reason: 'temporary' });

    expect(
      classifySentImageResource({
        attributeSrc: 'data:image/png;base64,dGh1bWJuYWls',
        src: 'data:image/png;base64,dGh1bWJuYWls',
        currentSrc: 'data:image/png;base64,dGh1bWJuYWls',
        complete: true,
        naturalWidth: 300,
        naturalHeight: 227,
      }),
    ).toEqual({ kind: 'pending', reason: 'temporary' });

    expect(
      classifySentImageResource({
        attributeSrc: 'http://aaaaa-aa.localhost:8080/blobs/42',
        src: 'http://aaaaa-aa.localhost:8080/blobs/42',
        currentSrc: 'data:image/png;base64,dGh1bWJuYWls',
        complete: true,
        naturalWidth: 300,
        naturalHeight: 227,
      }),
    ).toEqual({ kind: 'pending', reason: 'transition' });

    expect(
      classifySentImageResource({
        attributeSrc: 'http://aaaaa-aa.localhost:8080/blobs/42',
        src: 'http://aaaaa-aa.localhost:8080/blobs/42',
        currentSrc: 'http://aaaaa-aa.localhost:8080/blobs/42',
        complete: true,
        naturalWidth: 900,
        naturalHeight: 680,
      }),
    ).toEqual({
      kind: 'ready',
      url: 'http://aaaaa-aa.localhost:8080/blobs/42',
    });
  });

  it('does not treat an unloaded or changing HTTP image as byte-verifiable', () => {
    expect(
      classifySentImageResource({
        attributeSrc: 'https://storage.example/new',
        src: 'https://storage.example/new',
        currentSrc: '',
        complete: false,
        naturalWidth: 0,
        naturalHeight: 0,
      }),
    ).toEqual({ kind: 'pending', reason: 'not-loaded' });

    expect(
      classifySentImageResource({
        attributeSrc: 'https://storage.example/new',
        src: 'https://storage.example/new',
        currentSrc: 'https://storage.example/old',
        complete: true,
        naturalWidth: 900,
        naturalHeight: 680,
      }),
    ).toEqual({ kind: 'pending', reason: 'transition' });
  });

  it.each([
    'ftp://storage.example/image.png',
    'javascript:alert(1)',
    'data:text/html;base64,PGgxPm5vdCBhbiBpbWFnZTwvaDE+',
    'not a resolved URL',
  ])('fails closed for terminal unsupported sent-image URL %s', (url) => {
    expect(() =>
      classifySentImageResource({
        attributeSrc: url,
        src: url,
        currentSrc: url,
        complete: true,
        naturalWidth: 900,
        naturalHeight: 680,
      }),
    ).toThrow(/unsupported|invalid/i);
  });

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
        baselineMaxMessageIndex: 40,
        baselineMaxEventIndex: 51,
      }),
    ).toEqual({ messageId: '101', messageIndex: 41, eventIndex: 52 });
  });

  it('rejects an exact older image that was virtualized outside the pre-send DOM baseline', () => {
    const virtualizedHistorical = {
      messageId: '99',
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
        candidates: [virtualizedHistorical, fresh],
        baselineMessageIds: new Set(['100']),
        baselineMaxMessageIndex: 40,
        baselineMaxEventIndex: 51,
      }),
    ).toEqual({ messageId: '101', messageIndex: 41, eventIndex: 52 });

    expect(
      selectFreshOwnedSourceCandidate({
        candidates: [{ ...fresh, eventIndex: 51 }],
        baselineMessageIds: new Set(['100']),
        baselineMaxMessageIndex: 40,
        baselineMaxEventIndex: 51,
      }),
    ).toBeNull();
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
        baselineMaxMessageIndex: -1,
        baselineMaxEventIndex: -1,
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
  const exactFixtureExtraction = {
    entryCount: 1,
    kind: 'iou',
    amount: '350.00',
    currency: 'EGP',
    direction: 'credit',
    date: '',
  } as const;

  it('accepts every initial semantic value and the blank image-only date from the fixture', () => {
    expect(
      assertAcceptedVisionExtraction(exactFixtureExtraction),
    ).toEqual({
      entryCount: 1,
      kind: 'iou',
      amount: 350,
      currency: 'EGP',
      direction: 'credit',
      date: '',
    });
  });

  it.each([
    [{ ...exactFixtureExtraction, entryCount: 0 }, 'entry count'],
    [{ ...exactFixtureExtraction, entryCount: 2 }, 'entry count'],
    [{ ...exactFixtureExtraction, kind: '' }, 'kind'],
    [{ ...exactFixtureExtraction, kind: 'settlement' }, 'kind'],
    [{ ...exactFixtureExtraction, amount: '' }, 'amount'],
    [{ ...exactFixtureExtraction, amount: '351' }, 'amount'],
    [{ ...exactFixtureExtraction, currency: 'USD' }, 'currency'],
    [{ ...exactFixtureExtraction, direction: 'debt' }, 'direction'],
    [{ ...exactFixtureExtraction, date: '2026-08-08' }, 'date'],
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

describe('nonce-bound confirmed-card evidence', () => {
  const target: StableMessageRef = {
    messageId: '800',
    messageIndex: 99,
    eventIndex: 100,
  };

  it('retains a previously verified nonce when the same owned card message is consumed', () => {
    expect(
      retainsNonceBoundCardEvidence({
        target,
        boundMessage: target,
        senderOwned: true,
        boundExactNote: 'journey-run-800',
        currentIdentity: 'unavailable',
        currentNote: 'unavailable',
      }),
    ).toBe(true);
  });

  it.each([
    {
      label: 'stable coordinates changed',
      boundMessage: { ...target, eventIndex: 101 },
      senderOwned: true,
      boundExactNote: 'journey-run-800',
      currentIdentity: 'unavailable' as const,
      currentNote: 'unavailable' as const,
    },
    {
      label: 'message is no longer sender-owned',
      boundMessage: target,
      senderOwned: false,
      boundExactNote: 'journey-run-800',
      currentIdentity: 'unavailable' as const,
      currentNote: 'unavailable' as const,
    },
    {
      label: 'no exact note was bound before collapse',
      boundMessage: target,
      senderOwned: true,
      boundExactNote: '   ',
      currentIdentity: 'match' as const,
      currentNote: 'unavailable' as const,
    },
    {
      label: 'a currently rendered card has another app identity',
      boundMessage: target,
      senderOwned: true,
      boundExactNote: 'journey-run-800',
      currentIdentity: 'mismatch' as const,
      currentNote: 'unavailable' as const,
    },
    {
      label: 'a currently rendered card exposes another note',
      boundMessage: target,
      senderOwned: true,
      boundExactNote: 'journey-run-800',
      currentIdentity: 'match' as const,
      currentNote: 'mismatch' as const,
    },
  ])('fails closed when $label', (scenario) => {
    expect(
      retainsNonceBoundCardEvidence({
        target,
        ...scenario,
      }),
    ).toBe(false);
  });
});
