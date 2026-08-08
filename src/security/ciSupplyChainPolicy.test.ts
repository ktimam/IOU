import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(
  path.resolve('.github/workflows/ci.yml'),
  'utf8',
);

describe('CI supply-chain policy', () => {
  it('pins every third-party GitHub Action to an immutable commit', () => {
    const actionRefs = [...workflow.matchAll(/uses:\s*([^\s#]+)/g)].map(
      ([, reference]) => reference,
    );

    expect(actionRefs.length).toBeGreaterThan(0);
    for (const reference of actionRefs) {
      expect(reference).toMatch(/^[^@\s]+@[0-9a-f]{40}$/);
    }
  });

  it('pins the cargo-audit release installed by CI', () => {
    expect(workflow).toMatch(
      /cargo install cargo-audit --locked --version \d+\.\d+\.\d+/,
    );
  });

  it('fails on new RustSec warnings and keeps the exception advisory-specific', () => {
    expect(workflow).toContain(
      'cargo audit --deny warnings --ignore RUSTSEC-2024-0436',
    );
    expect(workflow).not.toMatch(/cargo audit\s*(?:#.*)?$/m);
  });

  it('keeps the OpenChat card browser regressions in the required CI gate', () => {
    expect(workflow).toContain(
      'pnpm exec playwright install --with-deps chromium',
    );
    expect(workflow).toContain(
      'pnpm test:ui -- test/ui/openchatCard.ui.spec.ts',
    );
  });
});
