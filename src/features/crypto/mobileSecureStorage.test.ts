import { beforeEach, describe, expect, it, vi } from 'vitest';

const fakes = vi.hoisted(() => ({
  native: true,
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  setKeyPrefix: vi.fn(),
  setSynchronize: vi.fn(),
  setDefaultKeychainAccess: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => fakes.native,
  },
}));

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: {
    whenUnlockedThisDeviceOnly: 1,
  },
  SecureStorage: {
    getItem: fakes.getItem,
    setItem: fakes.setItem,
    removeItem: fakes.removeItem,
    setKeyPrefix: fakes.setKeyPrefix,
    setSynchronize: fakes.setSynchronize,
    setDefaultKeychainAccess: fakes.setDefaultKeychainAccess,
  },
}));

import {
  isMobileNative,
  secureDel,
  secureGet,
  secureSet,
} from './mobileSecureStorage';

describe('mobile secure storage', () => {
  beforeEach(() => {
    fakes.native = true;
    vi.clearAllMocks();
    fakes.getItem.mockResolvedValue(null);
    fakes.setItem.mockResolvedValue(undefined);
    fakes.removeItem.mockResolvedValue(undefined);
    fakes.setKeyPrefix.mockResolvedValue(undefined);
    fakes.setSynchronize.mockResolvedValue(undefined);
    fakes.setDefaultKeychainAccess.mockResolvedValue(undefined);
  });

  it('uses the installed plugin API and device-only keychain policy', async () => {
    await secureSet('transport:v1', 'secret-json');

    expect(isMobileNative()).toBe(true);
    expect(fakes.setKeyPrefix).toHaveBeenCalledWith('iou:vetkd:');
    expect(fakes.setSynchronize).toHaveBeenCalledWith(false);
    expect(fakes.setDefaultKeychainAccess).toHaveBeenCalledWith(1);
    expect(fakes.setItem).toHaveBeenCalledWith('transport:v1', 'secret-json');
  });

  it('reads and removes through the same native store', async () => {
    fakes.getItem.mockResolvedValue('stored-secret');

    await expect(secureGet('transport:v1')).resolves.toBe('stored-secret');
    await secureDel('transport:v1');

    expect(fakes.getItem).toHaveBeenCalledWith('transport:v1');
    expect(fakes.removeItem).toHaveBeenCalledWith('transport:v1');
  });

  it('fails closed instead of falling back to localStorage off native', async () => {
    fakes.native = false;
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });

    await expect(secureSet('transport:v1', 'secret')).rejects.toThrow(
      /native secure storage/i,
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(fakes.setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('propagates native storage failures without a plaintext fallback', async () => {
    const failure = new Error('keystore locked');
    fakes.setItem.mockRejectedValue(failure);
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });

    await expect(secureSet('transport:v1', 'secret')).rejects.toBe(failure);
    expect(setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});
