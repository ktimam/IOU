import { describe, expect, it } from 'vitest';
import { resolveE2EMode } from './e2ePolicy';

describe('required E2E environment policy', () => {
  it('runs when the configured replica is reachable', () => {
    expect(resolveE2EMode({ up: true, reason: 'ok', allowSkip: false })).toBe('run');
  });

  it('fails closed when required infrastructure is unavailable', () => {
    expect(() =>
      resolveE2EMode({
        up: false,
        reason: 'replica not reachable',
        allowSkip: false,
      }),
    ).toThrow(/required E2E environment is unavailable.*replica not reachable/i);
  });

  it('allows an explicitly requested developer skip without weakening CI defaults', () => {
    expect(
      resolveE2EMode({
        up: false,
        reason: 'local stack intentionally stopped',
        allowSkip: true,
      }),
    ).toBe('skip');
  });
});
