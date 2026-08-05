import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  applicableAdvisories,
  assertValidAuditExecution,
  RSC_ONLY_ADVISORY,
  type AuditReport,
} from '../src/security/dependencyAuditPolicy';

function runtimeSources(directory: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'security') sources.push(...runtimeSources(target));
    } else if (
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !entry.name.includes('.test.')
    ) {
      sources.push(readFileSync(target, 'utf8'));
    }
  }
  return sources;
}

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error('audit:deps must be run through pnpm');
}

const audit = spawnSync(process.execPath, [pnpmCli, 'audit', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (audit.error) throw audit.error;

let parsed: unknown;
try {
  parsed = JSON.parse(audit.stdout) as unknown;
} catch {
  process.stderr.write(audit.stderr);
  throw new Error('pnpm audit did not return valid JSON');
}
assertValidAuditExecution(audit.status, parsed);
const report: AuditReport = parsed;

const applicable = applicableAdvisories(
  report,
  runtimeSources(path.resolve('src')),
);
if (applicable.length > 0) {
  for (const advisory of applicable) {
    console.error(
      `${advisory.github_advisory_id ?? 'unknown'} ` +
        `${advisory.module_name ?? 'unknown'}: ${advisory.title ?? 'untitled'}`,
    );
  }
  process.exitCode = 1;
} else {
  const count = Object.keys(report.advisories ?? {}).length;
  if (count === 1) {
    console.log(
      `PASS: ${RSC_ONLY_ADVISORY} is RSC-only and no RSC import exists`,
    );
  } else {
    console.log('PASS: no applicable pnpm advisories');
  }
}
