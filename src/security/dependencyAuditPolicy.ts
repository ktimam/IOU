export type AuditAdvisory = {
  github_advisory_id?: string;
  module_name?: string;
  title?: string;
};

export type AuditReport = {
  advisories?: Record<string, AuditAdvisory>;
};

export const RSC_ONLY_ADVISORY = 'GHSA-qwww-vcr4-c8h2';

const RSC_IMPORT =
  /(?:from\s+|import\s*\(\s*)['"](?:react-router\/rsc|react-server-dom(?:\/[^'"]*)?)['"]/;

/**
 * pnpm audit exits 0 for a clean report and 1 when it found advisories. Other
 * statuses, and JSON error envelopes which omit the advisory map, are command
 * failures rather than clean scans.
 */
export function assertValidAuditExecution(
  status: number | null,
  report: unknown,
): asserts report is AuditReport {
  if (status !== 0 && status !== 1) {
    throw new Error('pnpm audit failed with unexpected exit status: ' + String(status));
  }
  if (
    typeof report !== 'object' ||
    report === null ||
    Array.isArray(report) ||
    !Object.prototype.hasOwnProperty.call(report, 'advisories') ||
    typeof (report as AuditReport).advisories !== 'object' ||
    (report as AuditReport).advisories === null ||
    Array.isArray((report as AuditReport).advisories)
  ) {
    throw new Error('pnpm audit did not return a valid advisory report');
  }
}

export function usesReactServerComponents(runtimeSources: string[]): boolean {
  return runtimeSources.some((source) => RSC_IMPORT.test(source));
}

/**
 * Return advisories that still apply. The sole exception is an upstream
 * react-router advisory explicitly limited to unstable RSC APIs, which this
 * client-only BrowserRouter application does not import.
 */
export function applicableAdvisories(
  report: AuditReport,
  runtimeSources: string[],
): AuditAdvisory[] {
  const usesRsc = usesReactServerComponents(runtimeSources);
  return Object.values(report.advisories ?? {}).filter((advisory) => {
    const isExactRscOnlyAdvisory =
      advisory.github_advisory_id === RSC_ONLY_ADVISORY &&
      advisory.module_name === 'react-router' &&
      advisory.title ===
        'React Router: RSC Mode CSRF Bypass Allows Action Execution Before 400 Response';
    return !isExactRscOnlyAdvisory || usesRsc;
  });
}
