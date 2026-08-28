import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  resolveOpenChatFrontend,
  resolveOpenChatViteFsModule,
} from '../../scripts/live/openChatFrontendDependency';

const temporaryRoots: string[] = [];

function createFrontend(): string {
  const root = mkdtempSync(join(tmpdir(), 'iou-openchat-frontend-'));
  temporaryRoots.push(root);
  const frontend = join(root, 'frontend');
  mkdirSync(frontend);
  writeFileSync(join(frontend, 'package.json'), '{}');
  return frontend;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('explicit OpenChat frontend dependencies', () => {
  it('requires an absolute CLI or environment frontend', () => {
    expect(() => resolveOpenChatFrontend([], {})).toThrow(
      '--openchat-frontend or OC_LIVE_OPENCHAT_FRONTEND is required',
    );
    expect(() =>
      resolveOpenChatFrontend(['--openchat-frontend', 'relative/frontend'], {}),
    ).toThrow('must be an exact absolute path');

    const frontend = createFrontend();
    expect(
      resolveOpenChatFrontend([], { OC_LIVE_OPENCHAT_FRONTEND: frontend }),
    ).toBe(frontend);
    expect(
      resolveOpenChatFrontend(['--openchat-frontend', frontend], {}),
    ).toBe(frontend);
  });

  it('resolves an existing browser module inside that frontend', () => {
    const frontend = createFrontend();
    const modulePath = join(frontend, 'node_modules', 'example', 'browser.js');
    mkdirSync(join(frontend, 'node_modules', 'example'), { recursive: true });
    writeFileSync(modulePath, 'export const ready = true;');

    expect(
      resolveOpenChatViteFsModule(
        'node_modules/example/browser.js',
        ['--openchat-frontend', frontend],
        {},
      ),
    ).toBe(`/@fs/${modulePath.replaceAll('\\', '/')}`);
  });

  it('rejects a missing module and traversal outside the frontend', () => {
    const frontend = createFrontend();
    const outside = join(frontend, '..', 'outside.js');
    writeFileSync(outside, 'export {};');

    expect(() =>
      resolveOpenChatViteFsModule(
        'node_modules/example/missing.js',
        ['--openchat-frontend', frontend],
        {},
      ),
    ).toThrow('does not exist');
    expect(() =>
      resolveOpenChatViteFsModule(
        '../outside.js',
        ['--openchat-frontend', frontend],
        {},
      ),
    ).toThrow('outside the configured frontend');
  });
});
