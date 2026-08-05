import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('repository security policy', () => {
  it('ignores every in-repository Playwright browser-profile directory', () => {
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/^\.pw-profiles\/$/m);
    expect(ignore).toMatch(/^\.pw-profiles-scenarios\/$/m);
  });

  it('ignores generated local OpenChat co-deployment state', () => {
    const ignore = read('.gitignore');
    expect(ignore).toMatch(/^\.openchat-iou\/$/m);
    expect(ignore).toMatch(/^\.openchat-inbox\/$/m);
    expect(ignore).toMatch(/^\.openchat-registrar\.json$/m);
  });

  it('has no stale shadow copy of the IOU Candid declarations', () => {
    const shadow = path.join(root, 'src/declarations/iou_backend');
    expect(existsSync(shadow) ? readdirSync(shadow) : []).toEqual([]);
    expect(existsSync(path.join(root, 'src/iou_backend.did'))).toBe(true);
    expect(existsSync(path.join(root, 'src/backend/declarations.ts'))).toBe(
      true,
    );
  });

  it('does not publish frontend source maps in the production bundle', () => {
    const config = read('vite.config.ts');
    expect(config).toMatch(/sourcemap:\s*false/);
    expect(config).not.toMatch(/sourcemap:\s*true/);
  });

  it('excludes Android application data from platform backup', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/android:allowBackup=\x22false\x22/);
    expect(manifest).not.toMatch(/android:allowBackup=\x22true\x22/);
  });

  it('fails Android release tasks closed when signing material is absent', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/releaseRequested/);
    expect(gradle).toMatch(
      /releaseRequested[\s\S]*?!hasKeystore[\s\S]*?throw new GradleException/,
    );
  });

  it('synchronizes current web assets before every Android debug build', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
    expect(pkg.scripts?.['android:build:debug']).toMatch(/cap:sync/);
  });

  it('enforces coverage and dependency-audit gates in CI', () => {
    const config = read('vitest.config.ts');
    const workflow = read('.github/workflows/ci.yml');
    expect(config).toMatch(/thresholds:/);
    expect(config).toMatch(/statements:\s*70/);
    expect(config).toMatch(/branches:\s*80/);
    expect(workflow).toContain('pnpm test:coverage');
    expect(workflow).toContain('pnpm audit:deps');
    expect(workflow).toContain('cargo audit');
  });

  it('rechecks sheet membership after the asynchronous vetKD derivation', () => {
    const backend = read('src/lib.rs');
    const endpoint = backend.match(
      /async fn vetkd_wrap_sheet_key[\s\S]*?\n}\n\n\/\/\/ vetkd_wrap_consumer_key/,
    )?.[0];
    expect(endpoint).toBeDefined();
    expect(endpoint).toMatch(
      /vetkd_derive_key\(&request\)[\s\S]*?\.await[\s\S]*?if !caller_owns_sheet\(&sheet_id\)/,
    );
  });
});
