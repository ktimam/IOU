import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (relative: string): string => readFileSync(path.join(root, relative), 'utf8');

describe('repository security policy', () => {
  it('keeps local publication artifacts out of the repository root', () => {
    const ignore = read('.gitignore').split(/\r?\n/);
    for (const entry of [
      '/output/',
      '/.playwright-cli/',
      '/.pnpm-store/',
      '/.codex-openchat-vite.environment.sha256',
    ]) {
      expect(ignore, `missing root-scoped local artifact exclusion: ${entry}`).toContain(entry);
    }
  });

  it('uses portable evidence references in the boundary review and live guide', () => {
    for (const relative of [
      'docs/openchat-app-boundary-review.md',
      'scripts/live/README.md',
    ]) {
      const source = read(relative);
      expect(source.includes('<project-temp>'), `${relative}: portable evidence root`).toBe(true);
      const absolutePaths = [...source.matchAll(/\b[A-Za-z]:[\\/]+([^\\/\s"'`]+)/g)];
      expect(absolutePaths.every(([, directory]) => directory.toLowerCase() === 'path'),
        `${relative}: only neutral path/to placeholders are allowed`).toBe(true);
      expect(/\b[a-z0-9-]+\.tail[a-z0-9]+\.ts\.net\b/i.test(source), `${relative}: private tailnet host`).toBe(false);
    }
  });

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

  it('keeps the deployed Candid surface in parity with per-chat token redemption', () => {
    const candid = read('src/iou_backend.did');
    const declarations = read('src/backend/declarations.ts');
    const backend = read('src/lib.rs');
    expect(candid).toMatch(
      /type ClaimOpenChatChatRouteResult = variant \{[\s\S]*?Success : ClaimOpenChatChatRouteSuccess;[\s\S]*?WrongAccount;[\s\S]*?BindingChanged;[\s\S]*?RemoteError;[\s\S]*?\};/,
    );
    expect(candid).toMatch(
      /claim_openchat_chat_route\s*:\s*\(text\)\s*->\s*\(ClaimOpenChatChatRouteResult\)/,
    );
    expect(declarations).toContain('claim_openchat_chat_route');
    expect(backend).toMatch(
      /#\[ic_cdk::update\]\s*async fn claim_openchat_chat_route\s*\(\s*encoded_token: String/,
    );
  });

  it('has one user default currency and no deployment-wide chat-card default', () => {
    const candid = read('src/iou_backend.did');
    const declarations = read('src/backend/declarations.ts');
    const backend = read('src/lib.rs');
    for (const source of [candid, declarations]) {
      expect(source).not.toContain('set_card_currency');
      expect(source).not.toContain('card_currency');
    }
    expect(backend).not.toContain('set_card_currency');
    expect(backend).not.toMatch(/pub struct Config \{[\s\S]*?pub card_currency:/);
    expect(backend).toContain('config_ignores_the_removed_deployment_card_currency');
    expect(candid).toMatch(
      /type OpenChatCardContext = record \{[\s\S]*?default_currency : opt text;/,
    );
    expect(declarations).toMatch(
      /const OpenChatCardContext = idl\.Record\(\{[\s\S]*?default_currency: idl\.Opt\(idl\.Text\)/,
    );
    expect(backend).toMatch(
      /pub struct OpenChatCardContext \{[\s\S]*?pub default_currency: Option<String>/,
    );
  });

  it('does not publish frontend source maps in the production bundle', () => {
    const config = read('vite.config.ts');
    expect(config).toMatch(/sourcemap:\s*false/);
    expect(config).not.toMatch(/sourcemap:\s*true/);
  });

  it('keeps Vite from watching generated state and persistent browser profiles', () => {
    const config = read('vite.config.ts');
    for (const ignoredPath of [
      'target',
      '.dfx',
      '.openchat-iou',
      '.openchat-inbox',
      '.pw-profiles',
      '.pw-profiles-scenarios',
      'coverage',
      'playwright-report',
      'android',
      'ii',
    ]) {
      expect(config, `missing Vite watcher exclusion for ${ignoredPath}`).toContain(
        `**/${ignoredPath}/**`,
      );
    }
    expect(config).toMatch(/watch:\s*\{[\s\S]*?ignored:/);
    expect(config).toMatch(/strictPort:\s*true/);
    expect(config).not.toMatch(/usePolling:\s*true/);
  });

  it('derives the exact mobile-QC host from validated local configuration without a wildcard', () => {
    const config = read('vite.config.ts');
    expect(config).toContain('allowedHosts: openChatDevAllowedHosts');
    expect(config).not.toContain('allowedHosts: true');
    expect(config).not.toMatch(/allowedHosts:\s*\[[^\]]*\.ts\.net/);
  });

  it('requires live emulator callers to pass their OpenChat origin', () => {
    const harness = read('scripts/live/emulator-image-regression.ts');
    expect(harness).toContain('new URL(oneArg("origin")).origin');
    expect(harness).not.toMatch(/oneArg\("origin",\s*"https:\/\//);
  });

  it('repairs only the configured OpenChat desktop executable', () => {
    const healer = read('scripts/live/heal-cdp.ts');
    expect(healer).not.toContain('Get-Process open-chat');
    expect(healer).toContain('Get-CimInstance Win32_Process');
    expect(healer).toContain('ExecutablePath');
    expect(healer).toContain('Stop-Process -Id');
    expect(healer).toContain('matchesExactCdpChromeProcess');
    expect(healer).toContain('--remote-debugging-address=127.0.0.1');
    expect(healer).toContain('OC_LIVE_CHROME_EXECUTABLE');
    expect(healer).toContain('OC_LIVE_PROFILE_ROOT');
    expect(healer).toContain('OC_LIVE_DESKTOP_EXECUTABLE');
    expect(healer).not.toMatch(/[A-Za-z]:\\Users\\[^'"\s]+/);
    expect(healer).not.toMatch(/[A-Za-z]:\\[^'"\r\n]*\\MyProjects\\/i);
    expect(healer).not.toMatch(/CommandLine\s+-match[\s\S]*?-or[\s\S]*?remote-debugging-port/);
  });

  it('requires the durable credential directory instead of embedding a user path', () => {
    const restore = read('scripts/live/restore-all.sh');
    expect(restore).toContain('OC_LIVE_CREDS_DIR');
    expect(restore).toContain('OC_LIVE_OPENCHAT_FRONTEND');
    expect(restore).toContain('--creds-dir');
    expect(restore).toContain('--openchat-frontend');
    expect(restore).toContain('is required');
    expect(restore).not.toMatch(/\/[a-z]\/[^\s'"$]+\/oc-live/i);
    expect(restore).not.toMatch(/[A-Za-z]:\\Users\\[^'"\s]+/);
  });

  it('resolves live OpenChat dependencies only below an explicit frontend root', () => {
    const dependency = read('scripts/live/openChatFrontendDependency.ts');
    expect(dependency).toContain('OC_LIVE_OPENCHAT_FRONTEND');
    expect(dependency).toContain('--openchat-frontend');
    expect(dependency).toContain('isAbsolute');
    expect(dependency).toContain('isOutsideRoot');
    expect(dependency).toContain('resolveOpenChatViteFsModule');

    for (const relative of [
      'scripts/live/oc-restore.ts',
      'scripts/live/oc-provision.ts',
      'scripts/live/oc-provision-desktop.ts',
    ]) {
      const source = read(relative);
      expect(source, relative).toContain('loadOpenChatWebSocket');
      expect(source, relative).not.toMatch(/createRequire\(["'][A-Za-z]:[\\/]/);
    }

    for (const relative of [
      'scripts/live/emulator-transformers-all-webgpu.ts',
      'scripts/live/emulator-image-regression.ts',
    ]) {
      const source = read(relative);
      expect(source, relative).toContain('resolveOpenChatViteFsModule');
      expect(source, relative).not.toMatch(/\/@fs\/[A-Za-z]:\//);
    }
  });

  it('keeps the durable live-state root out of tracked harness sources', () => {
    for (const relative of [
      'scripts/live/heal-cdp.ts',
      'scripts/live/restore-all.sh',
      'scripts/live/openChatFrontendDependency.ts',
      'scripts/live/oc-restore.ts',
      'scripts/live/oc-provision.ts',
      'scripts/live/oc-provision-desktop.ts',
      'scripts/live/README.md',
      'src/security/cdpHarness.test.ts',
    ]) {
      const source = read(relative);
      expect(source, relative).not.toMatch(
        /[A-Za-z]:\\(?:[^'"\r\n]+\\)*oc-live(?:\\|['"])/i,
      );
      expect(source, relative).not.toMatch(
        /\/[a-z]\/[^\s'"$]*oc-live(?:\/|['"])/i,
      );
    }
  });

  it('keeps the tracked UI matrix on the centralized CDP ports', () => {
    const matrix = read('scripts/live/journey-matrix.sh');
    expect(matrix).toContain('cdp-ports.json');
    expect(matrix).toContain('${MANAGER_PORT}');
    expect(matrix).toContain('${MOTHER_PORT}');
    expect(matrix).not.toMatch(/(?:^|\D)(?:9241|9242)(?:\D|$)/);
  });

  it('keeps supported CDP entrypoints on the centralized current ports', () => {
    const desktopReload = read('scripts/live/oc-exe-reload.ts');
    const proposeGate = read('scripts/live/verify-nomodel-guide.ts');
    for (const source of [desktopReload, proposeGate]) {
      expect(source).toContain('CDP_PORTS');
      expect(source).not.toMatch(/127\.0\.0\.1:(?:9222|9241|9242)/);
    }
  });

  it('has no emitted JavaScript config that shadows vite.config.ts', () => {
    expect(existsSync(path.join(root, 'vite.config.js'))).toBe(false);
  });

  it('lets the credentialless opaque-origin card load its public module assets', () => {
    const vite = read('vite.config.ts');
    expect(vite).toMatch(
      /setHeader\(\x22Access-Control-Allow-Origin\x22,\s*\x22\*\x22\)/,
    );
    expect(vite).toMatch(/cors:\s*true/);

    const assetPolicy = read('public/.ic-assets.json5');
    const wildcardHeaders = assetPolicy.match(
      /\x22Access-Control-Allow-Origin\x22\s*:\s*\x22\*\x22/g,
    );
    // Both the generic assets and the later index.html override must carry ACAO.
    expect(wildcardHeaders).toHaveLength(2);
  });

  it('restarts ActionInbox polling when the authenticated actor becomes ready', () => {
    const sheetPage = read('src/features/entries/SheetPage.tsx');
    const start = sheetPage.indexOf('// "Pending from OpenChat"');
    const end = sheetPage.indexOf('const myPrincipal', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const pollingEffect = sheetPage.slice(start, end);
    expect(pollingEffect).toMatch(/\}, \[actor, principal, handledInboxIds\]\);/);
    expect(pollingEffect).toMatch(/cancelled = true/);
    expect(pollingEffect).toMatch(/clearInterval\(iv\)/);
    expect(pollingEffect).toMatch(/inboxAckQueueRef\.current/);
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
