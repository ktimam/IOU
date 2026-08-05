import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  native: true,
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
}));

vi.mock('./mobileSecureStorage', () => ({
  isMobileNative: () => storage.native,
  secureGet: storage.get,
  secureSet: storage.set,
  secureDel: storage.del,
}));

describe('production vetKD ephemeral transport keys', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storage.native = true;
    storage.get.mockResolvedValue(null);
    storage.set.mockResolvedValue(undefined);
    storage.del.mockResolvedValue(undefined);
    vi.stubGlobal('indexedDB', undefined);
  });

  it('keeps a native transport key in session memory and never persists it', async () => {
    const { loadOrCreateTransportKey } = await import('./prodVetkd');

    const key = await loadOrCreateTransportKey();

    expect(key.secretKey).toHaveLength(32);
    expect(key.publicKey).toHaveLength(48);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.del).toHaveBeenCalledWith('transport:v1');
  });

  it('coalesces concurrent calls into one key for the current session', async () => {
    const { loadOrCreateTransportKey } = await import('./prodVetkd');

    const [first, second] = await Promise.all([
      loadOrCreateTransportKey(),
      loadOrCreateTransportKey(),
    ]);

    expect(first).toBe(second);
    expect(first.secretKey).toEqual(second.secretKey);
    expect(storage.del).toHaveBeenCalledTimes(1);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('creates a new transport key after the session key is reset', async () => {
    const { forgetTransportKey, loadOrCreateTransportKey } = await import('./prodVetkd');

    const first = await loadOrCreateTransportKey();
    await forgetTransportKey();
    const second = await loadOrCreateTransportKey();

    expect(second.secretKey).not.toEqual(first.secretKey);
    expect(second.publicKey).not.toEqual(first.publicKey);
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('works in a production web session without IndexedDB or native storage', async () => {
    storage.native = false;
    const { loadOrCreateTransportKey } = await import('./prodVetkd');

    const key = await loadOrCreateTransportKey();

    expect(key.secretKey).toHaveLength(32);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
    expect(storage.del).not.toHaveBeenCalled();
  });

  it('purges the obsolete web IndexedDB transport record before generating', async () => {
    storage.native = false;
    const remove = vi.fn();
    const transaction = {
      objectStore: () => ({ delete: remove }),
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      error: null,
    };
    const request = {
      result: {
        createObjectStore: vi.fn(),
        transaction: () => transaction,
      },
      onupgradeneeded: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onsuccess: null as (() => void) | null,
      error: null,
    };
    const open = vi.fn(() => {
      queueMicrotask(() => {
        request.onsuccess?.();
        queueMicrotask(() => transaction.oncomplete?.());
      });
      return request;
    });
    vi.stubGlobal('indexedDB', { open });
    const { loadOrCreateTransportKey } = await import('./prodVetkd');

    const key = await loadOrCreateTransportKey();

    expect(key.secretKey).toHaveLength(32);
    expect(open).toHaveBeenCalledWith('iou-vetkd', 1);
    expect(remove).toHaveBeenCalledWith('iou:vetkd:transport:v1');
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.set).not.toHaveBeenCalled();
  });

  it('fails closed when an obsolete native transport secret cannot be purged', async () => {
    storage.del.mockRejectedValue(new Error('keystore locked'));
    const { loadOrCreateTransportKey } = await import('./prodVetkd');

    await expect(loadOrCreateTransportKey()).rejects.toThrow(/keystore locked/i);
    expect(storage.set).not.toHaveBeenCalled();
  });
});
