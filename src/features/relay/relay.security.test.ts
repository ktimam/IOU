import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deletePending,
  fetchPending,
  getRelayConfig,
  listPairings,
  normalizeRelayUrl,
  relayStorageKey,
  revokePairing,
  setRelayConfig,
  type RelayConfig,
} from './relay';

const token = 'iou_' + 'ab'.repeat(24);
const cfg = (url: string): RelayConfig => ({ url, token });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('relay URL policy', () => {
  it.each([
    'https://relay.example',
    'http://127.0.0.1:8788',
    'http://localhost:8788',
    'http://[::1]:8788',
  ])('accepts a secure or loopback relay origin: %s', (url) => {
    expect(normalizeRelayUrl(url)).toBe(url);
  });

  it.each([
    'http://relay.example',
    'ftp://relay.example',
    'https://user:pass@relay.example',
    'https://relay.example/path',
    'https://relay.example/#fragment',
  ])('rejects an unsafe or ambiguous relay base: %s', (url) => {
    expect(() => normalizeRelayUrl(url)).toThrow(/relay URL/i);
  });
});

describe('relay bearer transport', () => {
  it('keeps relay bearer credentials isolated by principal and deployment', () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    setRelayConfig('principal-a', 'https://relay.example', token);
    expect(getRelayConfig('principal-b')).toBeNull();
    expect(getRelayConfig('principal-a')).toEqual({
      url: 'https://relay.example',
      token,
    });
    expect(relayStorageKey('token', 'principal-a', 'deployment-a')).not.toBe(
      relayStorageKey('token', 'principal-a', 'deployment-b'),
    );
  });

  it('polls without placing the bearer token in the URL', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ drafts: [] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);

    await fetchPending(cfg('https://relay.example'));

    const [url, init] = vi.mocked(fetchMock).mock.calls[0];
    expect(String(url)).toBe('https://relay.example/v1/drafts');
    expect(String(url)).not.toContain(token);
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    expect(init?.cache).toBe('no-store');
  });

  it('uses the Authorization header for delete, list, and revoke operations', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pairings: [] }),
    })) as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    const config = cfg('https://relay.example');

    await deletePending(config, 'draft/1');
    await listPairings(config);
    await revokePairing(config, 'user/1');

    for (const [url, init] of vi.mocked(fetchMock).mock.calls) {
      expect(String(url)).not.toContain(token);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${token}`);
    }
  });

  it('rejects cleartext remote relays before issuing a request', async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', fetchMock);
    await expect(fetchPending(cfg('http://relay.example'))).rejects.toThrow(/relay URL/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
