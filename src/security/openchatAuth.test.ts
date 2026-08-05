import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OpenChatReplayGuard,
  signOpenChatToken,
  verifyOpenChatToken,
  type OpenChatClaims,
} from '../../scripts/iou-relay/openchatAuth';

const keys = generateKeyPairSync('ed25519');
const NOW = 2_000_000_000_000;

function claims(overrides: Partial<OpenChatClaims> = {}): OpenChatClaims {
  return {
    iss: 'openchat',
    aud: 'iou-relay',
    purpose: 'draft',
    sub: 'oc_alice',
    jti: 'jti_0123456789abcdefghijklmnop',
    iat: NOW - 1_000,
    exp: NOW + 60_000,
    ...overrides,
  };
}

function token(value: OpenChatClaims): string {
  return signOpenChatToken(value, keys.privateKey);
}

describe('OpenChat relay provenance tokens', () => {
  it('accepts a context-bound, short-lived signed token', () => {
    expect(
      verifyOpenChatToken(token(claims()), keys.publicKey, NOW, 'draft'),
    ).toEqual(claims());
  });

  it.each([
    ['issuer', { iss: 'other-chat' }],
    ['audience', { aud: 'some-other-service' }],
    ['purpose', { purpose: 'pairing' }],
    ['missing token id', { jti: '' }],
    ['future issuance', { iat: NOW + 31_000 }],
    ['overlong lifetime', { exp: NOW + 5 * 60_000 + 1_001 }],
    ['already expired', { exp: NOW }],
  ])('rejects a token with the wrong %s binding', (_name, override) => {
    const invalid = claims(override as Partial<OpenChatClaims>);
    expect(
      verifyOpenChatToken(token(invalid), keys.publicKey, NOW, 'draft'),
    ).toBeNull();
  });

  it('rejects extra compact-token segments and oversized inputs', () => {
    const valid = token(claims());
    expect(
      verifyOpenChatToken(valid + '.ignored', keys.publicKey, NOW, 'draft'),
    ).toBeNull();
    expect(
      verifyOpenChatToken('a'.repeat(5_000), keys.publicKey, NOW, 'draft'),
    ).toBeNull();
  });

  it('consumes each signed token id at most once', () => {
    const guard = new OpenChatReplayGuard();
    const first = claims();

    expect(guard.consume(first, NOW)).toBe(true);
    expect(guard.consume(first, NOW)).toBe(false);
    expect(guard.consume({ ...first, sub: 'oc_bob' }, NOW)).toBe(false);
  });

  it('fails closed at replay-cache capacity and prunes expired ids', () => {
    const guard = new OpenChatReplayGuard(1);
    const first = claims({ jti: 'jti_1111111111111111111111' });
    const second = claims({ jti: 'jti_2222222222222222222222' });

    expect(guard.consume(first, NOW)).toBe(true);
    expect(guard.consume(second, NOW)).toBe(false);
    expect(guard.consume(second, first.exp)).toBe(false);
    expect(
      guard.consume({ ...second, exp: first.exp + 60_000 }, first.exp),
    ).toBe(true);
  });
});
