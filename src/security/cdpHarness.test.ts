import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  CDP_PORTS,
  canBindLoopbackPort,
  matchesExactCdpChromeProcess,
} from '../../scripts/live/cdpPorts';

describe('local browser CDP harness', () => {
  it('keeps durable profile ports out of the Windows dynamic range used by this environment', () => {
    const ports = Object.values(CDP_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports.every((port) => port > 15_000 && port < 49_152)).toBe(true);
    expect(ports).toEqual([19_222, 19_231, 19_241, 19_242, 19_243]);
  });

  it('detects an unavailable loopback port before Chrome silently falls back', async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen(0, '127.0.0.1', resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');

    await expect(canBindLoopbackPort(address.port)).resolves.toBe(false);
    await new Promise<void>((resolve, reject) =>
      occupied.close((error) => (error ? reject(error) : resolve())),
    );
    await expect(canBindLoopbackPort(address.port)).resolves.toBe(true);
  });

  it('fails a stalled bind probe within its configured deadline', async () => {
    let closeCalls = 0;
    const stalledServer = {
      once: () => stalledServer,
      listen: () => stalledServer,
      close: (callback: (error?: Error) => void) => {
        closeCalls++;
        callback();
        return stalledServer;
      },
    };

    const started = Date.now();
    await expect(
      canBindLoopbackPort(19_299, 25, () => stalledServer),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(closeCalls).toBe(1);
  });

  it('handles an immediate bind error from an injected probe', async () => {
    const eagerFailure = {
      once: (_event: 'error', listener: (error: Error) => void) => {
        listener(new Error('reserved'));
        return eagerFailure;
      },
      listen: () => eagerFailure,
      close: (callback: (error?: Error) => void) => {
        callback();
        return eagerFailure;
      },
    };

    await expect(
      canBindLoopbackPort(19_299, 25, () => eagerFailure),
    ).resolves.toBe(false);
  });

  it('matches only the exact Chrome executable, profile, port, and loopback binding', () => {
    const expected = {
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      profilePath: 'C:\\Kiko\\oc-live\\profiles\\manager',
      port: CDP_PORTS.manager,
    };
    const exact = {
      processId: 101,
      executablePath: expected.executablePath,
      commandLine:
        '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --user-data-dir="C:\\Kiko\\oc-live\\profiles\\manager" --remote-debugging-port=19241 --remote-debugging-address=127.0.0.1',
    };

    expect(matchesExactCdpChromeProcess(exact, expected)).toBe(true);
    expect(
      matchesExactCdpChromeProcess(
        { ...exact, commandLine: exact.commandLine.replace('manager"', 'manager-old"') },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesExactCdpChromeProcess(
        { ...exact, commandLine: exact.commandLine.replace('port=19241', 'port=119241') },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesExactCdpChromeProcess(
        { ...exact, commandLine: exact.commandLine.replace('127.0.0.1', '0.0.0.0') },
        expected,
      ),
    ).toBe(false);
    expect(
      matchesExactCdpChromeProcess(
        { ...exact, executablePath: 'C:\\Temp\\chrome.exe' },
        expected,
      ),
    ).toBe(false);
  });
});
