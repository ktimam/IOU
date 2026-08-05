import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applicableAdvisories,
  assertValidAuditExecution,
  RSC_ONLY_ADVISORY,
  usesReactServerComponents,
  type AuditReport,
} from './dependencyAuditPolicy';

const rscAdvisory = {
  github_advisory_id: RSC_ONLY_ADVISORY,
  module_name: 'react-router',
  title:
    'React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response',
};

describe('dependency audit policy', () => {
  it('keeps Hono on the patched side of GHSA-8j4g-w8fx-2239', () => {
    const workspace = readFileSync(
      new URL('../../pnpm-workspace.yaml', import.meta.url),
      'utf8',
    );
    const lockfile = readFileSync(
      new URL('../../pnpm-lock.yaml', import.meta.url),
      'utf8',
    );

    expect(workspace).toMatch(/^overrides:\r?\n\s+hono:\s+4\.12\.34\s*$/m);
    expect(lockfile).toContain('hono@4.12.34:');
    expect(lockfile).not.toMatch(/hono@4\.12\.(?:[0-9]|[12][0-9]|3[0-3]):/);
  });

  it('rejects a command failure disguised as JSON with no advisory map', () => {
    expect(() =>
      assertValidAuditExecution(1, { error: { message: 'registry unavailable' } }),
    ).toThrow(/valid advisory report/i);
  });

  it('accepts the two documented audit exit shapes only when advisories are present', () => {
    expect(() => assertValidAuditExecution(0, { advisories: {} })).not.toThrow();
    expect(() =>
      assertValidAuditExecution(1, { advisories: { one: rscAdvisory } }),
    ).not.toThrow();
    expect(() => assertValidAuditExecution(null, { advisories: {} })).toThrow(/exit status/i);
    expect(() => assertValidAuditExecution(2, { advisories: {} })).toThrow(/exit status/i);
  });

  it('recognizes actual React Server Component imports', () => {
    expect(
      usesReactServerComponents([
        `import { routeRSCServerRequest } from 'react-router/rsc'`,
      ]),
    ).toBe(true);
    expect(
      usesReactServerComponents([
        `import { BrowserRouter } from 'react-router-dom'`,
      ]),
    ).toBe(false);
  });

  it('accepts only the exact RSC-only advisory when RSC is unused', () => {
    const report: AuditReport = { advisories: { one: rscAdvisory } };
    expect(applicableAdvisories(report, [])).toEqual([]);
  });

  it('makes the RSC advisory applicable as soon as an RSC API is imported', () => {
    const report: AuditReport = { advisories: { one: rscAdvisory } };
    expect(
      applicableAdvisories(report, [
        `const rsc = import('react-router/rsc')`,
      ]),
    ).toEqual([rscAdvisory]);
  });

  it('fails closed for new, renamed, or package-mismatched advisories', () => {
    const report: AuditReport = {
      advisories: {
        newFinding: {
          github_advisory_id: 'GHSA-new-finding',
          module_name: 'example',
          title: 'New issue',
        },
        spoofed: {
          ...rscAdvisory,
          module_name: 'different-package',
        },
      },
    };
    expect(applicableAdvisories(report, [])).toHaveLength(2);
  });
});
