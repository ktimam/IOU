// Mobile secure-storage adapter for the prod vetkd transport key.
//
// In the browser, the transport key is persisted in IndexedDB
// (see prodVetkd.ts). On a phone (Capacitor), we want the key in
// the platform secure element — Keychain on iOS,
// EncryptedSharedPreferences + Keystore on Android. The
// @aparajita/capacitor-secure-storage plugin does this.
//
// v1.1.4 ships the *adapter*: prodVetkd.ts can be switched from
// IndexedDB to SecureStorage by importing this module instead.
// v1.1.5 will integrate it into the prodVetkd.ts save/load path
// so the user's transport key lives in the device keystore on
// mobile and IndexedDB on web (the keys are interchangeable, so
// the same mnemonic / IBE works across both).
//
// On the web build, the plugin is a no-op (Capacitor is not
// available); we fall back to IndexedDB.

interface SecureStorageLike {
  getItem(opts: { key: string }): Promise<{ value: string } | null>;
  setItem(opts: { key: string; value: string }): Promise<void>;
  removeItem(opts: { key: string }): Promise<void>;
}

interface CapacitorLike {
  isNativePlatform(): boolean;
  SecureStoragePlugin: {
    getPlatform(): string;
  };
}

// In the browser, these globals don't exist; the adapter
// falls back to localStorage.
const w = globalThis as unknown as {
  Capacitor?: CapacitorLike;
  SecureStorage?: SecureStorageLike;
};

export function isMobileNative(): boolean {
  return !!(w.Capacitor && w.Capacitor.isNativePlatform());
}

const KEY_PREFIX = "iou:vetkd:";

export async function secureSet(key: string, value: string): Promise<void> {
  if (w.SecureStorage) {
    await w.SecureStorage.setItem({ key: KEY_PREFIX + key, value });
  } else {
    localStorage.setItem(KEY_PREFIX + key, value);
  }
}

export async function secureGet(key: string): Promise<string | null> {
  if (w.SecureStorage) {
    const out = await w.SecureStorage.getItem({ key: KEY_PREFIX + key });
    return out ? out.value : null;
  }
  return localStorage.getItem(KEY_PREFIX + key);
}

export async function secureDel(key: string): Promise<void> {
  if (w.SecureStorage) {
    await w.SecureStorage.removeItem({ key: KEY_PREFIX + key });
  } else {
    localStorage.removeItem(KEY_PREFIX + key);
  }
}
