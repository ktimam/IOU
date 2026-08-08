import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { win32 } from 'node:path';

type CdpPorts = Readonly<{
  fatherOpenChat: number;
  fatherIou: number;
  manager: number;
  mother: number;
  child: number;
}>;

const parsed = JSON.parse(
  readFileSync(new URL('./cdp-ports.json', import.meta.url), 'utf8'),
) as Record<keyof CdpPorts, unknown>;

function configuredPort(name: keyof CdpPorts): number {
  const value = parsed[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`Invalid local CDP port for ${name}`);
  }
  return Number(value);
}

export const CDP_PORTS: CdpPorts = Object.freeze({
  fatherOpenChat: configuredPort('fatherOpenChat'),
  fatherIou: configuredPort('fatherIou'),
  manager: configuredPort('manager'),
  mother: configuredPort('mother'),
  child: configuredPort('child'),
});

export type CdpProcessSnapshot = Readonly<{
  processId: number;
  executablePath: string;
  commandLine: string;
}>;

type ExpectedChromeCdpOwner = Readonly<{
  executablePath: string;
  profilePath: string;
  port: number;
}>;

function normalizedWindowsPath(value: string): string {
  return win32.normalize(value.trim()).replace(/[\\/]+$/, '').toLocaleLowerCase('en-US');
}

function exactSwitchValues(commandLine: string, name: string): string[] {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\s)--${escapedName}(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s]+))(?=\\s|$)`,
    'gi',
  );
  const values: string[] = [];
  for (const match of commandLine.matchAll(pattern)) {
    values.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return values;
}

/** Exact process ownership policy used before a live harness connects to or terminates Chrome. */
export function matchesExactCdpChromeProcess(
  process: CdpProcessSnapshot,
  expected: ExpectedChromeCdpOwner,
): boolean {
  if (
    !Number.isSafeInteger(process.processId) ||
    process.processId <= 0 ||
    !Number.isSafeInteger(expected.port) ||
    expected.port < 1 ||
    expected.port > 65_535 ||
    normalizedWindowsPath(process.executablePath) !== normalizedWindowsPath(expected.executablePath)
  ) {
    return false;
  }
  const profiles = exactSwitchValues(process.commandLine, 'user-data-dir');
  const ports = exactSwitchValues(process.commandLine, 'remote-debugging-port');
  const addresses = exactSwitchValues(process.commandLine, 'remote-debugging-address');
  return (
    profiles.length === 1 &&
    normalizedWindowsPath(profiles[0]) === normalizedWindowsPath(expected.profilePath) &&
    ports.length === 1 &&
    ports[0] === String(expected.port) &&
    addresses.length <= 1 &&
    (addresses.length === 0 || addresses[0] === '127.0.0.1')
  );
}

export type LoopbackProbeServer = {
  once(event: 'error', listener: (error: Error) => void): unknown;
  listen(port: number, host: string, listener: () => void): unknown;
  close(listener: (error?: Error) => void): unknown;
};

type LoopbackProbeServerFactory = () => LoopbackProbeServer;

const defaultServerFactory: LoopbackProbeServerFactory = () => createServer();

export function canBindLoopbackPort(
  port: number,
  timeoutMs = 2_000,
  createProbeServer: LoopbackProbeServerFactory = defaultServerFactory,
): Promise<boolean> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve(false);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const server = createProbeServer();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (available: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(available);
    };
    timer = setTimeout(() => {
      try {
        server.close(() => undefined);
      } catch {
        // A stalled fake or half-open native server may already be non-listening.
      }
      finish(false);
    }, timeoutMs);

    server.once('error', () => finish(false));
    try {
      server.listen(port, '127.0.0.1', () => {
        server.close((error) => finish(error === undefined));
      });
    } catch {
      finish(false);
    }
  });
}

export async function assertLoopbackPortAvailable(port: number): Promise<void> {
  if (!(await canBindLoopbackPort(port))) {
    throw new Error(
      `CDP port ${port} is occupied or reserved by Windows; choose a free port before launching Chrome`,
    );
  }
}
