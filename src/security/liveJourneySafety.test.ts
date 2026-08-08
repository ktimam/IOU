import { describe, expect, it } from 'vitest';
import {
  assertAcceptedVisionExtraction,
  matchesRunCardCandidate,
  shouldRetryExactMessageDeletion,
  type StableMessageRef,
} from '../../scripts/live/journeySafety';

const source: StableMessageRef = {
  messageId: '100',
  messageIndex: 40,
  eventIndex: 51,
};

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
