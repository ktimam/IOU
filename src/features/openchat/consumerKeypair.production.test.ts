import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '@dfinity/agent';
import { Principal } from '@dfinity/principal';

type Remote = {
  wrapped_private_key: number[] | Uint8Array;
  public_key_pem: string;
};

const state = vi.hoisted(() => ({
  native: false,
  remotes: new Map<string, Remote>(),
  epochs: new Map<string, bigint>(),
  secure: new Map<string, string>(),
  setCalls: [] as string[],
  transportCalls: 0,
  setError: null as Error | null,
  setGate: null as Promise<void> | null,
  setStarted: vi.fn(),
  fingerprintCalls: 0,
  fingerprintGateAt: null as number | null,
  fingerprintGate: null as Promise<void> | null,
  fingerprintStarted: vi.fn(),
  secureSetError: null as Error | null,
  secureGet: vi.fn(),
  secureSet: vi.fn(),
  secureDel: vi.fn(),
  deleteGate: null as Promise<void> | null,
  deleteStarted: vi.fn(),
}));

vi.mock('./actionInboxCrypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('./actionInboxCrypto')>();
  return {
    ...original,
    fingerprintPublicKey: async (publicKey: CryptoKey) => {
      state.fingerprintCalls++;
      if (state.fingerprintGateAt === state.fingerprintCalls) {
        state.fingerprintStarted(state.fingerprintCalls);
        if (state.fingerprintGate) await state.fingerprintGate;
      }
      return original.fingerprintPublicKey(publicKey);
    },
  };
});

vi.mock('../../backend/declarations', () => ({
  createActor: (agent: { identity: Identity }) => {
    const principal = agent.identity.getPrincipal().toText();
    return {
      vetkd_public_key: async () => new Uint8Array(96),
      vetkd_wrap_consumer_key: async () => new Uint8Array([1, 2, 3]),
      get_consumer_keypair: async () => {
        const remote = state.remotes.get(principal);
        return {
          mutation_epoch: state.epochs.get(principal) ?? 0n,
          keypair: remote ? [remote] : [],
        };
      },
      set_consumer_keypair: async (expected: bigint, wrapped: number[], pem: string) => {
        state.setStarted(principal);
        if (state.setGate) await state.setGate;
        if (state.setError) throw state.setError;
        const current = state.epochs.get(principal) ?? 0n;
        if (expected !== current) {
          return {
            Err: { StaleEpoch: { expected_epoch: expected, current_epoch: current } },
          };
        }
        const next = current + 1n;
        state.remotes.set(principal, {
          wrapped_private_key: wrapped,
          public_key_pem: pem,
        });
        state.epochs.set(principal, next);
        state.setCalls.push(principal);
        return { Ok: next };
      },
      delete_consumer_keypair: async (expected: bigint) => {
        state.deleteStarted(principal);
        if (state.deleteGate) await state.deleteGate;
        const current = state.epochs.get(principal) ?? 0n;
        if (expected !== current) {
          return {
            Err: { StaleEpoch: { expected_epoch: expected, current_epoch: current } },
          };
        }
        const next = current + 1n;
        state.remotes.delete(principal);
        state.epochs.set(principal, next);
        return { Ok: next };
      },
    };
  },
}));

vi.mock('@dfinity/agent', async (importOriginal) => ({
  ...(await importOriginal()),
  HttpAgent: class {
    identity: Identity;

    constructor(options: { identity: Identity }) {
      this.identity = options.identity;
    }

    async fetchRootKey() {
      return new Uint8Array();
    }
  },
}));

vi.mock('../auth/config', () => ({
  host: 'https://icp-api.io',
  canisterId: 'test-iou-backend',
}));

vi.mock('../crypto/devVetkd', () => ({
  isProdVetkd: () => true,
  deriveUserKey: vi.fn(async () => {
    throw new Error('production must not use the dev wrap key');
  }),
}));

vi.mock('../crypto/prodVetkd', () => ({
  loadOrCreateTransportKey: async () => {
    state.transportCalls++;
    return {
      secretKey: new Uint8Array(32).fill(state.transportCalls),
      publicKey: new Uint8Array(48).fill(state.transportCalls + 1),
      publicKeyB64: 'transport-' + state.transportCalls,
    };
  },
  deriveConsumerWrapKeyProd: async (principal: string) => {
    const key = new Uint8Array(32);
    const bytes = new TextEncoder().encode(principal);
    for (let i = 0; i < bytes.length; i++) key[i % key.length] ^= bytes[i];
    return key;
  },
}));

vi.mock('../crypto/mobileSecureStorage', () => ({
  isMobileNative: () => state.native,
  secureGet: state.secureGet,
  secureSet: state.secureSet,
  secureDel: state.secureDel,
}));

const local = new Map<string, string>();
const localSet = vi.fn((key: string, value: string) => {
  local.set(key, value);
});
const localRemove = vi.fn((key: string) => {
  local.delete(key);
});

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: localSet,
    removeItem: localRemove,
    clear: () => local.clear(),
    key: (index: number) => [...local.keys()][index] ?? null,
    get length() {
      return local.size;
    },
  } as Storage,
});

const identity = {
  getPrincipal: () => Principal.fromText('aaaaa-aa'),
} as unknown as Identity;
const otherIdentity = {
  getPrincipal: () => Principal.fromText('rrkah-fqaaa-aaaaa-aaaaq-cai'),
} as unknown as Identity;

async function freshModule() {
  vi.resetModules();
  return import('./consumerKeypair');
}

async function makeLegacyStored(): Promise<{
  raw: string;
  pem: string;
}> {
  const kp = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
  let binary = '';
  for (const byte of spki) binary += String.fromCharCode(byte);
  const publicKeySpkiB64 = btoa(binary);
  const body = publicKeySpkiB64.match(/.{1,64}/g)?.join('\n') ?? publicKeySpkiB64;
  return {
    raw: JSON.stringify({ privateKeyJwk, publicKeySpkiB64 }),
    pem: '-----BEGIN PUBLIC KEY-----\n' + body + '\n-----END PUBLIC KEY-----\n',
  };
}

beforeEach(() => {
  local.clear();
  localSet.mockClear();
  localRemove.mockClear();
  state.native = false;
  state.remotes.clear();
  state.epochs.clear();
  state.secure.clear();
  state.setCalls = [];
  state.transportCalls = 0;
  state.setError = null;
  state.setGate = null;
  state.setStarted.mockReset();
  state.fingerprintCalls = 0;
  state.fingerprintGateAt = null;
  state.fingerprintGate = null;
  state.fingerprintStarted.mockReset();
  state.secureSetError = null;
  state.secureGet.mockReset();
  state.secureSet.mockReset();
  state.secureDel.mockReset();
  state.deleteGate = null;
  state.deleteStarted.mockReset();
  state.secureGet.mockImplementation(async (key: string) => state.secure.get(key) ?? null);
  state.secureSet.mockImplementation(async (key: string, value: string) => {
    if (state.secureSetError) throw state.secureSetError;
    state.secure.set(key, value);
  });
  state.secureDel.mockImplementation(async (key: string) => {
    state.secure.delete(key);
  });
});

describe('production consumer key storage', () => {
  it('uses memory plus the encrypted canister copy on web, never localStorage', async () => {
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);

    const first = await mod.loadOrCreateConsumerKeypair();
    const second = await mod.loadOrCreateConsumerKeypair();
    const storageKey = mod.__testing.storageKeyForPrincipal(
      identity.getPrincipal().toText(),
    );

    expect(second.publicKeySpkiPem).toBe(first.publicKeySpkiPem);
    expect(state.remotes.get(identity.getPrincipal().toText())?.public_key_pem)
      .toBe(first.publicKeySpkiPem);
    expect(local.has(storageKey)).toBe(false);
    expect(localSet).not.toHaveBeenCalled();
    expect(state.secureSet).not.toHaveBeenCalled();
  });

  it('recovers the same web key from the canister in a new module session', async () => {
    const firstModule = await freshModule();
    firstModule.configureConsumerKeypairBackend(identity);
    const first = await firstModule.loadOrCreateConsumerKeypair();

    const secondModule = await freshModule();
    secondModule.configureConsumerKeypairBackend(identity);
    const second = await secondModule.loadOrCreateConsumerKeypair();

    expect(second.publicKeySpkiPem).toBe(first.publicKeySpkiPem);
    expect(state.setCalls).toHaveLength(1);
    expect(state.transportCalls).toBe(2);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('keeps production account switches isolated and recovers each account', async () => {
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);
    const first = await mod.loadOrCreateConsumerKeypair();

    mod.configureConsumerKeypairBackend(otherIdentity);
    const second = await mod.loadOrCreateConsumerKeypair();
    expect(second.publicKeySpkiPem).not.toBe(first.publicKeySpkiPem);

    mod.configureConsumerKeypairBackend(identity);
    const recovered = await mod.loadOrCreateConsumerKeypair();
    expect(recovered.publicKeySpkiPem).toBe(first.publicKeySpkiPem);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('fails closed when production has no authenticated identity', async () => {
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(null);

    await expect(mod.loadOrCreateConsumerKeypair()).rejects.toThrow(
      /authenticated identity.*production/i,
    );
    expect(localSet).not.toHaveBeenCalled();
    expect(state.remotes.size).toBe(0);
  });

  it('migrates a legacy web JWK only after its wrapped canister copy succeeds', async () => {
    const mod = await freshModule();
    const principal = identity.getPrincipal().toText();
    const storageKey = mod.__testing.storageKeyForPrincipal(principal);
    const legacy = await makeLegacyStored();
    local.set(storageKey, legacy.raw);
    state.setError = new Error('canister unavailable');
    mod.configureConsumerKeypairBackend(identity);

    await expect(mod.loadOrCreateConsumerKeypair()).rejects.toThrow(
      /canister unavailable/i,
    );
    expect(local.get(storageKey)).toBe(legacy.raw);

    state.setError = null;
    const migrated = await mod.loadOrCreateConsumerKeypair();
    expect(migrated.publicKeySpkiPem).toBe(legacy.pem);
    expect(state.remotes.get(principal)?.public_key_pem).toBe(legacy.pem);
    expect(local.has(storageKey)).toBe(false);
  });

  it('purges a stale legacy web JWK after the remote copy is recovered', async () => {
    const firstModule = await freshModule();
    firstModule.configureConsumerKeypairBackend(identity);
    const remote = await firstModule.loadOrCreateConsumerKeypair();

    const secondModule = await freshModule();
    const principal = identity.getPrincipal().toText();
    const storageKey = secondModule.__testing.storageKeyForPrincipal(principal);
    local.set(storageKey, (await makeLegacyStored()).raw);
    secondModule.configureConsumerKeypairBackend(identity);
    const recovered = await secondModule.loadOrCreateConsumerKeypair();

    expect(recovered.publicKeySpkiPem).toBe(remote.publicKeySpkiPem);
    expect(local.has(storageKey)).toBe(false);
    expect(state.setCalls).toHaveLength(1);
  });

  it('fails closed without replacing a corrupt remote production key', async () => {
    const firstModule = await freshModule();
    const principal = identity.getPrincipal().toText();
    firstModule.configureConsumerKeypairBackend(identity);
    await firstModule.loadOrCreateConsumerKeypair();
    const remote = state.remotes.get(principal)!;
    state.remotes.set(principal, {
      ...remote,
      wrapped_private_key: new Uint8Array(40),
    });

    const secondModule = await freshModule();
    secondModule.configureConsumerKeypairBackend(identity);

    await expect(secondModule.loadOrCreateConsumerKeypair()).rejects.toThrow(
      /could not recover.*not replaced/i,
    );
    expect(state.setCalls).toHaveLength(1);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('fails closed when the remote public key does not match its wrapped private key', async () => {
    const firstModule = await freshModule();
    const principal = identity.getPrincipal().toText();
    firstModule.configureConsumerKeypairBackend(identity);
    await firstModule.loadOrCreateConsumerKeypair();
    const remote = state.remotes.get(principal)!;
    state.remotes.set(principal, {
      ...remote,
      public_key_pem: '-----BEGIN PUBLIC KEY-----\nwrong\n-----END PUBLIC KEY-----\n',
    });

    const secondModule = await freshModule();
    secondModule.configureConsumerKeypairBackend(identity);

    await expect(secondModule.loadOrCreateConsumerKeypair()).rejects.toThrow(
      /could not recover.*not replaced/i,
    );
    expect(state.setCalls).toHaveLength(1);
  });

  it('uses native secure storage in production and never falls back to localStorage', async () => {
    state.native = true;
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);

    const pair = await mod.loadOrCreateConsumerKeypair();
    const legacyKey = mod.__testing.storageKeyForPrincipal(
      identity.getPrincipal().toText(),
    );

    expect(pair.privateKey).toBeDefined();
    expect(state.secureSet).toHaveBeenCalledTimes(1);
    expect(state.secure.size).toBe(1);
    expect(local.has(legacyKey)).toBe(false);
    expect(localSet).not.toHaveBeenCalled();
  });

  it('blocks a concurrent load while disconnect deletes the old private key', async () => {
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);
    const old = await mod.loadOrCreateConsumerKeypair();
    let releaseDelete!: () => void;
    state.deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const clearing = mod.clearConsumerKeypair(
      mod.captureConsumerKeypairSession(identity.getPrincipal().toText()),
    );
    await Promise.resolve();
    const concurrent = await mod.loadOrCreateConsumerKeypair().then(
      () => 'resolved',
      (cause: Error) => cause.message,
    );
    releaseDelete();
    await clearing;

    expect(concurrent).toMatch(/being cleared/i);
    const replacement = await mod.loadOrCreateConsumerKeypair();
    expect(replacement.publicKeySpkiPem).not.toBe(old.publicKeySpkiPem);
    expect(state.epochs.get(identity.getPrincipal().toText())).toBe(3n);
  });

  it('waits for an already-issued upload before deleting the remote key', async () => {
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);
    let releaseSet!: () => void;
    state.setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });

    const loading = mod.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(1));
    const clearing = mod.clearConsumerKeypair(
      mod.captureConsumerKeypairSession(identity.getPrincipal().toText()),
    );
    await Promise.resolve();
    releaseSet();
    const [loadResult, clearResult] = await Promise.allSettled([loading, clearing]);

    expect(loadResult.status).toBe('rejected');
    expect(clearResult.status).toBe('fulfilled');
    expect(state.remotes.has(identity.getPrincipal().toText())).toBe(false);
  });

  it('rejects a pre-delete upload delayed in another browser process', async () => {
    const principal = identity.getPrincipal().toText();
    const oldBrowser = await freshModule();
    oldBrowser.configureConsumerKeypairBackend(identity);
    let releaseOldUpload!: () => void;
    state.setGate = new Promise<void>((resolve) => {
      releaseOldUpload = resolve;
    });

    const staleUpload = oldBrowser.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(1));

    // A separately loaded module has no access to oldBrowser's in-memory
    // active-sync registry. The stable canister epoch is the only shared lock.
    const disconnectingBrowser = await freshModule();
    disconnectingBrowser.configureConsumerKeypairBackend(identity);
    await disconnectingBrowser.clearConsumerKeypair(
      disconnectingBrowser.captureConsumerKeypairSession(principal),
    );
    expect(state.epochs.get(principal)).toBe(1n);

    releaseOldUpload();
    await expect(staleUpload).rejects.toThrow(/changed on another device.*epoch/i);
    expect(state.remotes.has(principal)).toBe(false);
    expect(state.epochs.get(principal)).toBe(1n);
    expect(state.setCalls).toHaveLength(0);
  });

  it('allows only one of two devices that observed the same epoch to set', async () => {
    const principal = identity.getPrincipal().toText();
    let releaseUploads!: () => void;
    state.setGate = new Promise<void>((resolve) => {
      releaseUploads = resolve;
    });
    const firstDevice = await freshModule();
    firstDevice.configureConsumerKeypairBackend(identity);
    const first = firstDevice.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(1));

    const secondDevice = await freshModule();
    secondDevice.configureConsumerKeypairBackend(identity);
    const second = secondDevice.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(2));
    releaseUploads();

    const outcomes = await Promise.allSettled([first, second]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(state.setCalls).toHaveLength(1);
    expect(state.epochs.get(principal)).toBe(1n);
    expect(state.remotes.has(principal)).toBe(true);
  });

  it('re-reads and deletes a newer device mutation after an epoch conflict', async () => {
    const principal = identity.getPrincipal().toText();
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);
    await mod.loadOrCreateConsumerKeypair();
    const replacement = { ...state.remotes.get(principal)! };
    let releaseFirstDelete!: () => void;
    state.deleteGate = new Promise<void>((resolve) => {
      releaseFirstDelete = resolve;
    });

    const clearing = mod.clearConsumerKeypair(
      mod.captureConsumerKeypairSession(principal),
    );
    await vi.waitFor(() => expect(state.deleteStarted).toHaveBeenCalledTimes(1));

    // Model a second device's accepted set after this delete queried epoch 1.
    state.epochs.set(principal, 2n);
    state.remotes.set(principal, replacement);
    releaseFirstDelete();
    await clearing;

    expect(state.deleteStarted).toHaveBeenCalledTimes(2);
    expect(state.epochs.get(principal)).toBe(3n);
    expect(state.remotes.has(principal)).toBe(false);
  });

  it('waits for an upload orphaned by same-principal session reconfiguration', async () => {
    const mod = await freshModule();
    const principal = identity.getPrincipal().toText();
    mod.configureConsumerKeypairBackend(identity);
    let releaseSet!: () => void;
    state.setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });

    const orphanedLoad = mod.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(1));
    mod.configureConsumerKeypairBackend(identity);
    const currentSession = mod.captureConsumerKeypairSession(principal);
    const clearing = mod.clearConsumerKeypair(currentSession);
    releaseSet();
    const [loadResult, clearResult] = await Promise.allSettled([orphanedLoad, clearing]);

    expect(loadResult.status).toBe('rejected');
    expect(clearResult.status).toBe('fulfilled');
    expect(state.remotes.has(principal)).toBe(false);
  });

  it('waits for every upload orphaned by repeated same-principal reconfiguration', async () => {
    const mod = await freshModule();
    const principal = identity.getPrincipal().toText();
    mod.configureConsumerKeypairBackend(identity);
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    state.setGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstLoad = mod.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(1));

    mod.configureConsumerKeypairBackend(identity);
    state.setGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondLoad = mod.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(2));

    const clearing = mod.clearConsumerKeypair(
      mod.captureConsumerKeypairSession(principal),
    );
    releaseSecond();
    await Promise.resolve();
    expect(state.deleteStarted).not.toHaveBeenCalled();
    releaseFirst();
    const results = await Promise.allSettled([firstLoad, secondLoad, clearing]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
    expect(results[2].status).toBe('fulfilled');
    expect(state.deleteStarted).toHaveBeenCalledTimes(1);
    expect(state.remotes.has(principal)).toBe(false);
  });

  it('refuses a stale disconnect ticket after the account changes', async () => {
    const mod = await freshModule();
    const firstPrincipal = identity.getPrincipal().toText();
    const secondPrincipal = otherIdentity.getPrincipal().toText();
    mod.configureConsumerKeypairBackend(identity);
    await mod.loadOrCreateConsumerKeypair();
    const firstSession = mod.captureConsumerKeypairSession(firstPrincipal);
    mod.configureConsumerKeypairBackend(otherIdentity);
    await mod.loadOrCreateConsumerKeypair();

    await expect(mod.clearConsumerKeypair(firstSession)).rejects.toThrow(
      /authentication changed/i,
    );

    expect(state.remotes.has(firstPrincipal)).toBe(true);
    expect(state.remotes.has(secondPrincipal)).toBe(true);
  });

  it('refuses an ABA stale ticket even after the original principal signs in again', async () => {
    const mod = await freshModule();
    const firstPrincipal = identity.getPrincipal().toText();
    mod.configureConsumerKeypairBackend(identity);
    await mod.loadOrCreateConsumerKeypair();
    const staleSession = mod.captureConsumerKeypairSession(firstPrincipal);
    mod.configureConsumerKeypairBackend(otherIdentity);
    await mod.loadOrCreateConsumerKeypair();
    mod.configureConsumerKeypairBackend(identity);
    const current = await mod.loadOrCreateConsumerKeypair();

    await expect(mod.clearConsumerKeypair(staleSession)).rejects.toThrow(
      /authentication changed/i,
    );
    expect(state.remotes.get(firstPrincipal)?.public_key_pem).toBe(
      current.publicKeySpkiPem,
    );
  });

  it('never deletes the new account when auth changes during an in-progress disconnect', async () => {
    const mod = await freshModule();
    const firstPrincipal = identity.getPrincipal().toText();
    const secondPrincipal = otherIdentity.getPrincipal().toText();
    mod.configureConsumerKeypairBackend(identity);
    await mod.loadOrCreateConsumerKeypair();
    const firstSession = mod.captureConsumerKeypairSession(firstPrincipal);
    let releaseDelete!: () => void;
    state.deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });

    const clearing = mod.clearConsumerKeypair(firstSession);
    await vi.waitFor(() => expect(state.deleteStarted).toHaveBeenCalledWith(firstPrincipal));
    mod.configureConsumerKeypairBackend(otherIdentity);
    await mod.loadOrCreateConsumerKeypair();
    releaseDelete();

    await expect(clearing).resolves.toMatchObject({
      principal: firstPrincipal,
      sessionStillCurrent: false,
    });
    expect(state.remotes.has(firstPrincipal)).toBe(false);
    expect(state.remotes.has(secondPrincipal)).toBe(true);
    expect(state.deleteStarted).not.toHaveBeenCalledWith(secondPrincipal);
  });

  it('rejects a consumer-key result when the account changes during upload completion', async () => {
    const mod = await freshModule();
    mod.configureConsumerKeypairBackend(identity);
    let releaseSet!: () => void;
    state.setGate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });

    const loading = mod.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.setStarted).toHaveBeenCalledTimes(1));
    mod.configureConsumerKeypairBackend(otherIdentity);
    releaseSet();

    await expect(loading).rejects.toThrow(/authentication changed/i);
  });

  it('refuses to return a public key under a ticket from a previous account session', async () => {
    const mod = await freshModule();
    const firstPrincipal = identity.getPrincipal().toText();
    mod.configureConsumerKeypairBackend(identity);
    await mod.loadOrCreateConsumerKeypair();
    const firstSession = mod.captureConsumerKeypairSession(firstPrincipal);
    mod.configureConsumerKeypairBackend(otherIdentity);

    await expect(mod.consumerPublicKeyPem(firstSession)).rejects.toThrow(
      /authentication changed/i,
    );
  });

  it('rejects a keypair when auth changes during the final key import', async () => {
    const firstModule = await freshModule();
    firstModule.configureConsumerKeypairBackend(identity);
    await firstModule.loadOrCreateConsumerKeypair();

    const secondModule = await freshModule();
    secondModule.configureConsumerKeypairBackend(identity);
    state.fingerprintCalls = 0;
    state.fingerprintGateAt = 2;
    let releaseFingerprint!: () => void;
    state.fingerprintGate = new Promise<void>((resolve) => {
      releaseFingerprint = resolve;
    });

    const loading = secondModule.loadOrCreateConsumerKeypair();
    await vi.waitFor(() => expect(state.fingerprintStarted).toHaveBeenCalledWith(2));
    secondModule.configureConsumerKeypairBackend(otherIdentity);
    releaseFingerprint();

    await expect(loading).rejects.toThrow(/authentication changed/i);
  });

  it('retains a legacy native JWK when secure migration fails, then purges it after retry', async () => {
    state.native = true;
    const mod = await freshModule();
    const principal = identity.getPrincipal().toText();
    const legacyKey = mod.__testing.storageKeyForPrincipal(principal);
    const legacy = await makeLegacyStored();
    local.set(legacyKey, legacy.raw);
    state.secureSetError = new Error('keystore locked');
    mod.configureConsumerKeypairBackend(identity);

    await expect(mod.loadOrCreateConsumerKeypair()).rejects.toThrow(
      /keystore locked/i,
    );
    expect(local.get(legacyKey)).toBe(legacy.raw);
    expect(state.remotes.get(principal)?.public_key_pem).toBe(legacy.pem);

    state.secureSetError = null;
    const recovered = await mod.loadOrCreateConsumerKeypair();
    expect(recovered.publicKeySpkiPem).toBe(legacy.pem);
    expect(local.has(legacyKey)).toBe(false);
    expect(state.secure.size).toBe(1);
  });
});
