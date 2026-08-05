// Native-only secure-storage adapter for durable production cryptographic
// records. vetKD transport keys are ephemeral; this store now holds the
// consumer keypair cache and purges obsolete transport-key records. Never add
// a localStorage fallback here: a failed/missing keystore must fail closed.

import { Capacitor } from '@capacitor/core';
import {
  KeychainAccess,
  SecureStorage,
} from '@aparajita/capacitor-secure-storage';

const KEY_PREFIX = 'iou:vetkd:';

export function isMobileNative(): boolean {
  return Capacitor.isNativePlatform();
}

async function configureNativeStore(): Promise<void> {
  if (!isMobileNative()) {
    throw new Error('native secure storage is unavailable on this platform');
  }
  // Keep IOU keys in a dedicated namespace, never sync key material through
  // iCloud, and make iOS records non-migrating between devices.
  await SecureStorage.setKeyPrefix(KEY_PREFIX);
  await SecureStorage.setSynchronize(false);
  await SecureStorage.setDefaultKeychainAccess(
    KeychainAccess.whenUnlockedThisDeviceOnly,
  );
}

export async function secureSet(key: string, value: string): Promise<void> {
  await configureNativeStore();
  await SecureStorage.setItem(key, value);
}

export async function secureGet(key: string): Promise<string | null> {
  await configureNativeStore();
  return SecureStorage.getItem(key);
}

export async function secureDel(key: string): Promise<void> {
  await configureNativeStore();
  await SecureStorage.removeItem(key);
}
